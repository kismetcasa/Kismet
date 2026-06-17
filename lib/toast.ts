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
// or "not been authorized" phrasings are wallet-context only. The
// disconnect alternation covers viem (provider/wallet) and WalletConnect
// ("user disconnected", "session settlement failed"); `\bexpired\b`
// catches WalletConnect's bare "Expired." (code 6) which has no
// session/wallet prefix.
const AUTH_ERROR_REGEX =
  /unauthorized|not been authorized|\bexpired\b|(?:session|wallet|provider|user).*disconnect|session.*settlement/i

// EIP-1193 auth-class numeric codes (4100 / 4900 / 4901).
const AUTH_ERROR_CODES = new Set([4100, 4900, 4901])

interface MaybeWalletError {
  message?: unknown
  code?: unknown
  details?: unknown
  shortMessage?: unknown
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

// wagmi's experimental_fallback only triggers on viem's
// MethodNotSupportedRpcError. Coinbase Wallet (mobile / WalletConnect path)
// returns a generic InternalRpcError whose `details` carries "this request
// method is not supported" — same intent, wrong shape, so the built-in fallback
// never fires. Scoped to "method"-related wording so we don't false-positive on
// unrelated errors like "chain is not supported".
const UNSUPPORTED_METHOD_RE = /method (?:is )?not supported|method not found|request method is not supported|unsupported (?:rpc )?method/i
const UNSUPPORTED_METHOD_NAME_RE = /MethodNotSupportedRpcError|UnsupportedNonOptionalCapability|UnsupportedProviderMethodError/i

/**
 * True when the error means the wallet doesn't support EIP-5792
 * (wallet_sendCalls). Used to decide whether to fall back to sequential
 * eth_sendTransaction. Safe to act on ONLY pre-submission — a batch that may
 * have already landed must not be re-dispatched (double-spend). Shared by the
 * collect-all and buy batch paths.
 */
export function isUnsupportedMethodError(err: unknown): boolean {
  if (typeof err === 'string') return UNSUPPORTED_METHOD_RE.test(err)
  return walkError(err, (e) =>
    (typeof e.name === 'string' && UNSUPPORTED_METHOD_NAME_RE.test(e.name)) ||
    (typeof e.details === 'string' && UNSUPPORTED_METHOD_RE.test(e.details)) ||
    (typeof e.message === 'string' && UNSUPPORTED_METHOD_RE.test(e.message)),
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

// Webpack lazy-chunk load failure. Almost always a stale deploy: chunk
// hashes rotate server-side on each release, so a client holding an old
// page open import()s a chunk URL that now 404s ("Loading chunk N failed").
// A reload fetches the fresh asset manifest. Also covers the native ESM
// dynamic-import phrasings some browsers/bundlers emit. app/error.tsx
// auto-reloads on this when it reaches the render boundary, but errors
// caught inside async event handlers (mint, deploy) never get there — they
// route through toastError below, which is why we detect it here too.
const CHUNK_ERROR_RE =
  /Loading chunk|Loading CSS chunk|ChunkLoadError|(?:error|failed) (?:loading|to fetch) dynamically imported module/i

/**
 * True if the error chain is a webpack/ESM dynamic-chunk load failure.
 * Matched by error name (ChunkLoadError) or the message phrasings webpack
 * and browsers emit.
 */
export function isChunkLoadError(err: unknown): boolean {
  if (typeof err === 'string') return CHUNK_ERROR_RE.test(err)
  return walkError(err, (e) =>
    (typeof e.name === 'string' && e.name === 'ChunkLoadError') ||
    (typeof e.message === 'string' && CHUNK_ERROR_RE.test(e.message)),
  )
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
 * Show an error toast. Wallet rejections collapse to a clean "Cancelled"
 * title. Callers that opt into wallet-recovery UX by supplying `onReconnect`
 * get a "Wallet needs to reconnect" toast with a Reconnect action when the
 * error looks auth-class. Everything else falls back to "<action> failed"
 * + the underlying message.
 *
 * The auth-recovery branch is GATED on `onReconnect` because the regex
 * matches on broad phrasings ("unauthorized", "session expired") that
 * also appear in server API responses unrelated to wallet sessions —
 * surfacing "Wallet needs to reconnect" for a `/api/profile` 401 would
 * be misleading. Opting in via `onReconnect` is how a call site declares
 * "I'm a wallet write, treat my auth errors accordingly."
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
  // Stale-deploy chunk failure: retrying the action re-runs the same broken
  // import. Only a reload (fresh asset manifest) recovers, so surface that
  // instead of a dead-end "<action> failed / Loading chunk N failed". Nothing
  // was charged — the chunk throws before any upload or on-chain call runs.
  if (isChunkLoadError(err)) {
    toastReloadRecovery({
      id: options.id,
      title: 'App was updated',
      description: 'A new version is live. Reload to continue — nothing was charged.',
    })
    return
  }
  if (options.onReconnect && isAuthError(err)) {
    const onReconnect = options.onReconnect
    toast.error('Wallet needs to reconnect', {
      id: options.id,
      description:
        'Your wallet session expired. Reconnect and try again — nothing was charged.',
      action: {
        label: 'Reconnect',
        onClick: (event) => {
          // preventDefault keeps sonner from auto-dismissing — sonner
          // runs `!event.defaultPrevented && dismiss()` after onClick,
          // which would kill the loading toast we set right below.
          event.preventDefault()
          if (options.id) {
            toast.loading('Reconnecting…', { id: options.id })
          }
          onReconnect()
        },
      },
    })
    return
  }
  toast.error(`${action} failed`, {
    id: options.id,
    description: extractMessage(err),
  })
}

/**
 * Terminal recovery toast offering a full page reload. Default copy targets
 * the wallet-recovery case (reconnect ran, wallet still erroring — a reload
 * re-bootstraps the SDK, wagmi connectors, and EIP-1193 provider, notably
 * for Farcaster Mini App hosts with a dead bridge). `title`/`description`
 * override it for other reload-only failures, e.g. a stale-deploy chunk error.
 */
export function toastReloadRecovery(
  options: { id?: string; title?: string; description?: string } = {},
): void {
  toast.error(options.title ?? 'Try reloading the page', {
    id: options.id,
    description:
      options.description ??
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
