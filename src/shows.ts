// Show me (docs/plans/2026-10-25-show-me.md §2.2, §6): an app on a computer that brings one kind of place to the front
// there (a terminal's panes: Herdr's first) follows the person's presses of Show on a card, for the agent that asked.
// Two ways, both under assistants:show:
//
// - `shows({ places })`: the show requests as they come, as an async iterator, each once. Each look is GET
//   /v1/shows?places=…&wait=25, which also says the app is listening for the next minute, so the button shows while it
//   follows. A show stays open until an app answers it or its 30 seconds pass, so a look can bring back one already
//   yielded (left for another server's app): it isn't yielded again, and the next look waits a second first. Failures
//   wait and try again, longer each time (1 s doubling to a minute, a little random), and a 429 for as long as it says.
//   A sign-in that ended (SignedOutError) or any other refusal (403 `no_machine`: a sign-in with no computer) ends it.
//   It stops when `signal` aborts, or when the loop that reads it stops.
// - `followShows({ places, mine, find, focus })`: the same, answered. For each show, the places that are this app's
//   (`mine`; every place by default: Herdr keeps the ones on its own server) go to `find`, which looks for the agent's
//   window in the app's own list and returns the app's own record of it, or nothing. `focus` gets only that record,
//   never a place from the network, so a show can bring forward only a window the app already knows. Then it answers:
//   `shown`, or `not_found` when nothing was found (or `find` or `focus` threw) and nothing moved. A show with no place
//   of this app's is left unanswered, for the app whose it is. Another app's answer that came first
//   (`already_answered`) or a show past its 30 seconds (`expired`) ends that show quietly.
//
// A show only ever brings a window to the front: never type into it, run anything or open a link for one.
import { backoffMs, WAIT_SECONDS } from './changes.ts'
import { ApiError, SignedOutError } from './errors.ts'
import type { Show, ShowList, ShowPlace, ShowsQuery } from './openapi.generated.ts'

/** After a look that brought back only shows already yielded, the next one waits this long. */
export const REPEAT_MS = 1000

export interface ShowsOptions {
  /** The kinds of place this app brings to the front on its computer (`herdr`). */
  places: ShowsQuery['places']
  /** Seconds each look waits for a show: 0 to 25 (25 by default). */
  wait?: number
  /** Ends it. */
  signal?: AbortSignal
}

export interface FollowShowsOptions<Window> extends ShowsOptions {
  /** Whether a place is this app's to bring forward (Herdr: its server is this Herdr server). Every place by default. */
  mine?: (place: ShowPlace, show: Show) => boolean
  /**
   * The agent's window in the app's own list, for one of the show's places that are this app's (`show.places`, newest
   * first), checked as the app checks it: still there, and the agent's. The app's own record of it, or nothing.
   */
  find: (show: Show) => Window | null | undefined | Promise<Window | null | undefined>
  /** Brings the window `find` returned to the front, and nothing else. */
  focus: (window: Window, show: Show) => void | Promise<void>
}

type Look = (query: ShowsQuery, signal?: AbortSignal) => Promise<ShowList>

/** A minute past a show's end: until then it's remembered as yielded. */
const KEPT_MS = 60_000

export async function* showFeed(
  look: Look,
  clock: { now: () => number; sleep: (ms: number, signal?: AbortSignal) => Promise<void> },
  options: ShowsOptions,
): AsyncGenerator<Show, void, undefined> {
  const { signal } = options
  const wait = Math.max(0, Math.min(WAIT_SECONDS, options.wait ?? WAIT_SECONDS))
  /** Each show yielded, by its id, until a minute after it ends. */
  const yielded = new Map<string, number>()
  let failures = 0
  while (!signal?.aborted) {
    let page: ShowList
    try {
      page = await look({ places: [...options.places], wait }, signal)
    } catch (error) {
      if (signal?.aborted) return
      if (error instanceof SignedOutError) throw error
      if (error instanceof ApiError) {
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
    const now = clock.now()
    for (const [id, until] of yielded) if (until < now) yielded.delete(id)
    const fresh = page.shows.filter((show) => !yielded.has(show.id))
    for (const show of fresh) {
      const ends = Date.parse(show.expiresAt)
      yielded.set(show.id, (Number.isFinite(ends) ? ends : now) + KEPT_MS)
      yield show
      if (signal?.aborted) return
    }
    if (page.shows.length > 0 && fresh.length === 0) await clock.sleep(REPEAT_MS, signal)
  }
}

/** Whether a place is the app's, by its own check; a check that throws says no. */
function isMine(options: Pick<FollowShowsOptions<unknown>, 'mine'>, place: ShowPlace, show: Show) {
  if (!options.mine) return true
  try {
    return options.mine(place, show)
  } catch {
    return false
  }
}

/** Follows the show requests, finding each in the app's own list, bringing it forward and answering for it. */
export async function followShowsWith<Window>(
  shows: (options: ShowsOptions) => AsyncIterableIterator<Show>,
  answer: (id: string, result: 'shown' | 'not_found') => Promise<unknown>,
  options: FollowShowsOptions<Window>,
): Promise<void> {
  const { places, wait, signal, find, focus } = options
  for await (const show of shows({ places, wait, signal })) {
    const theirs = show.places.filter((place) => isMine(options, place, show))
    // Another app's (another server's): left for it.
    if (!theirs.length) continue
    const ours: Show = { ...show, places: theirs }
    let result: 'shown' | 'not_found' = 'not_found'
    try {
      const window = await find(ours)
      if (window !== null && window !== undefined) {
        await focus(window, ours)
        result = 'shown'
      }
    } catch {
      result = 'not_found'
    }
    try {
      await answer(show.id, result)
    } catch (error) {
      if (error instanceof SignedOutError) throw error
      // Another app's answer came first, the show ended, or Pending You couldn't be reached: it ends by itself.
    }
  }
}
