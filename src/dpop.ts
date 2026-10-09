// DPoP (RFC 9449) on WebCrypto alone, so it runs the same on Node 20+, in browsers and in Workers: the app's own P-256
// key, its RFC 7638 thumbprint (what Pending You binds the grant to), and a proof per request (ES256, the public key in
// its header). The private key leaves only as a JWK for the app's own store, never in a request.

/** A P-256 private key as a JWK, as a store keeps it. */
export interface PrivateJwk {
  kty: 'EC'
  crv: 'P-256'
  x: string
  y: string
  d: string
}

/** The public half, as a proof's header carries it. */
export interface PublicJwk {
  kty: 'EC'
  crv: 'P-256'
  x: string
  y: string
}

/** A key ready to sign proofs. */
export interface DpopKey {
  jwk: PublicJwk
  /** Its RFC 7638 thumbprint, base64url: the grant's `cnf.jkt`. */
  jkt: string
  privateKey: CryptoKey
}

const subtle = () => crypto.subtle
const text = new TextEncoder()

export function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

const encode = (value: unknown) => base64url(text.encode(JSON.stringify(value)))

/** SHA-256, base64url: a thumbprint's, or an access token's `ath`. */
export async function sha256(value: string): Promise<string> {
  return base64url(new Uint8Array(await subtle().digest('SHA-256', text.encode(value))))
}

/** RFC 7638: SHA-256 of the key's required members, in order, with no whitespace. */
export const thumbprint = (jwk: PublicJwk) =>
  sha256(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))

const isPrivateJwk = (value: unknown): value is PrivateJwk => {
  const jwk = value as Partial<PrivateJwk> | null
  return (
    typeof jwk === 'object' &&
    jwk !== null &&
    jwk.kty === 'EC' &&
    jwk.crv === 'P-256' &&
    [jwk.x, jwk.y, jwk.d].every(
      (part) => typeof part === 'string' && /^[A-Za-z0-9_-]{43}$/.test(part),
    )
  )
}

/** A key from a store's JWK. */
export async function importKey(jwk: PrivateJwk): Promise<DpopKey> {
  if (!isPrivateJwk(jwk)) throw new TypeError('Not a P-256 private key')
  const privateKey = await subtle().importKey(
    'jwk',
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
  const pub: PublicJwk = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }
  return { jwk: pub, jkt: await thumbprint(pub), privateKey }
}

/** A new key, and its JWK to keep. */
export async function generateKey(): Promise<{ key: DpopKey; jwk: PrivateJwk }> {
  const pair = (await subtle().generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const exported = (await subtle().exportKey('jwk', pair.privateKey)) as Partial<PrivateJwk>
  const jwk: PrivateJwk = {
    kty: 'EC',
    crv: 'P-256',
    x: String(exported.x),
    y: String(exported.y),
    d: String(exported.d),
  }
  return { key: await importKey(jwk), jwk }
}

/** A compact JWS, ES256, of `header` and `claims`. */
export async function signJws(
  key: Pick<DpopKey, 'privateKey'>,
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
): Promise<string> {
  const signing = `${encode(header)}.${encode(claims)}`
  const signature = await subtle().sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key.privateKey,
    text.encode(signing),
  )
  return `${signing}.${base64url(new Uint8Array(signature))}`
}

/** An address as a proof names it (RFC 9449 §4.2): without its query or fragment. */
export function htuOf(url: string): string {
  const parsed = new URL(url)
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`
}

/**
 * A proof for one request: its method and address, made now (seconds of `now`, milliseconds) with a fresh jti, the
 * access token's hash at /v1, and the server's last nonce when there is one.
 */
export async function proof(
  key: DpopKey,
  request: { method: string; url: string; accessToken?: string; nonce?: string; now: number },
): Promise<string> {
  const jti = base64url(crypto.getRandomValues(new Uint8Array(16)))
  return signJws(
    key,
    { typ: 'dpop+jwt', alg: 'ES256', jwk: key.jwk },
    {
      jti,
      htm: request.method,
      htu: htuOf(request.url),
      iat: Math.floor(request.now / 1000),
      ...(request.accessToken ? { ath: await sha256(request.accessToken) } : {}),
      ...(request.nonce ? { nonce: request.nonce } : {}),
    },
  )
}

/**
 * Whether an answer asks for a current nonce (RFC 9449 §8, §9): `use_dpop_nonce` in the token endpoint's body, or in
 * a resource's WWW-Authenticate.
 */
export function wantsNonce(response: Response, body: unknown): boolean {
  if (/error="use_dpop_nonce"/.test(response.headers.get('www-authenticate') ?? '')) return true
  return (body as { error?: unknown } | null)?.error === 'use_dpop_nonce'
}
