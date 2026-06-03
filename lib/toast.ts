import { toast } from 'sonner'

// Recognized rejection patterns across MetaMask, WalletConnect, Coinbase
// Wallet, Brave, Trust, etc. We match either the EIP-1193 numeric code
// (4001 = User Rejected Request) or the various human-readable phrasings
// providers attach to error.message.
const REJECTION_REGEX = /user rejected|user denied|rejected the request|user cancell?ed/i

// "Connected but not authorized" signals. wagmi can restore a persisted
// session while the wallet's signing backend is dead. Deliberately does
// NOT match bare `/not authorized/` — that wording appears in on-chain
// permission reverts ("Caller is not authorized for this token"), which
// would mislead the user into a reconnect loop. The literal "unauthorized"
// or "not been authorized" phrasings are wallet-context only.
const AUTH_ERROR_REGEX =
  /unauthorized|not been authorized|session.*(?:expired|disconnect)|(?:wallet|provider).*disconnect/i

// EIP-1193 auth-class numeric codes: 4100 = not authorized by user,
// 4900 = provider disconnected, 4901 = not connected to requested chain.
const AUTH_ERROR_CODES = new Set([4100, 4900, 4901])

interface MaybeWalletError {
  message?: unknown
  code?: unknown
  details?: unknown
  shortMessage?: unknown
  cause?: unknown
}

// Walks an error chain (err → err.cause → …) testing each frame against
// a predicate. wagmi/viem wrap the meaningful error 2-3 levels deep
// inside ContractFunctionExecutionError / RpcRequestError envelopes.
// Depth-capped so a cyclic .cause cannot loop.
export function walkError(
  err: unknown,
  match: (e: Record<string, unknown>) => boolean,
  depth = 0,
): boolean {
  if (err == null || depth > 5) return false
  if (typeof err !== 'object') return false
  const e = err as Record<string, unknown>
  if (match(e)) return true
  return e.cause != null ? walkError(e.cause, match, depth + 1) : false
}

/**
 * True if the error chain contains a wallet user-rejection — EIP-1193
 * code 4001 or a recognized "user rejected/cancelled" phrasing.
 */
export function isUserRejection(err: unknown): boolean {
  if (typeof err === 'string') return REJECTION_REGEX.test(err)
  return walkError(err, (e) =>
    (typeof e.code === 'number' && e.code === 4001) ||
    (typeof e.message === 'string' && REJECTION_REGEX.test(e.message)),
  )
}

/**
 * True if the error chain contains an authorization-class failure — an
 * EIP-1193 auth code (4100/4900/4901) or a wallet "unauthorized / session
 * expired / provider disconnected" phrasing. Check AFTER isUserRejection
 * so an explicit 4001 decline never reads as an auth failure.
 */
export function isAuthError(err: unknown): boolean {
  if (typeof err === 'string') return AUTH_ERROR_REGEX.test(err)
  return walkError(err, (e) =>
    (typeof e.code === 'number' && AUTH_ERROR_CODES.has(e.code)) ||
    (typeof e.message === 'string' && AUTH_ERROR_REGEX.test(e.message)) ||
    (typeof e.details === 'string' && AUTH_ERROR_REGEX.test(e.details)),
  )
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
      const detailsLower = details.toLowerCase()
      if (details && !short.toLowerCase().includes(detailsLower)) {
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
 * Show an error toast for a wallet write. Wallet rejections collapse to a
 * clean "Cancelled" title; auth-class failures show a reconnect-recovery
 * message with an optional Reconnect action; everything else falls back to
 * "<action> failed" + the underlying message.
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
              // preventDefault keeps sonner from auto-dismissing — sonner
              // runs `!event.defaultPrevented && dismiss()` after onClick,
              // which would kill the loading toast we set right below.
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
 * Terminal recovery toast for when reconnect already ran and the wallet
 * is still returning auth errors. A full page reload re-bootstraps the
 * SDK, wagmi connectors, and EIP-1193 provider — the universal recovery
 * (notably for Farcaster Mini App hosts with a dead bridge).
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
