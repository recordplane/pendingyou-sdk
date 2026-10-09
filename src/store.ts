// Where a sign-in is kept: its tokens and the key they're bound to. A store saves each refresh's new tokens (refresh
// tokens rotate: the old one is spent), and `exclusive` runs a refresh alone, so two processes sharing one never spend
// the same refresh token twice. memoryStore is for one process; fileStore (./node.ts) for Node, 0600 and locked.
import type { PrivateJwk } from './dpop.ts'

/** One app's sign-in at one Pending You. */
export interface Credentials {
  version: 1
  /** Pending You's address: `https://www.pendingyou.com`. */
  origin: string
  /** The app's OAuth client, for refreshes. */
  clientId: string
  accessToken: string
  refreshToken: string
  /** When the access token stops working, in milliseconds. */
  expiresAt: number
  /** What the person allowed. */
  scopes: string[]
  /** The key the tokens are bound to (DPoP). It never leaves the store but to sign. */
  key: PrivateJwk
}

export interface Store {
  load(): Promise<Credentials | null>
  save(credentials: Credentials): Promise<void>
  /** Runs `work` while no other user of this store does (a refresh): across processes where the store can. */
  exclusive<T>(work: () => Promise<T>): Promise<T>
}

/** A store in this process's memory, starting with `initial`. */
export function memoryStore(initial: Credentials | null = null): Store & {
  readonly current: Credentials | null
} {
  let held = initial
  let queue: Promise<unknown> = Promise.resolve()
  return {
    get current() {
      return held
    },
    async load() {
      return held
    },
    async save(credentials) {
      held = credentials
    },
    exclusive(work) {
      const run = queue.then(work, work)
      queue = run.catch(() => {})
      return run
    },
  }
}

/** Whether a value read back from a store is a sign-in this SDK wrote. */
export function isCredentials(value: unknown): value is Credentials {
  const entry = value as Partial<Credentials> | null
  return (
    typeof entry === 'object' &&
    entry !== null &&
    entry.version === 1 &&
    typeof entry.origin === 'string' &&
    typeof entry.clientId === 'string' &&
    typeof entry.accessToken === 'string' &&
    typeof entry.refreshToken === 'string' &&
    typeof entry.expiresAt === 'number' &&
    Array.isArray(entry.scopes) &&
    typeof entry.key === 'object' &&
    entry.key !== null
  )
}
