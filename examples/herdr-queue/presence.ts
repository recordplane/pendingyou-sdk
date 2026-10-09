// Keeping the person's phone quiet while they're at your app: POST /v1/presence (scope `presence:desk`).
// https://www.pendingyou.com/docs/api#endpoints
//
// Pending You holds the phone's notifications for the cards your app shows while it hears "here" (each lasts 75
// seconds), as it does while Pending You itself is open on their desk. So: "here" every 30 seconds while the person has
// been active in the last 2 minutes, and "gone" once, when they haven't. Pending You for Herdr counts a key in its
// popup, or moving between Herdr's panes, as active; this example counts a key in the queue.

/** How long after the last sign of the person they still count as here. */
export const ACTIVE_MS = 2 * 60_000
/** How often Pending You hears it while they are. */
export const HEARTBEAT_MS = 30_000

/** What Pending You last heard: whether they're here, and when it was told. */
export interface Desk {
  here: boolean
  sentAt: number
}

export const away = (): Desk => ({ here: false, sentAt: Number.NEGATIVE_INFINITY })

/**
 * What to tell Pending You now, given the last sign of the person (`activeAt`): `true` while they've been active and it
 * last heard so 30 seconds ago or more (or heard they'd left), `false` once when they're no longer active, else
 * nothing (null). The desk is what it will have heard once the send goes through.
 */
export function deskStep(
  desk: Desk,
  activeAt: number | null,
  now: number,
): { desk: Desk; send: boolean | null } {
  const active = activeAt !== null && now - activeAt < ACTIVE_MS
  if (active && (!desk.here || now - desk.sentAt >= HEARTBEAT_MS))
    return { desk: { here: true, sentAt: now }, send: true }
  if (!active && desk.here) return { desk: { here: false, sentAt: now }, send: false }
  return { desk, send: null }
}
