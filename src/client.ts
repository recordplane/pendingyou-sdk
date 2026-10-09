// The person API's client (docs/plans/2026-10-05-person-api.md §6, §10): every route of /v1 that's served, as the person
// who signed the app in. It looks after what every call needs:
// - DPoP: `Authorization: DPoP <token>` with a proof for each request by the key the tokens are bound to, the last
//   nonce Pending You gave, and once more with a new one when it asks (`use_dpop_nonce`);
// - refresh with rotation, single-flight: calls that find the access token run out (or refused) wait on one refresh,
//   under the store's `exclusive`, which reads the store again first, so a refresh another process made is used, not
//   spent twice; a sign-in that ended is a SignedOutError;
// - ETags: a read sends back the ETag it holds and takes 304 as the answer it had;
// - Idempotency-Key: one made for every answer (and every other change to a card), kept for its retry, so a request
//   sent again after a dropped connection never answers twice;
// - `changes()`, the change feed as an async iterator, with backoff and a resync every 10 minutes.
// It never logs, and never puts a token, proof or a card's words in an error.
import { type ChangeBatch, type ChangesOptions, changeFeed } from './changes.ts'
import { type DpopKey, importKey, proof, wantsNonce } from './dpop.ts'
import { ApiError, SignedOutError } from './errors.ts'
import { type Nonces, nonces, tokenRequest } from './oauth.ts'
import type {
  AnswerRequest,
  AnswerResponse,
  AssistantList,
  Card,
  CardBack,
  CardList,
  CardResponse,
  ChangeList,
  ChangesQuery,
  DelegateRequest,
  DelegateResponse,
  LaterRequest,
  LaterResponse,
  ListCardsQuery,
  Me,
  MessageRequest,
  MessageResponse,
  Problem,
} from './openapi.generated.ts'
import type { Credentials, Store } from './store.ts'

/** A token this close to running out is refreshed first. */
export const REFRESH_SKEW_MS = 60_000
/** ETags kept for reads, at most. */
const CACHE_MAX = 200

export interface ClientOptions {
  /** Where the sign-in is kept: memoryStore, or fileStore (./node.ts). */
  store: Store
  /** Pending You's address; the stored sign-in's by default. */
  origin?: string
  /** Pin a dated version of /v1's behaviour (`Pending-You-Version`). */
  version?: string
  fetch?: typeof fetch
  /** Milliseconds; Date.now unless a test gives its own. */
  now?: () => number
  /** Waits; setTimeout unless a test gives its own. Ends early when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** A new Idempotency-Key; crypto.randomUUID unless a test gives its own. */
  idempotencyKey?: () => string
}

export interface RequestOptions {
  query?: Record<string, string | number | readonly string[] | undefined>
  body?: unknown
  /** The Idempotency-Key to send (a POST that changes a card gets a new one when none is given). */
  idempotencyKey?: string
  signal?: AbortSignal
}

export interface Client {
  /** Who and what this sign-in is. Any scope. */
  me(options?: { signal?: AbortSignal }): Promise<Me>
  cards: {
    /** The cards in reach, one list at a time (cards:read). */
    list(query?: ListCardsQuery, options?: { signal?: AbortSignal }): Promise<CardList>
    /** One card, whole (cards:read). */
    get(id: string, options?: { signal?: AbortSignal }): Promise<Card>
    /** Answer it, with the version shown (cards:answer). An Idempotency-Key is made unless given. */
    answer(
      id: string,
      answer: AnswerRequest,
      options?: { idempotencyKey?: string },
    ): Promise<AnswerResponse>
    /** Take this app's answer back in its 5 seconds (cards:answer). */
    undo(id: string, options?: { idempotencyKey?: string }): Promise<CardBack>
    /** Words to the assistant that asked (cards:reply). */
    reply(
      id: string,
      message: string | MessageRequest,
      options?: { idempotencyKey?: string },
    ): Promise<MessageResponse>
    /** Put it in Later (cards:later): a time, or `1h`, `tonight`, `tomorrow` in `timeZone`. */
    later(
      id: string,
      later: LaterRequest,
      options?: { idempotencyKey?: string },
    ): Promise<LaterResponse>
    /** Bring it back from Later now (cards:later). */
    back(id: string, options?: { idempotencyKey?: string }): Promise<CardBack>
    /** Hand it to another assistant in reach (cards:delegate). */
    delegate(
      id: string,
      to: DelegateRequest,
      options?: { idempotencyKey?: string },
    ): Promise<DelegateResponse>
    /** Take it back from its helper (cards:delegate). */
    takeBack(id: string, options?: { idempotencyKey?: string }): Promise<CardBack>
  }
  assistants: {
    /** The assistants in reach, their agents and the sessions running now (assistants:read). */
    list(options?: { signal?: AbortSignal }): Promise<AssistantList>
  }
  /** The person is at this app now, or has left it (presence:desk). Every 30 seconds while they are. */
  presence(here: boolean): Promise<void>
  /** One page of the change feed (cards:read). */
  changesPage(query?: ChangesQuery, options?: { signal?: AbortSignal }): Promise<ChangeList>
  /** The change feed, followed (cards:read): see changes.ts. */
  changes(options?: ChangesOptions): AsyncIterableIterator<ChangeBatch>
  /** Any /v1 request, with DPoP, refresh, ETags and an Idempotency-Key as the methods have them. */
  request<T>(method: 'GET' | 'POST', path: string, options?: RequestOptions): Promise<T>
}

const path = (id: string, action?: string) =>
  `/v1/cards/${encodeURIComponent(id)}${action ? `/${action}` : ''}`

/** The query string a GET sends: a filter repeated for each of its values. */
export function queryString(query: RequestOptions['query']): string {
  const params = new URLSearchParams()
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const each of value) params.append(name, String(each))
    else params.append(name, String(value))
  }
  const text = params.toString()
  return text ? `?${text}` : ''
}

export function createClient(options: ClientOptions): Client {
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
  const newKey = options.idempotencyKey ?? (() => crypto.randomUUID())
  const held: Nonces = nonces()
  const cache = new Map<string, { etag: string; body: unknown }>()
  let current: Credentials | null = null
  let key: { jwk: string; key: DpopKey } | null = null
  let refreshing: Promise<Credentials> | null = null

  async function credentials(): Promise<Credentials> {
    current ??= await options.store.load()
    if (!current) throw new SignedOutError('signed_out', 'Not signed in: sign in first.')
    return current
  }

  async function keyOf(credentials: Credentials): Promise<DpopKey> {
    const text = JSON.stringify(credentials.key)
    if (key?.jwk !== text) key = { jwk: text, key: await importKey(credentials.key) }
    return key.key
  }

  const originOf = (credentials: Credentials) => options.origin ?? credentials.origin

  /**
   * New tokens for `stale` (an access token that ran out, or was refused), once however many calls ask together: under
   * the store's `exclusive`, from the store as it is now. Tokens another process saved meanwhile are taken as they are.
   */
  function refresh(stale: string): Promise<Credentials> {
    refreshing ??= options.store
      .exclusive(async () => {
        const stored = (await options.store.load()) ?? current
        if (!stored) throw new SignedOutError('signed_out', 'Not signed in: sign in first.')
        if (stored.accessToken !== stale && stored.expiresAt - http.now() > REFRESH_SKEW_MS) {
          current = stored
          return stored
        }
        const origin = originOf(stored)
        const result = await tokenRequest(
          http,
          origin,
          await keyOf(stored),
          {
            grant_type: 'refresh_token',
            refresh_token: stored.refreshToken,
            client_id: stored.clientId,
            resource: `${origin}/v1`,
          },
          held,
        )
        if (!result.ok) {
          if (result.error === 'invalid_grant' || result.error === 'invalid_client')
            throw new SignedOutError(result.error)
          throw new ApiError(result.status, result.error, 'The sign-in couldn’t be refreshed.')
        }
        const next: Credentials = {
          ...stored,
          accessToken: result.tokens.access_token,
          refreshToken: result.tokens.refresh_token ?? stored.refreshToken,
          expiresAt: http.now() + result.tokens.expires_in * 1000,
          ...(result.tokens.scope ? { scopes: result.tokens.scope.split(' ') } : {}),
        }
        await options.store.save(next)
        current = next
        return next
      })
      .finally(() => {
        refreshing = null
      })
    return refreshing
  }

  async function send(
    method: string,
    url: string,
    credentials: Credentials,
    init: RequestOptions,
    etag: string | undefined,
  ): Promise<Response> {
    const nonce = held.get()
    const response = await http.fetch(url, {
      method,
      headers: {
        authorization: `DPoP ${credentials.accessToken}`,
        dpop: await proof(await keyOf(credentials), {
          method,
          url,
          accessToken: credentials.accessToken,
          now: http.now(),
          ...(nonce ? { nonce } : {}),
        }),
        accept: 'application/json',
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(init.idempotencyKey ? { 'idempotency-key': init.idempotencyKey } : {}),
        ...(options.version ? { 'pending-you-version': options.version } : {}),
        ...(etag ? { 'if-none-match': etag } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    })
    held.set(response.headers.get('dpop-nonce'))
    return response
  }

  async function request<T>(
    method: 'GET' | 'POST',
    route: string,
    init: RequestOptions = {},
  ): Promise<T> {
    let creds = await credentials()
    if (creds.expiresAt - http.now() <= REFRESH_SKEW_MS) creds = await refresh(creds.accessToken)
    const url = `${originOf(creds)}${route}${method === 'GET' ? queryString(init.query) : ''}`
    let nonceRetried = false
    let refreshed = false
    let resent = false
    for (;;) {
      const cached = method === 'GET' ? cache.get(url) : undefined
      let response: Response
      try {
        response = await send(method, url, creds, init, cached?.etag)
      } catch (error) {
        // A dropped connection: a read, or a change with its Idempotency-Key, is sent again once.
        if (init.signal?.aborted || resent || (method === 'POST' && !init.idempotencyKey))
          throw error
        resent = true
        await sleep(1000, init.signal)
        continue
      }
      if (response.status === 304 && cached) return cached.body as T
      if (response.status === 204) return undefined as T
      const body: unknown = await response.json().catch(() => null)
      if (response.status === 401) {
        if (!nonceRetried && wantsNonce(response, body) && response.headers.has('dpop-nonce')) {
          nonceRetried = true
          continue
        }
        const error = /error="([a-z_]+)"/.exec(response.headers.get('www-authenticate') ?? '')?.[1]
        if (error === 'invalid_token' && !refreshed) {
          refreshed = true
          creds = await refresh(creds.accessToken)
          continue
        }
        if (error === 'invalid_token' || error === undefined)
          throw new SignedOutError('invalid_token')
        throw new ApiError(401, error, `Pending You refused the request (${error}).`)
      }
      if (response.status === 503 && !resent && (method === 'GET' || init.idempotencyKey)) {
        resent = true
        await sleep(1000, init.signal)
        continue
      }
      if (!response.ok) throw refusal(response, body)
      if (method === 'GET') {
        const etag = response.headers.get('etag')
        if (etag) {
          cache.delete(url)
          cache.set(url, { etag, body })
          if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string)
        }
      }
      return body as T
    }
  }

  const keyed = (given?: string) => ({ idempotencyKey: given ?? newKey() })

  const client: Client = {
    me: (opts) => request<Me>('GET', '/v1/me', opts),
    cards: {
      list: (query, opts) =>
        request<CardList>('GET', '/v1/cards', {
          ...opts,
          ...(query ? { query: query as RequestOptions['query'] } : {}),
        }),
      get: async (id, opts) => (await request<CardResponse>('GET', path(id), opts)).card,
      answer: (id, answer, opts) =>
        request<AnswerResponse>('POST', path(id, 'answer'), {
          body: answer,
          ...keyed(opts?.idempotencyKey),
        }),
      undo: (id, opts) =>
        request<CardBack>('POST', path(id, 'undo'), { body: {}, ...keyed(opts?.idempotencyKey) }),
      reply: (id, message, opts) =>
        request<MessageResponse>('POST', path(id, 'messages'), {
          body: typeof message === 'string' ? { body: message } : message,
          ...keyed(opts?.idempotencyKey),
        }),
      later: (id, later, opts) =>
        request<LaterResponse>('POST', path(id, 'later'), {
          body: later,
          ...keyed(opts?.idempotencyKey),
        }),
      back: (id, opts) =>
        request<CardBack>('POST', path(id, 'back'), { body: {}, ...keyed(opts?.idempotencyKey) }),
      delegate: (id, to, opts) =>
        request<DelegateResponse>('POST', path(id, 'delegate'), {
          body: to,
          ...keyed(opts?.idempotencyKey),
        }),
      takeBack: (id, opts) =>
        request<CardBack>('POST', path(id, 'take-back'), {
          body: {},
          ...keyed(opts?.idempotencyKey),
        }),
    },
    assistants: {
      list: (opts) => request<AssistantList>('GET', '/v1/assistants', opts),
    },
    presence: async (here) => {
      await request<void>('POST', '/v1/presence', { body: { here } })
    },
    changesPage: (query, opts) =>
      request<ChangeList>('GET', '/v1/changes', {
        ...opts,
        ...(query ? { query: query as RequestOptions['query'] } : {}),
      }),
    changes: (opts) =>
      changeFeed(
        (query, signal) => client.changesPage(query, signal ? { signal } : {}),
        { now: http.now, sleep },
        opts,
      ),
    request,
  }
  return client
}

/** A refusal as an ApiError: the problem's code and detail, or OAuth's error; how long to wait, when it says. */
function refusal(response: Response, body: unknown): ApiError {
  const problem = body as Partial<Problem> | null
  const header = Number(response.headers.get('retry-after'))
  const retryAfterSeconds =
    typeof problem?.retryAfterSeconds === 'number'
      ? problem.retryAfterSeconds
      : Number.isFinite(header) && header > 0
        ? header
        : undefined
  if (problem && typeof problem.code === 'string')
    return new ApiError(response.status, problem.code, problem.detail ?? problem.code, {
      problem: problem as Problem,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    })
  const error = (body as { error?: unknown } | null)?.error
  const code = typeof error === 'string' ? error : `status_${response.status}`
  return new ApiError(response.status, code, `Pending You answered ${response.status} (${code}).`, {
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  })
}
