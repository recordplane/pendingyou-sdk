// Signing out (RFC 7009): the app ends its own sign-in at Pending You by revoking its refresh token at the token
// endpoint, which ends the whole grant and every token of it at once; Settings › Apps and devices stops listing it. No
// proof is needed (the token is what's ended), and Pending You answers 200 whatever it held, as the RFC asks. The store
// is left as it is: remove the sign-in from it afterwards, whether or not Pending You could be reached.
import { TOKEN_PATH } from './oauth.ts'
import type { Store } from './store.ts'

export interface SignOutOptions {
  /** Where the sign-in is kept. */
  store: Store
  fetch?: typeof fetch
}

/**
 * Ends the stored sign-in at Pending You. `signed-out` when Pending You took it, `none` when the store holds no sign-in,
 * `unreachable` when Pending You couldn't be reached or refused it (the sign-in then ends by itself, 30 days from its
 * start).
 */
export async function signOut(
  options: SignOutOptions,
): Promise<'signed-out' | 'none' | 'unreachable'> {
  const credentials = await options.store.load()
  if (!credentials) return 'none'
  const send =
    options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
  try {
    const response = await send(`${credentials.origin}${TOKEN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        token: credentials.refreshToken,
        token_type_hint: 'refresh_token',
        client_id: credentials.clientId,
      }).toString(),
    })
    await response.body?.cancel().catch(() => {})
    return response.ok ? 'signed-out' : 'unreachable'
  } catch {
    return 'unreachable'
  }
}
