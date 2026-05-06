import { toast } from 'sonner'

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
 * Map an unknown error (wallet rejection, RPC error, fetch error, generic
 * Error) to a single human-readable description string suitable for the
 * `description` field of a sonner toast.
 */
export function humanError(err: unknown): string {
  if (err == null) return 'Unknown error'
  if (isUserRejection(err)) return 'Cancelled'
  return err instanceof Error ? err.message : String(err)
}

/**
 * Show an error toast. When the error is a wallet rejection, surfaces a
 * clean "Cancelled" title with no description so the user sees a single
 * unambiguous signal. For real errors, falls back to "<action> failed"
 * + the underlying message. Use this anywhere a wallet signature or
 * transaction is involved so cancellations never read as failures.
 */
export function toastError(
  action: string,
  err: unknown,
  options: { id?: string } = {},
): void {
  if (isUserRejection(err)) {
    toast.error('Cancelled', { id: options.id })
    return
  }
  toast.error(`${action} failed`, {
    id: options.id,
    description: err instanceof Error ? err.message : String(err),
  })
}
