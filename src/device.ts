// Signing an app in by device code (RFC 8628; docs/plans/2026-10-05-person-api.md §3.3, §4.2, §4.3): for terminals and
// plugins, where the person allows it on their phone or another browser.
//
//   1. A new key for the app's grant (DPoP: its tokens will be useless without it), made here, kept in the store.
//   2. The computer vouches for the sign-in: `attest` asks this computer's key (the command line's,
//      `pendingyou machine attest`, through cliAttester in ./node.ts) for an attestation naming the app, the computer and
//      the new key's thumbprint. A computer Pending You doesn't know as the person's is refused on their side.
//   3. POST /oauth/device: the code to show (`userCode`), and where to allow it (`verificationUriComplete`).
//   4. `signedIn` polls the token endpoint every `interval` seconds, each poll proven by the new key (with the nonce it
//      asks for), until the person allows it (the credentials, saved to the store when one is given), denies it or the
//      code runs out (a SignInError).
import { generateKey, type PrivateJwk } from './dpop.ts'
import { SignInError } from './errors.ts'
import { DEVICE_GRANT, DEVICE_PATH, nonces, tokenRequest } from './oauth.ts'
import type { Credentials, Store } from './store.ts'

/** What the computer is asked to vouch for. */
export interface AttestationRequest {
  /** Pending You's address. */
  origin: string
  /** Who it's for: `<origin>/oauth/device`. */
  audience: string
  /** The app, as the sign-in names it: Pending You's own by slug, any other by its client. */
  app?: string
  clientId?: string
  /** The thumbprint of the grant's key (`cnf.jkt`). */
  jkt: string
  /** The computer's name, when the app gives one. */
  machine?: string
}

/** Makes the attestation: a compact JWS signed by this computer's key. */
export type Attester = (request: AttestationRequest) => Promise<string>

export interface DeviceSignInOptions {
  /** Pending You's address: `https://www.pendingyou.com`. */
  origin: string
  /** Pending You's own app, by its slug (`herdr`)… */
  app?: string
  /** …or a registered app, by its client id. */
  clientId?: string
  /** What to ask for (the person may allow less: `cards:read:all` is a tick, off by default). */
  scopes: readonly string[]
  attest: Attester
  /** The computer's name, as the person knows it ("build-01"): a label, never its identity. */
  machine?: string
  /** Where the credentials go once allowed. */
  store?: Store
  fetch?: typeof fetch
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Stops polling: `signedIn` rejects with SignInError `aborted`. */
  signal?: AbortSignal
}

export interface DeviceSignIn {
  /** The code to show the person ("WDJB-MJHT"). */
  userCode: string
  /** Where they allow it, and the same with the code filled in (for a link or a QR code). */
  verificationUri: string
  verificationUriComplete: string
  /** When the code runs out, in milliseconds. */
  expiresAt: number
  /** The app's client, as Pending You gave it: what it refreshes with. */
  clientId: string
  /** The credentials once the person allows it; a SignInError if they deny it or the code runs out. */
  signedIn: Promise<Credentials>
}

interface DeviceAnswer {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  expires_in: number
  interval: number
  client_id?: string
}

export async function deviceSignIn(options: DeviceSignInOptions): Promise<DeviceSignIn> {
  if ((options.app === undefined) === (options.clientId === undefined))
    throw new TypeError('Name the app once: `app` (Pending You’s own) or `clientId`')
  const http = {
    fetch: options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)),
    now: options.now ?? (() => Date.now()),
  }
  const sleep =
    options.sleep ??
    ((ms: number, signal?: AbortSignal) =>
      new Promise<void>((done) => {
        const timer = setTimeout(done, ms)
        signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          done()
        })
      }))
  const origin = options.origin.replace(/\/+$/, '')
  const { key, jwk } = await generateKey()
  const attestation = await options.attest({
    origin,
    audience: `${origin}${DEVICE_PATH}`,
    ...(options.app !== undefined ? { app: options.app } : {}),
    ...(options.clientId !== undefined ? { clientId: options.clientId } : {}),
    jkt: key.jkt,
    ...(options.machine ? { machine: options.machine } : {}),
  })
  const response = await http.fetch(`${origin}${DEVICE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      ...(options.app !== undefined ? { app: options.app } : {}),
      ...(options.clientId !== undefined ? { client_id: options.clientId } : {}),
      scope: options.scopes.join(' '),
      resource: `${origin}/v1`,
      ...(options.machine ? { machine: options.machine } : {}),
      machine_attestation: attestation,
    }).toString(),
  })
  const body = (await response.json().catch(() => null)) as Partial<DeviceAnswer> & {
    error?: string
  }
  if (!response.ok || typeof body?.device_code !== 'string')
    throw new SignInError(
      body?.error ?? `status_${response.status}`,
      `Pending You didn’t start the sign-in (${body?.error ?? response.status}).`,
    )
  const answer = body as DeviceAnswer
  const clientId = answer.client_id ?? options.clientId ?? ''
  const expiresAt = http.now() + answer.expires_in * 1000
  return {
    userCode: answer.user_code,
    verificationUri: answer.verification_uri,
    verificationUriComplete: answer.verification_uri_complete,
    expiresAt,
    clientId,
    signedIn: poll(),
  }

  async function poll(): Promise<Credentials> {
    const held = nonces()
    let interval = Math.max(1, answer.interval) * 1000
    for (;;) {
      if (options.signal?.aborted) throw new SignInError('aborted', 'The sign-in was stopped.')
      if (http.now() >= expiresAt) throw new SignInError('expired_token', 'The code ran out.')
      await sleep(interval, options.signal)
      if (options.signal?.aborted) throw new SignInError('aborted', 'The sign-in was stopped.')
      const result = await tokenRequest(
        http,
        origin,
        key,
        { grant_type: DEVICE_GRANT, device_code: answer.device_code, client_id: clientId },
        held,
      )
      if (result.ok) return finish(jwk, result.tokens)
      if (result.error === 'authorization_pending') continue
      if (result.error === 'slow_down') {
        interval += 5000
        continue
      }
      throw new SignInError(
        result.error,
        result.error === 'access_denied'
          ? 'The person didn’t allow it.'
          : result.error === 'expired_token'
            ? 'The code ran out.'
            : `Pending You refused the sign-in (${result.error}).`,
      )
    }
  }

  async function finish(
    privateJwk: PrivateJwk,
    tokens: { access_token: string; refresh_token: string; expires_in: number; scope?: string },
  ): Promise<Credentials> {
    const credentials: Credentials = {
      version: 1,
      origin,
      clientId,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: http.now() + tokens.expires_in * 1000,
      scopes: tokens.scope ? tokens.scope.split(' ') : [...options.scopes],
      key: privateJwk,
    }
    const store = options.store
    if (store) await store.exclusive(() => store.save(credentials))
    return credentials
  }
}
