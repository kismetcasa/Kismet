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
//
// Deliberately NOT matching loose `/not authorized/` — that string appears
// in on-chain permission reverts ("Caller is not authorized for this
// token"), which are NOT wallet-session failures and would mislead the
// user into a reconnect loop. We rely on the literal "unauthorized" /
// "has not been authorized" wording, which is wallet-context only.
const AUTH_ERROR_REGEX =
  /unauthorized|has not been authorized|session.*(expired|disconnect)|wallet.*disconnect|provider.*disconnect/i

// EIP-1193 auth-class numeric codes — unambiguous regardless of message
// format. 4100 = "method/account not authorized by user"; 4900 = "provider
// disconnected from all chains"; 4901 = "not connected to requested chain"
// (still implies the provider exists, just on a different chain — same
// recovery via reconnect).
const AUTH_ERROR_CODES = new Set([4100, 4900, 4901])

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
 * Walks an error chain for an authorization-class failure: any EIP-1193
 * auth-class code (4100, 4900, 4901) or any "unauthorized"/"session
 * expired"/"provider disconnected" phrasing the wallet attaches to
 * message/details. Deliberately does NOT match bare -32006 by code —
 * that code is ambiguous (its canonical meaning is "JSON-RPC version
 * unsupported"); we rely on the auth wording the host sends alongside
 * it, which viem folds into the message string.
 *
 * Checked AFTER isUserRejection so an explicit 4001 decline never reads as
 * an auth failure.
 */
export function isAuthError(err: unknown, depth = 0): boolean {
  if (err == null || depth > 5) return false
  if (typeof err === 'string') return AUTH_ERROR_REGEX.test(err)
  if (typeof err !== 'object') return false
  const e = err as MaybeWalletError
  if (typeof e.code === 'number' && AUTH_ERROR_CODES.has(e.code)) return true
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
 *
 * When `onReconnect` is supplied, the Reconnect button's onClick:
 *   1. Calls event.preventDefault() so sonner does not auto-dismiss the
 *      toast (sonner's action handler runs `!event.defaultPrevented && $()`
 *      to dismiss; without preventDefault, the loading toast we set
 *      synchronously below would be dismissed in the same tick).
 *   2. Replaces the toast in place with a "Reconnecting…" loading state
 *      so the user has visible progress during wagmi's reconnect window
 *      (~2-8s for WalletConnect / Mini App connectors).
 *   3. Invokes the consumer's onReconnect, which is expected to run the
 *      wagmi reconnect + retry chain.
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
        ? {
            label: 'Reconnect',
            onClick: (event) => {
              event.preventDefault()
              if (options.id) {
                toast.loading('Reconnecting…', { id: options.id })
              }
              options.onReconnect!()
            },
          }
        : undefined,
    })
    return
  }
  toast.error(`${action} failed`, {
    id: options.id,
    description: extractMessage(err),
  })
}

/**
 * Show the "reconnect didn't help — try reloading" recovery toast. Used
 * by wallet-write hooks when an auth-class error reoccurs on the retry
 * that followed a wagmi reconnect: at that point we know reconnect alone
 * can't fix this user's wallet session (most commonly a Farcaster Mini App
 * with a dead host bridge), and a full page reload — which re-bootstraps
 * the SDK, the wagmi connectors, and the EIP-1193 provider — is the
 * universal recovery that works across every connector type.
 */
export function toastReloadRecovery(options: { id?: string } = {}): void {
  toast.error('Try reloading the page', {
    id: options.id,
    description:
      'Your wallet session needs a fresh start. Nothing was charged.',
    action: {
      label: 'Reload',
      onClick: (event) => {
        event.preventDefault()
        if (typeof window !== 'undefined') window.location.reload()
      },
    },
  })
}
