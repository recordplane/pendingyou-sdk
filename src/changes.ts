// The change feed, followed (docs/plans/2026-10-05-person-api.md §6.4): GET /v1/changes again and again, each from the
// cursor the last gave, waiting up to 25 seconds each time for something to change, as an async iterator.
//
// - Each batch is what changed (ids and types only: read the cards you show again) and the cursor it reached. Keep the
//   cursor to start from it next time (`after`).
// - `resync: true` on the first batch and then every 10 minutes: read GET /v1/cards again. A card that comes into reach
//   (an assistant's computer joins the sign-in's) makes no change of its own, so the feed alone can miss it.
// - Failures wait and try again, longer each time (1 s doubling to a minute, a little random), and a 429 for as long as
//   it says. A cursor Pending You no longer takes starts again from now, with a resync. A sign-in that ended
//   (SignedOutError) or any other refusal ends the iterator with it.
// - It stops when `signal` aborts, or when the loop that reads it stops.
import { ApiError, SignedOutError } from './errors.ts'
import type { Change, ChangeList, ChangesQuery } from './openapi.generated.ts'

/** How often the feed asks for a resync: re-read the cards. */
export const RESYNC_MS = 10 * 60 * 1000
/** The longest a look waits for a change (the server's most). */
export const WAIT_SECONDS = 25
/** The first wait after a failure, and the longest. */
export const BACKOFF_MS = { first: 1000, max: 60_000 }

export interface ChangesOptions {
  /** The cursor to start from (a batch's `cursor`, kept). Without one: from now. */
  after?: string
  /** Seconds each look waits for a change: 0 to 25 (25 by default). */
  wait?: number
  /** Changes a page at most (1 to 100). */
  limit?: number
  /** Ends the feed. */
  signal?: AbortSignal
  /** How often to resync, in milliseconds (10 minutes by default). */
  resyncMs?: number
}

export interface ChangeBatch {
  /** What changed, in commit order: each card's change once per transaction. */
  changes: Change[]
  /** Where this batch ends: the next `after`. */
  cursor: string
  /** Read GET /v1/cards again now: the feed's first batch, and one every 10 minutes. */
  resync: boolean
}

type Look = (query: ChangesQuery, signal?: AbortSignal) => Promise<ChangeList>

/** How long the `failures`th failure in a row waits: doubling from a second to a minute, give or take a fifth. */
export function backoffMs(failures: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_MS.max, BACKOFF_MS.first * 2 ** Math.max(0, failures - 1))
  return Math.round(base * (0.8 + random() * 0.4))
}

export async function* changeFeed(
  look: Look,
  clock: { now: () => number; sleep: (ms: number, signal?: AbortSignal) => Promise<void> },
  options: ChangesOptions = {},
): AsyncGenerator<ChangeBatch, void, undefined> {
  const { signal } = options
  const resyncMs = options.resyncMs ?? RESYNC_MS
  const wait = Math.max(0, Math.min(WAIT_SECONDS, options.wait ?? WAIT_SECONDS))
  let cursor = options.after
  let resyncAt = Number.NEGATIVE_INFINITY
  let failures = 0
  while (!signal?.aborted) {
    const resync = clock.now() - resyncAt >= resyncMs
    let page: ChangeList
    try {
      page = await look(
        {
          ...(cursor ? { after: cursor } : {}),
          // A resync answers at once, so the app reads its cards now.
          wait: resync ? 0 : wait,
          ...(options.limit ? { limit: options.limit } : {}),
        },
        signal,
      )
    } catch (error) {
      if (signal?.aborted) return
      if (error instanceof SignedOutError) throw error
      if (error instanceof ApiError) {
        if (error.status === 400 && error.problem?.reason === 'after') {
          // A cursor it no longer takes (a restore, another server): from now, and read the cards again.
          cursor = undefined
          resyncAt = Number.NEGATIVE_INFINITY
          continue
        }
        if (error.status === 429) {
          failures++
          await clock.sleep((error.retryAfterSeconds ?? 60) * 1000, signal)
          continue
        }
        if (error.status < 500) throw error
      }
      failures++
      await clock.sleep(backoffMs(failures), signal)
      continue
    }
    failures = 0
    if (resync) resyncAt = clock.now()
    cursor = page.cursor
    if (page.changes.length || resync) yield { changes: page.changes, cursor, resync }
  }
}
