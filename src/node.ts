// Node only (`@recordplane/pendingyou-sdk/node`): a sign-in kept in a file, and the computer's attestation from the command line.
//
// fileStore(path) keeps one sign-in as the command line keeps its own (packages/cli's credentials.json): JSON written
// whole (a temporary file, then a rename), readable only by you (0600, in a folder made 0700), a file someone loosened
// tightened again on the next read, and one writer at a time through a lock folder beside it (`<path>.lock`, taken
// over once it's 30 seconds old, left by a process that died). A refresh runs inside that lock, so two processes using
// one file never spend its refresh token twice.
//
// cliAttester() asks this computer's key for an attestation through `pendingyou machine attest` (CLI 0.18.0 or later,
// after `npx pendingyou init` made the key): for an app registered by its client id.
//
// loopbackSignIn() signs a desktop app in by code with PKCE (RFC 8252): it listens on 127.0.0.1 at a port of its own,
// opens the sign-in in the person's browser, and finishes it when the browser comes back there.
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { type CodeSignInOptions, codeSignIn } from './code.ts'
import type { AttestationRequest, Attester } from './device.ts'
import { SignInError } from './errors.ts'
import { type Credentials, isCredentials, type Store } from './store.ts'

/** A lock older than this was left by a process that died: taken over. */
export const STALE_LOCK_MS = 30_000
/** How long a writer waits for the lock before giving up. */
export const LOCK_WAIT_MS = 15_000

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Writes `text` whole: a private temporary file in a private folder, then renamed over `path`. */
async function writeWhole(path: string, text: string): Promise<void> {
  const folder = dirname(path)
  await mkdir(folder, { recursive: true, mode: 0o700 })
  await chmod(folder, 0o700)
  const temporary = join(folder, `.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: 'wx' })
    await chmod(temporary, 0o600)
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

/** Runs `work` holding `<path>.lock`, as the command line's withLock does. */
export async function withFileLock<T>(
  path: string,
  work: () => Promise<T>,
  clock: { now: () => number; sleep: (ms: number) => Promise<void> } = {
    now: () => Date.now(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  },
): Promise<T> {
  const lock = `${path}.lock`
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 })
  const started = clock.now()
  for (;;) {
    try {
      await mkdir(lock)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const age = await stat(lock).then(
        (info) => Date.now() - info.mtimeMs,
        () => 0,
      )
      if (age > STALE_LOCK_MS) {
        await rm(lock, { recursive: true, force: true })
        continue
      }
      if (clock.now() - started > LOCK_WAIT_MS)
        throw new Error(`Another process holds ${lock}. Try again.`)
      await clock.sleep(25 + Math.floor(Math.random() * 50))
    }
  }
  try {
    return await work()
  } finally {
    await rm(lock, { recursive: true, force: true })
  }
}

/** A sign-in kept at `path`: 0600, written whole, locked for each write and each refresh. */
export function fileStore(path: string): Store {
  return {
    async load(): Promise<Credentials | null> {
      const text = await readText(path)
      if (text === null) return null
      let value: unknown
      try {
        value = JSON.parse(text)
      } catch {
        throw new Error(`${path} isn’t a Pending You sign-in. Sign in again to replace it.`)
      }
      if (!isCredentials(value))
        throw new Error(`${path} isn’t a Pending You sign-in. Sign in again to replace it.`)
      // Readable only by you, however it was left.
      if ((await stat(path)).mode & 0o077) await chmod(path, 0o600)
      return value
    },
    async save(credentials) {
      await writeWhole(path, `${JSON.stringify(credentials, null, 2)}\n`)
    },
    exclusive: (work) => withFileLock(path, work),
  }
}

/* ───────────────────────── A desktop app's sign-in by code ───────────────────────── */

export interface LoopbackSignInOptions extends Omit<CodeSignInOptions, 'redirectUri'> {
  /**
   * The app's registered loopback address, `http://127.0.0.1/callback` by default: its path is listened on, at a port
   * chosen now (RFC 8252 §7.3: Pending You takes any port of a registered loopback address), or `port` when given.
   */
  redirectUri?: string
  port?: number
  /** Opens the sign-in in the person's browser; without it, show `url` yourself. */
  open?: (url: string) => void | Promise<void>
  /** How long to wait for the browser to come back: 10 minutes, as long as a consent page lives. */
  timeoutMs?: number
  signal?: AbortSignal
}

export interface LoopbackSignIn {
  /** Where the person allows it: open it in their browser. */
  url: string
  /** The address the browser comes back to, with its port. */
  redirectUri: string
  /** The credentials once the browser came back with a code; a SignInError if it came back without, or never did. */
  signedIn: Promise<Credentials>
  /** Stops listening. */
  close(): void
}

/** What the browser tab says once it's back. Plain words; nothing from the request is echoed. */
const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px"><h1 style="font-weight:500">${title}</h1><p>${body}</p></body>`

/**
 * A desktop app's sign-in by code (RFC 8252): listens on 127.0.0.1 for the browser to come back, starts the sign-in for
 * that address, and opens it (`open`). The first request to the address's path finishes it; the listener closes then,
 * or when it times out or is aborted.
 */
export async function loopbackSignIn(options: LoopbackSignInOptions): Promise<LoopbackSignIn> {
  const registered = new URL(options.redirectUri ?? 'http://127.0.0.1/callback')
  if (
    registered.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]', 'localhost'].includes(registered.hostname)
  )
    throw new TypeError('A loopback sign-in comes back to http://127.0.0.1')
  const server = createServer()
  await new Promise<void>((done, fail) => {
    server.once('error', fail)
    server.listen(options.port ?? 0, registered.hostname === '[::1]' ? '::1' : '127.0.0.1', () =>
      done(),
    )
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const back = new URL(registered.toString())
  back.port = String(port)
  const redirectUri = back.toString()
  const started = await codeSignIn({ ...options, redirectUri })
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  // Every answer says Connection: close, so once it stops listening nothing is left open behind it.
  const close = () => {
    if (closed) return
    closed = true
    if (timer) clearTimeout(timer)
    server.close()
  }
  const html = { 'content-type': 'text/html; charset=utf-8', connection: 'close' }
  const signedIn = new Promise<Credentials>((resolve, reject) => {
    const stop = (error: SignInError) => {
      close()
      reject(error)
    }
    timer = setTimeout(
      () => stop(new SignInError('expired_token', 'The browser didn’t come back in time.')),
      options.timeoutMs ?? 10 * 60_000,
    )
    options.signal?.addEventListener('abort', () =>
      stop(new SignInError('aborted', 'The sign-in was stopped.')),
    )
    // The first time the browser comes back is the answer; a reload after it changes nothing.
    let taken = false
    server.on('request', (request, response) => {
      const url = new URL(request.url ?? '/', redirectUri)
      if (request.method !== 'GET' || url.pathname !== back.pathname) {
        response
          .writeHead(404, { 'content-type': 'text/plain', connection: 'close' })
          .end('Not found')
        return
      }
      if (taken) {
        response
          .writeHead(409, html)
          .end(page('Already answered', 'Close this tab and go back to the app.'))
        return
      }
      taken = true
      started.finish(url).then(
        (credentials) => {
          response
            .writeHead(200, html)
            .end(page('You’re signed in', 'Close this tab and go back to the app.'))
          close()
          resolve(credentials)
        },
        (error: unknown) => {
          response
            .writeHead(400, html)
            .end(page('Not signed in', 'Go back to the app and start signing in again.'))
          close()
          reject(error)
        },
      )
    })
  })
  // Never an unhandled rejection: the caller reads `signedIn` when it wants.
  signedIn.catch(() => {})
  if (options.open) await options.open(started.url)
  return { url: started.url, redirectUri, signedIn, close }
}

/** Runs a command and gives its standard output; what it says on standard error goes in the error. */
export type Run = (command: string, args: string[]) => Promise<string>

const runFile: Run = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 60_000, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message))
      else resolve(stdout)
    })
  })

/**
 * The computer's attestation from the command line: `pendingyou machine attest --origin … --client-id … --cnf …`, run as
 * `command` (`npx -y pendingyou@latest` by default; the hooks' copy `npx pendingyou init` installed works too). It
 * attests apps registered by their client id; Pending You's own apps (named by slug) sign in through the command line's
 * own `pendingyou app login`.
 */
export function cliAttester(options: { command?: readonly string[]; run?: Run } = {}): Attester {
  const [program = 'npx', ...base] = options.command ?? ['npx', '-y', 'pendingyou@latest']
  const run = options.run ?? runFile
  return async (request: AttestationRequest) => {
    if (!request.clientId)
      throw new Error(
        'pendingyou machine attest vouches for an app by its client id; Pending You’s own apps sign in with pendingyou app login.',
      )
    const out = await run(program, [
      ...base,
      'machine',
      'attest',
      '--origin',
      request.origin,
      '--client-id',
      request.clientId,
      '--cnf',
      request.jkt,
      ...(request.machine ? ['--name', request.machine] : []),
    ])
    const attestation = out.trim()
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(attestation))
      throw new Error('pendingyou machine attest gave no attestation.')
    return attestation
  }
}
