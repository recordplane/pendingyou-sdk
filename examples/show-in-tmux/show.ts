// Show in tmux: when the person presses Show on a card in Pending You, bring the agent that asked to the front in tmux,
// on this computer. https://www.pendingyou.com/docs/api#show-me
//
//   node show.ts login   sign in as your app on this computer, with a code, for assistants:show alone
//   node show.ts         follow the presses until Ctrl-C
//
// A show names the card, the agent that asked and its places, newest first. A tmux place is `{ app: "tmux", paneId:
// "%12", server }`, where `server` is the first 16 hex characters of a SHA-256 of the computer's name and tmux's socket
// path, as the `pendingyou` command line sent it with the agent's presence. So it keeps the places on its own tmux
// server, checks the pane is there, and only then moves: `switch-client` when the pane is in another session than the
// one you're on, then `select-window` and `select-pane`. Nothing else, ever: it never types into a pane, runs or opens
// anything for a show. tmux runs with an argument list, never through a shell, and a pane id reaches it only once it
// reads as tmux's own (`%` and digits).
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createClient, deviceSignIn, type Show, SignedOutError } from '@recordplane/pendingyou-sdk'
import { cliAttester, fileStore } from '@recordplane/pendingyou-sdk/node'

const ORIGIN = 'https://www.pendingyou.com'
/** Your app's client ID, from Settings › Developers in Pending You. */
const CLIENT_ID = process.env.PENDINGYOU_CLIENT_ID ?? 'YOUR-CLIENT-ID'
/** This example's own sign-in, readable only by you. */
const store = fileStore(join(homedir(), '.config', 'pendingyou-example', 'show-in-tmux.json'))
/** A pane's id as tmux gives one. */
const PANE = /^%[0-9]{1,9}$/
const run = promisify(execFile)

/** What tmux prints for one command, or null when it fails (no server, no such pane). */
async function tmux(...args: string[]): Promise<string | null> {
  try {
    return (await run('tmux', args, { timeout: 2000 })).stdout.trim()
  } catch {
    return null
  }
}

/** This tmux server as Pending You names it: its socket's path and this computer's name, hashed. */
async function thisServer(): Promise<string | null> {
  const socket = await tmux('display-message', '-p', '#{socket_path}')
  return socket
    ? createHash('sha256').update(`${hostname()}${socket}`).digest('hex').slice(0, 16)
    : null
}

/** A pane tmux has now, as tmux itself names it: all a show can bring forward. */
interface Pane {
  paneId: string
  session: string
}

/** The first of the show's places that tmux says is a pane here now; null when none is (nothing moves). */
async function find(show: Show): Promise<Pane | null> {
  for (const place of show.places) {
    if (!PANE.test(place.paneId)) continue
    const found = await tmux(
      'display-message',
      '-p',
      '-t',
      place.paneId,
      '#{pane_id} #{session_id}',
    )
    const [paneId, session] = found?.split(' ') ?? []
    if (paneId === place.paneId && session) return { paneId, session }
  }
  return null
}

/** Brings the pane to the front: over to its session when you're on another, then its window, then the pane. */
async function focus(pane: Pane): Promise<void> {
  if ((await tmux('display-message', '-p', '#{session_id}')) !== pane.session)
    await tmux('switch-client', '-t', pane.paneId)
  await tmux('select-window', '-t', pane.paneId)
  await tmux('select-pane', '-t', pane.paneId)
}

async function login(): Promise<void> {
  if (CLIENT_ID === 'YOUR-CLIENT-ID')
    throw new Error('Register your app first: Settings › Developers.')
  const signIn = await deviceSignIn({
    origin: ORIGIN,
    clientId: CLIENT_ID,
    scopes: ['assistants:show'],
    machine: hostname(),
    attest: cliAttester(),
    store,
  })
  console.log(`Allow it at ${signIn.verificationUriComplete}`)
  await signIn.signedIn
  console.log('Signed in.')
}

async function follow(): Promise<void> {
  const server = await thisServer()
  if (!server) throw new Error('No tmux server here: start tmux first.')
  const stop = new AbortController()
  process.once('SIGINT', () => stop.abort())
  console.log('Waiting for Show on your cards. Ctrl-C stops.')
  // Each show is answered for it: `shown` once focus ran, `not_found` when find found nothing.
  await createClient({ store }).followShows<Pane>({
    places: ['tmux'],
    mine: (place) => place.server === server,
    find,
    focus,
    signal: stop.signal,
  })
}

try {
  await (process.argv[2] === 'login' ? login() : follow())
} catch (error) {
  if (!(error instanceof Error)) throw error
  // Not signed in; refused (a sign-in without this computer: no_machine); or no tmux here.
  console.error(
    error instanceof SignedOutError ? 'Not signed in: node show.ts login' : error.message,
  )
  process.exitCode = 1
}
