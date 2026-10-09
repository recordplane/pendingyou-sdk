// Following the change feed: https://www.pendingyou.com/docs/api#changes. GET /v1/changes waits up to 25 seconds for
// something to change and says what did, ids and types only; the SDK's `changes()` asks again and again from the
// cursor it reached, backs off when Pending You can't be reached, and asks for a resync on start and every 10 minutes
// (read the cards again then: a card that comes into reach makes no change of its own).
//
//   node watch.ts                               print each change as it happens
//   FORWARD_TO=<your address> node watch.ts     and POST each one there too, as a webhook would
//
// It keeps the cursor it reached in a file, so a restart picks up where it stopped. Ctrl-C stops it.
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ApiError, type Change, createClient, SignedOutError } from '@recordplane/pendingyou-sdk'
import { fileStore } from '@recordplane/pendingyou-sdk/node'

/** The sign-in the answer-cards example made (`node index.ts login` there). */
const FOLDER = join(homedir(), '.config', 'pendingyou-example')
const pendingYou = createClient({ store: fileStore(join(FOLDER, 'sign-in.json')) })

/** Where it stopped last time. */
const CURSOR_FILE = join(FOLDER, 'cursor')
/** Your own address to hear each change at, if you give one. */
const FORWARD_TO = process.env.FORWARD_TO

const stop = new AbortController()
process.once('SIGINT', () => stop.abort())

async function savedCursor(): Promise<string | undefined> {
  const text = await readFile(CURSOR_FILE, 'utf8').catch(() => '')
  return text.trim() || undefined
}

/** What the change is about, in a line: the card's title, read again now. */
async function titleOf(change: Change): Promise<string> {
  try {
    return (await pendingYou.cards.get(change.cardId)).title
  } catch (error) {
    // Out of this sign-in's reach now (removed, or on a computer it doesn't see).
    if (error instanceof ApiError && error.code === 'not_found') return '(no longer in reach)'
    throw error
  }
}

/**
 * Tells your own server, as a webhook would: the change as the feed gave it, ids and types only. Your server reads
 * the card itself if it needs its words, with its own sign-in.
 */
async function forward(change: Change): Promise<void> {
  if (!FORWARD_TO) return
  const response = await fetch(FORWARD_TO, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(change),
    signal: AbortSignal.timeout(10_000),
  }).catch((error: unknown) => error as Error)
  if (response instanceof Error || !response.ok)
    console.error(
      `  Couldn’t tell ${FORWARD_TO} (${response instanceof Error ? response.message : response.status}).`,
    )
}

try {
  for await (const batch of pendingYou.changes({
    after: await savedCursor(),
    signal: stop.signal,
  })) {
    if (batch.resync) {
      const { counts } = await pendingYou.cards.list({ status: 'pending', limit: 1 })
      console.log(`${counts.pending} waiting on you.`)
    }
    for (const change of batch.changes) {
      console.log(`${change.at}  ${change.type.padEnd(14)}  ${await titleOf(change)}`)
      await forward(change)
    }
    await writeFile(CURSOR_FILE, `${batch.cursor}\n`, { mode: 0o600 })
  }
} catch (error) {
  if (!(error instanceof SignedOutError)) throw error
  console.error('Not signed in: sign in with the answer-cards example first (node index.ts login).')
  process.exitCode = 1
}
