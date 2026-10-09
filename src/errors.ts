// What the SDK throws: a refusal from /v1 (a problem, RFC 9457, or OAuth's), a sign-in that ended, or one that didn't
// finish. Never with a token, a proof or the words of a card.
import type { Problem } from './openapi.generated.ts'

/** /v1 refused a request: its HTTP status, its stable `code`, and the problem itself when it was one. */
export class ApiError extends Error {
  override name = 'ApiError'
  readonly status: number
  /** The problem's `code` (`high_stakes`, `version_conflict`…), or OAuth's `error` (`insufficient_scope`). */
  readonly code: string
  readonly problem?: Problem
  /** How long to wait first, from `retryAfterSeconds` or `retry-after`. */
  readonly retryAfterSeconds?: number
  constructor(
    status: number,
    code: string,
    detail: string,
    extra: { problem?: Problem; retryAfterSeconds?: number } = {},
  ) {
    super(detail)
    this.status = status
    this.code = code
    if (extra.problem) this.problem = extra.problem
    if (extra.retryAfterSeconds !== undefined) this.retryAfterSeconds = extra.retryAfterSeconds
  }
}

/** The sign-in ended (removed, replaced, run out, or its app switched off): sign in again. */
export class SignedOutError extends Error {
  override name = 'SignedOutError'
  readonly code: string
  constructor(code = 'invalid_grant', message = 'This sign-in has ended: sign in again.') {
    super(message)
    this.code = code
  }
}

/** A device sign-in that didn't finish: `access_denied`, `expired_token`, or a refusal at its start. */
export class SignInError extends Error {
  override name = 'SignInError'
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}
