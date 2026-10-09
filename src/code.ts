// Signing a web or desktop app in by authorization code with PKCE (RFC 6749, RFC 7636, RFC 8252; docs/plans/
// 2026-10-05-person-api.md §3.4): the person allows it in their browser, and it comes back to the app's registered
// address with a code.
//
//   1. A new key for the app's grant (DPoP: its tokens will be useless without it), a PKCE verifier and a `state`, made
//      here. The key's thumbprint goes in the request as `dpop_jkt` (RFC 9449 §10), so the code is bound to it too.
//   2. `url`: where to send the person. They sign in to Pending You if they aren't, see the app's card and allow it.
//   3. `finish(callback)` with the address the browser came back to: its `state` checked, its code exchanged with the
//      verifier and a proof by the key (with the nonce Pending You asks for), and the credentials saved to the store.
//
// The app must ask for `cards:read` and `cards:read:all`: an app signed in this way has no computer, so it reaches every
// card. A desktop app listens on a loopback address (`loopbackSignIn` in ./node.ts, RFC 8252 §7.3, any port of its
// registered `http://127.0.0.1/…`); a single-page app is sent away and back (`redirectToSignIn`, then
// `finishRedirectSignIn` on the page it comes back to). A website with a server and a client secret uses its own OAuth
// library; it may skip DPoP and take bearer tokens.
import { generateKey, importKey, type PrivateJwk, sha256 } from './dpop.ts'
import { SignInError } from './errors.ts'
import { nonces, tokenRequest } from './oauth.ts'
import type { Credentials, Store } from './store.ts'

export const AUTHORIZE_PATH = '/oauth/authorize'

export interface CodeSignInOptions {
  /** Pending You's address: `https://www.pendingyou.com`. */
  origin: string
  /** The app's client id. */
  clientId: string
  /** One of the app's registered redirect addresses (a loopback one may name any port). */
  redirectUri: string
  /** What to ask for: `cards:read` and `cards:read:all` at least, within what the app is registered for. */
  scopes: readonly string[]
  /** Where the credentials go once it's finished. */
  store?: Store
  fetch?: typeof fetch
  now?: () => number
}

/** A sign-in started and not finished yet: everything `finish` needs, to keep while the person is away. */
export interface PendingCodeSignIn {
  version: 1
  origin: string
  clientId: string
  redirectUri: string
  scopes: string[]
  /** The value that must come back unchanged. */
  state: string
  /** PKCE's secret half. */
  verifier: string
  /** The key the grant will be bound to. */
  key: PrivateJwk
}

export interface CodeSignIn {
  /** Where to send the person. */
  url: string
  /** What this sign-in keeps until it's finished (for an app that's sent away and back: `resumeCodeSignIn`). */
  pending: PendingCodeSignIn
  /** Finishes with the address the browser came back to: the credentials, or a SignInError. */
  finish(callback: string | URL): Promise<Credentials>
}

const random = (bytes: number) => {
  let binary = ''
  for (const byte of crypto.getRandomValues(new Uint8Array(bytes)))
    binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/** Starts a sign-in by code: a new key, a PKCE pair and a state, and the address to send the person to. */
export async function codeSignIn(options: CodeSignInOptions): Promise<CodeSignIn> {
  const { jwk } = await generateKey()
  const pending: PendingCodeSignIn = {
    version: 1,
    origin: options.origin.replace(/\/+$/, ''),
    clientId: options.clientId,
    redirectUri: options.redirectUri,
    scopes: [...options.scopes],
    state: random(16),
    verifier: random(32),
    key: jwk,
  }
  return resumeCodeSignIn(pending, options)
}

/** A sign-in started earlier (on the page before the person was sent away), ready to finish. */
export async function resumeCodeSignIn(
  pending: PendingCodeSignIn,
  options: Pick<CodeSignInOptions, 'store' | 'fetch' | 'now'> = {},
): Promise<CodeSignIn> {
  const http = {
    fetch: options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)),
    now: options.now ?? (() => Date.now()),
  }
  const key = await importKey(pending.key)
  const url = new URL(`${pending.origin}${AUTHORIZE_PATH}`)
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: pending.clientId,
    redirect_uri: pending.redirectUri,
    scope: pending.scopes.join(' '),
    state: pending.state,
    code_challenge: await sha256(pending.verifier),
    code_challenge_method: 'S256',
    resource: `${pending.origin}/v1`,
    dpop_jkt: key.jkt,
  }).toString()
  let finished = false

  async function finish(callback: string | URL): Promise<Credentials> {
    if (finished) throw new SignInError('finished', 'This sign-in is finished already.')
    const back = new URL(String(callback))
    // Only the answer to this sign-in: anything else (a page someone else opened) is refused before it's used.
    if (back.searchParams.get('state') !== pending.state)
      throw new SignInError('state_mismatch', 'This isn’t the answer to this sign-in.')
    const iss = back.searchParams.get('iss')
    if (iss !== null && iss !== pending.origin)
      throw new SignInError('issuer_mismatch', 'This answer came from somewhere else.')
    const error = back.searchParams.get('error')
    if (error)
      throw new SignInError(
        error,
        error === 'access_denied'
          ? 'The person didn’t allow it.'
          : `Pending You refused the sign-in (${error}).`,
      )
    const code = back.searchParams.get('code')
    if (!code) throw new SignInError('no_code', 'The answer had no code.')
    finished = true
    const result = await tokenRequest(
      http,
      pending.origin,
      key,
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: pending.redirectUri,
        client_id: pending.clientId,
        code_verifier: pending.verifier,
        resource: `${pending.origin}/v1`,
      },
      nonces(),
    )
    if (!result.ok)
      throw new SignInError(
        result.error,
        `Pending You didn’t finish the sign-in (${result.error}). Start it again.`,
      )
    const credentials: Credentials = {
      version: 1,
      origin: pending.origin,
      clientId: pending.clientId,
      accessToken: result.tokens.access_token,
      refreshToken: result.tokens.refresh_token,
      expiresAt: http.now() + result.tokens.expires_in * 1000,
      scopes: result.tokens.scope ? result.tokens.scope.split(' ') : [...pending.scopes],
      key: pending.key,
    }
    const store = options.store
    if (store) await store.exclusive(() => store.save(credentials))
    return credentials
  }

  return { url: url.toString(), pending, finish }
}

/** Whether a value kept by `redirectToSignIn` is a sign-in this SDK started. */
export function isPendingCodeSignIn(value: unknown): value is PendingCodeSignIn {
  const entry = value as Partial<PendingCodeSignIn> | null
  return (
    typeof entry === 'object' &&
    entry !== null &&
    entry.version === 1 &&
    typeof entry.origin === 'string' &&
    typeof entry.clientId === 'string' &&
    typeof entry.redirectUri === 'string' &&
    Array.isArray(entry.scopes) &&
    typeof entry.state === 'string' &&
    typeof entry.verifier === 'string' &&
    typeof entry.key === 'object' &&
    entry.key !== null
  )
}

/* ───────────────────────── A single-page app: away and back ───────────────────────── */

/** Where a page keeps a sign-in while the person is away: sessionStorage, or anything like it. */
export interface PendingStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** The key a started sign-in is kept under. */
export const PENDING_KEY = 'pendingyou.signin'

const sessionStorageHere = (): PendingStorage | undefined =>
  (globalThis as { sessionStorage?: PendingStorage }).sessionStorage

/**
 * A single-page app's sign-in, first half: starts it, keeps what finishing needs in `storage` (this tab's
 * sessionStorage unless given), and sends the page to Pending You (`go`, the page's location unless given). Its
 * registered redirect address is the page that calls finishRedirectSignIn.
 */
export async function redirectToSignIn(
  options: CodeSignInOptions & {
    storage?: PendingStorage
    go?: (url: string) => void
  },
): Promise<void> {
  const storage = options.storage ?? sessionStorageHere()
  if (!storage) throw new TypeError('No sessionStorage here: pass `storage`')
  const started = await codeSignIn(options)
  storage.setItem(PENDING_KEY, JSON.stringify(started.pending))
  const go =
    options.go ??
    ((url: string) => {
      const here = (globalThis as { location?: { assign(url: string): void } }).location
      if (!here) throw new TypeError('No location here: pass `go`')
      here.assign(url)
    })
  go(started.url)
}

/**
 * A single-page app's sign-in, second half, on the page it came back to: the sign-in kept by redirectToSignIn, finished
 * with this page's address (`url`, the page's own unless given) and taken out of `storage` whatever comes of it.
 */
export async function finishRedirectSignIn(
  options: Pick<CodeSignInOptions, 'store' | 'fetch' | 'now'> & {
    storage?: PendingStorage
    url?: string
  } = {},
): Promise<Credentials> {
  const storage = options.storage ?? sessionStorageHere()
  if (!storage) throw new TypeError('No sessionStorage here: pass `storage`')
  const kept = storage.getItem(PENDING_KEY)
  storage.removeItem(PENDING_KEY)
  let pending: unknown = null
  try {
    pending = kept ? JSON.parse(kept) : null
  } catch {}
  if (!isPendingCodeSignIn(pending))
    throw new SignInError('not_started', 'No sign-in was started in this tab.')
  const url =
    options.url ?? (globalThis as { location?: { href: string } }).location?.href ?? undefined
  if (!url) throw new TypeError('No location here: pass `url`')
  const started = await resumeCodeSignIn(pending, options)
  return started.finish(url)
}
