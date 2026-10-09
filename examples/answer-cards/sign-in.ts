// Signing in as your app: https://www.pendingyou.com/docs/api#sign-in (a code, for terminals) and #sign-in-code (the
// person's browser, for desktop apps). The SDK makes the sign-in's key and binds the tokens to it (DPoP), so a copy of
// the sign-in file is useless anywhere else; it keeps both in one file, readable only by you.
import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { deviceSignIn, type Store, signOut } from '@recordplane/pendingyou-sdk'
import { cliAttester, fileStore, loopbackSignIn } from '@recordplane/pendingyou-sdk/node'

export const ORIGIN = 'https://www.pendingyou.com'

/** Your app's client ID, from Settings › Developers in Pending You. */
export const CLIENT_ID = process.env.PENDINGYOU_CLIENT_ID ?? 'YOUR-CLIENT-ID'

/** Where the sign-in is kept. The other examples read it from here too. */
export const SIGN_IN_FILE = join(homedir(), '.config', 'pendingyou-example', 'sign-in.json')

export const store: Store = fileStore(SIGN_IN_FILE)

/**
 * What the examples do, and no more: read cards, answer them, put them in Later, see which assistants are running and
 * keep the person's phone quiet while they're here. Ask only for what your app does: the person sees each one.
 */
export const SCOPES = [
  'cards:read',
  'cards:answer',
  'cards:later',
  'assistants:read',
  'presence:desk',
] as const

function needsClientId(): void {
  if (CLIENT_ID !== 'YOUR-CLIENT-ID') return
  console.error(
    'Register your app first (Pending You › Settings › Developers), then: PENDINGYOU_CLIENT_ID=<its client ID> node index.ts login',
  )
  process.exit(1)
}

/**
 * A terminal's sign-in (RFC 8628): a code the person allows on their phone or at a link. This computer vouches for it
 * with its own key (`pendingyou machine attest`, set up by `npx pendingyou init`), so the sign-in sees this computer's
 * assistants' cards, unless the person ticks "every card".
 */
export async function signInWithCode(): Promise<void> {
  needsClientId()
  const signIn = await deviceSignIn({
    origin: ORIGIN,
    clientId: CLIENT_ID,
    scopes: SCOPES,
    machine: hostname(),
    attest: cliAttester(),
    store,
  })
  console.log(`Allow it at ${signIn.verificationUriComplete}`)
  console.log(`(or at ${signIn.verificationUri} with the code ${signIn.userCode})`)
  await signIn.signedIn
  console.log('Signed in.')
}

/**
 * A desktop app's sign-in (RFC 8252): authorization code with PKCE, in the person's browser, back to this computer at
 * a port of its own on the app's registered `http://127.0.0.1/callback`. An app signed in this way has no computer of
 * its own, so it asks for every card (`cards:read:all`).
 */
export async function signInWithBrowser(): Promise<void> {
  needsClientId()
  const signIn = await loopbackSignIn({
    origin: ORIGIN,
    clientId: CLIENT_ID,
    scopes: [...SCOPES, 'cards:read:all'],
    store,
    open: openInBrowser,
  })
  console.log(`Allow it in your browser. If it didn’t open: ${signIn.url}`)
  await signIn.signedIn
  console.log('Signed in.')
}

/** Ends the sign-in at Pending You (its refresh token revoked), then removes it here whatever Pending You said. */
export async function signOutHere(): Promise<void> {
  const ended = await signOut({ store })
  await rm(SIGN_IN_FILE, { force: true })
  console.log(
    ended === 'signed-out'
      ? 'Signed out.'
      : ended === 'none'
        ? 'Not signed in.'
        : 'Pending You couldn’t be reached: the sign-in ends by itself in 30 days.',
  )
}

function openInBrowser(url: string): void {
  const [command, ...args] =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '', url]
        : ['xdg-open', url]
  if (!command) return
  const child = spawn(command, args, { stdio: 'ignore', detached: true })
  child.on('error', () => {})
  child.unref()
}
