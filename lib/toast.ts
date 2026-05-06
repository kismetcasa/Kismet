// Recognized rejection patterns across MetaMask, WalletConnect, Coinbase
// Wallet, Brave, Trust, etc. We match either the EIP-1193 numeric code
// (4001 = User Rejected Request) or the various human-readable phrasings
// providers attach to error.message.
const REJECTION_REGEX = /user rejected|user denied|rejected the request|user cancell?ed/i

interface MaybeWalletError {
  message?: unknown
  code?: unknown
  cause?: unknown
}

/**
 * Walks an error chain (err → err.cause → err.cause.cause …) checking each
 * level for a known wallet rejection signal. wagmi often wraps a viem
 * UserRejectedRequestError inside a ContractFunctionExecutionError or
 * similar, so the rejection signal can be 2-3 levels deep.
 */
function isUserRejection(err: unknown, depth = 0): boolean {
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
 * Map an unknown error (wallet rejection, RPC error, fetch error, generic
 * Error) to a single human-readable description string suitable for the
 * `description` field of a sonner toast. Centralized so every callsite
 * surfaces wallet rejections as a clean "Cancelled" instead of leaking
 * "user rejected the request" strings.
 */
export function humanError(err: unknown): string {
  if (err == null) return 'Unknown error'
  if (isUserRejection(err)) return 'Cancelled'
  return err instanceof Error ? err.message : String(err)
}
