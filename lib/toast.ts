import { toast } from 'sonner'

// Recognized rejection patterns across MetaMask, WalletConnect, Coinbase
// Wallet, Brave, Trust, etc. We match either the EIP-1193 numeric code
// (4001 = User Rejected Request) or the various human-readable phrasings
// providers attach to error.message.
const REJECTION_REGEX = /user rejected|user denied|rejected the request|user cancell?ed/i

// "Connected but not authorized" signals. wagmi can restore a persisted
// session (isConnected === true) while the wallet's signing backend is
// dead — a stale WalletConnect session on mobile web, or a Mini App host
// that answers eth_accounts but hasn't granted signing. The write then
// fails at the wallet with an auth-class error. We surface a recovery
// path instead of a raw RPC dump. Note: viem mislabels the host's -32006
// as "Version of JSON-RPC protocol is not supported"; the real signal is
// the `Details: Unauthorized` line, which lands in error.message/.details.
const AUTH_ERROR_REGEX =
  /unauthorized|not been authorized|not authorized|session.*(expired|disconnect)|wallet.*disconnect/i

interface MaybeWalletError {
  message?: unknown
  code?: unknown
  details?: unknown
  shortMessage?: unknown
  cause?: unknown
}

/**
 * Walks an error chain (err → err.cause → err.cause.cause …) checking each
 * level for a known wallet rejection signal. wagmi often wraps a viem
 * UserRejectedRequestError inside a ContractFunctionExecutionError or
 * similar, so the rejection signal can be 2-3 levels deep.
 */
export function isUserRejection(err: unknown, depth = 0): boolean {
  if (err == null || depth > 5) return false
  if (typeof err === 'string') return REJECTION_REGEX.test(err)
  if (typeof err !== 'object') return false
  const e = err as MaybeWalletError
  // EIP-1193 standard rejection code — providers MUST return 4001 on user
  // rejection per the spec, regardless of how they format the message.
  if (typeof e.code === 'number' && e.code === 4001) return true
  if (typeof e.message === 'string' && REJECTION_REGEX.test(e.message)) return true
  if (e.cause != null) return isUserRejection(e.cause, depth + 1)
  return false
}

/**
 * Walks an error chain for an authorization-class failure: EIP-1193 4100
 * (Unauthorized) or any "unauthorized"/"session expired" phrasing the
 * wallet attaches to message/details. Deliberately does NOT match bare
 * -32006 by code — that code is ambiguous (its canonical meaning is
 * "JSON-RPC version unsupported"); we rely on the auth wording the host
 * sends alongside it, which viem folds into the message string.
 *
 * Checked AFTER isUserRejection so an explicit 4001 decline never reads as
 * an auth failure.
 */
export function isAuthError(err: unknown, depth = 0): boolean {
  if (err == null || depth > 5) return false
  if (typeof err === 'string') return AUTH_ERROR_REGEX.test(err)
  if (typeof err !== 'object') return false
  const e = err as MaybeWalletError
  // EIP-1193 4100 = "The requested method and/or account has not been
  // authorized by the user." Unambiguous, regardless of message format.
  if (typeof e.code === 'number' && e.code === 4100) return true
  if (typeof e.message === 'string' && AUTH_ERROR_REGEX.test(e.message)) return true
  if (typeof e.details === 'string' && AUTH_ERROR_REGEX.test(e.details)) return true
  if (e.cause != null) return isAuthError(e.cause, depth + 1)
  return false
}

/**
 * Pull a concise, human-readable line out of an arbitrary error. viem's
 * BaseError stuffs a multi-line wall (calldata, args, docs link, version)
 * into `.message` but exposes a clean one-liner on `.shortMessage` plus the
 * underlying provider reason on `.details` — so for wallet/RPC errors we
 * use those and never the raw dump. Plain Errors fall back to the first
 * line of `.message` so a stray multi-line message can't flood a toast.
 */
function extractMessage(err: unknown): string {
  if (err == null) return 'Unknown error'
  if (typeof err === 'string') return err
  if (typeof err === 'object') {
    const e = err as MaybeWalletError
    if (typeof e.shortMessage === 'string' && e.shortMessage) {
      const short = e.shortMessage
      const details = typeof e.details === 'string' ? e.details : ''
      // Append the provider reason only when it adds signal the
      // shortMessage doesn't already carry (avoids "X. (X)").
      if (details && !short.toLowerCase().includes(details.toLowerCase())) {
        return `${short} (${details})`
      }
      return short
    }
    if (typeof e.message === 'string' && e.message) {
      return e.message.split('\n')[0]
    }
  }
  return String(err)
}

/**
 * Map an unknown error (wallet rejection, RPC error, fetch error, generic
 * Error) to a single human-readable description string suitable for the
 * `description` field of a sonner toast.
 */
export function humanError(err: unknown): string {
  if (err == null) return 'Unknown error'
  if (isUserRejection(err)) return 'Cancelled'
  return extractMessage(err)
}

/**
 * Show an error toast. When the error is a wallet rejection, surfaces a
 * clean "Cancelled" title with no description so the user sees a single
 * unambiguous signal. When it's an auth-class failure (stale session /
 * host not authorized), shows a recovery message and — if `onReconnect`
 * is supplied — a Reconnect action so the user can re-establish the
 * session without a full page reload. For real errors, falls back to
 * "<action> failed" + the underlying message. Use this anywhere a wallet
 * signature or transaction is involved so cancellations never read as
 * failures.
 */
export function toastError(
  action: string,
  err: unknown,
  options: { id?: string; onReconnect?: () => void } = {},
): void {
  if (isUserRejection(err)) {
    toast.error('Cancelled', { id: options.id })
    return
  }
  if (isAuthError(err)) {
    toast.error('Wallet needs to reconnect', {
      id: options.id,
      description:
        'Your wallet session expired. Reconnect and try again — nothing was charged.',
      action: options.onReconnect
        ? { label: 'Reconnect', onClick: options.onReconnect }
        : undefined,
    })
    return
  }
  toast.error(`${action} failed`, {
    id: options.id,
    description: extractMessage(err),
  })
}
