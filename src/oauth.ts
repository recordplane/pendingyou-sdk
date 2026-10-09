// Pending You's token endpoint, with DPoP: each request carries a proof by the app's key, and the endpoint asks for a
// current nonce (400 `use_dpop_nonce` with a DPoP-Nonce header) before it spends a refresh token or a device code: the
// SDK makes the proof again with that nonce and sends the request once more. Every answer brings the next nonce.
import { type DpopKey, proof, wantsNonce } from './dpop.ts'

export const TOKEN_PATH = '/oauth/token'
export const DEVICE_PATH = '/oauth/device'
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

/** The latest nonce a Pending You gave this client, shared by its requests. */
export interface Nonces {
  get(): string | undefined
  set(nonce: string | null): void
}

export function nonces(): Nonces {
  let held: string | undefined
  return {
    get: () => held,
    set: (nonce) => {
      if (nonce) held = nonce
    },
  }
}

export interface TokenAnswer {
  access_token: string
  token_type: string
  expires_in: number
  refresh_token: string
  scope?: string
}

export type TokenResult =
  | { ok: true; tokens: TokenAnswer }
  | { ok: false; status: number; error: string; description?: string }

export interface Http {
  fetch: typeof fetch
  now: () => number
}

/** One request to the token endpoint, proven by `key`: once more with a new nonce when it asks for one. */
export async function tokenRequest(
  http: Http,
  origin: string,
  key: DpopKey,
  form: Record<string, string>,
  held: Nonces,
): Promise<TokenResult> {
  const url = `${origin}${TOKEN_PATH}`
  for (let tries = 0; ; tries++) {
    const nonce = held.get()
    const response = await http.fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        dpop: await proof(key, {
          method: 'POST',
          url,
          now: http.now(),
          ...(nonce ? { nonce } : {}),
        }),
      },
      body: new URLSearchParams(form).toString(),
    })
    held.set(response.headers.get('dpop-nonce'))
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
    if (response.ok && body && typeof body.access_token === 'string')
      return { ok: true, tokens: body as unknown as TokenAnswer }
    if (tries === 0 && wantsNonce(response, body) && response.headers.has('dpop-nonce')) continue
    return {
      ok: false,
      status: response.status,
      error: typeof body?.error === 'string' ? body.error : `status_${response.status}`,
      ...(typeof body?.error_description === 'string'
        ? { description: body.error_description }
        : {}),
    }
  }
}
