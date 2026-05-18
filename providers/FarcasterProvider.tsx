'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useAccount, useConnect } from 'wagmi'

export type FarcasterIdentity = {
  /** Numeric Farcaster ID — from `sdk.context.user.fid` (Mini App) or a /api/profile reverse lookup (web). */
  fid: number
  /** Username (`@alice`) from the FC profile, when set. */
  username: string | null
  /** Free-text display name from the FC profile, when set. */
  displayName: string | null
  /** Profile picture URL from the FC profile, when set. */
  pfpUrl: string | null
  /** FC primary verified Ethereum address bound to this FID. */
  address: string | null
}

type FarcasterContextValue = {
  /** True only after the Farcaster SDK confirms we're inside a host. */
  isInMiniApp: boolean
  /** True after sdk.actions.ready() has resolved successfully. */
  ready: boolean
  /** Populated after Quick Auth completes; null on regular web or before bootstrap. */
  identity: FarcasterIdentity | null
  /**
   * True when sdk.context.client reports the user has already added the
   * Mini App. Used to suppress addMiniApp prompts so we never nag users
   * who've already opted in.
   */
  added: boolean
  /**
   * True when the host reports notificationDetails on the current
   * context — i.e. the user has notifications enabled for Kismet. This
   * is the stronger signal than `added`: a user can add the app but
   * decline notifications, in which case `added=true` and
   * `notificationsEnabled=false`. Tokens flow via the webhook, not this
   * client-side flag, so this is purely a prompt-suppression signal.
   */
  notificationsEnabled: boolean
  /**
   * Prompt the user to add the Mini App. Short-circuits silently when
   *   - not running inside a Mini App host
   *   - the user has already added (sdk.context.client.added)
   *   - notifications are already enabled
   *   - we've shown the prompt within the cooldown window (30d)
   *   - another modal/dialog is currently open
   * Callers pass a `surface` so the cooldown is per-trigger (mint and
   * follow can each show the prompt once, not blocked by the other).
   * Stamps the cooldown when called — so a user who dismisses the
   * host's consent sheet still uses their one shot.
   */
  promptAddMiniApp: (opts: { surface: 'mint' | 'follow' }) => Promise<void>
  /**
   * Sync sibling of promptAddMiniApp: returns true iff all the same
   * gates pass right now. Used by trigger sites to decide whether to
   * SHOW the "Add Kismet for X" affordance at all, so we don't render
   * a button that immediately no-ops on click.
   */
  shouldPromptAddMiniApp: (surface: 'mint' | 'follow') => boolean
}

const FarcasterContext = createContext<FarcasterContextValue>({
  isInMiniApp: false,
  ready: false,
  identity: null,
  added: false,
  notificationsEnabled: false,
  promptAddMiniApp: async () => {},
  shouldPromptAddMiniApp: () => false,
})

export const useFarcaster = () => useContext(FarcasterContext)

// Cheap, synchronous pre-flight to keep the ~SDK bundle out of regular web
// payloads entirely. Farcaster hosts always render Mini Apps in an iframe
// (web) or React Native WebView (mobile), so a regular browser tab can
// short-circuit to false without touching the SDK. False positives here
// just mean we load the SDK and it tells us we're not in a Mini App
// (sdk.isInMiniApp returns false fast). False negatives would be bad
// (splash hangs forever) but the two checks below are exhaustive for
// every current Farcaster host.
function isPotentialMiniAppEnv(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const inIframe = window.self !== window.top
    const inReactNativeWebView =
      typeof (window as { ReactNativeWebView?: unknown }).ReactNativeWebView !==
      'undefined'
    return inIframe || inReactNativeWebView
  } catch {
    // Cross-origin iframe access throws on `window.top` — that itself is a
    // strong signal we're embedded.
    return true
  }
}

/**
 * Install a same-origin Authorization injector on `window.fetch`.
 *
 * Mini Apps run in iframes; the conventional session cookie has
 * SameSite=Lax and is therefore dropped on every cross-site subresource
 * request — including the iframe's own kismet.art → kismet.art API calls.
 * To compensate, every authenticated server endpoint also accepts the
 * Quick Auth JWT in an `Authorization: Bearer` header (see lib/session.ts).
 *
 * Rather than touching every component that calls fetch, we wrap
 * `window.fetch` once: requests targeting our own origin get the JWT
 * automatically; everything else (RPC, IPFS gateways, Arweave) passes
 * through untouched. Scope is intentionally narrow:
 *
 *   - Only same-origin requests (parsed via the URL of the parsed input)
 *   - Only when the caller didn't already set an Authorization header
 *   - Only after a JWT has been acquired
 *
 * Returns a teardown that restores the original fetch.
 */
function installFetchInterceptor(getToken: () => Promise<string | null>): () => void {
  const original = window.fetch.bind(window)
  const ownOrigin = window.location.origin

  const wrapped: typeof window.fetch = async (input, init) => {
    let isOwnOrigin = false
    try {
      const url =
        typeof input === 'string'
          ? new URL(input, ownOrigin)
          : input instanceof URL
            ? input
            : new URL((input as Request).url, ownOrigin)
      isOwnOrigin = url.origin === ownOrigin
    } catch {
      isOwnOrigin = false
    }
    if (!isOwnOrigin) return original(input, init)

    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    if (!headers.has('authorization')) {
      const token = await getToken()
      if (token) headers.set('authorization', `Bearer ${token}`)
    }
    return original(input, { ...init, headers })
  }

  window.fetch = wrapped
  return () => {
    if (window.fetch === wrapped) window.fetch = original
  }
}

// Cooldown window between addMiniApp prompts on a given surface. 30d is
// long enough that we won't nag a user who declined once, short enough
// that a churned user returning months later gets re-offered if they
// take the same action again.
const PROMPT_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000
const promptCooldownKey = (surface: string) => `kismetart:addapp-prompt:${surface}`

// Has another dialog claimed the screen? CSS selectors over data-state
// (Radix), aria-modal (generic a11y), or role=dialog cover every modal
// we render plus most third-party ones (RainbowKit, etc).
function isAnotherDialogOpen(): boolean {
  if (typeof document === 'undefined') return false
  return !!document.querySelector(
    '[data-state="open"][role="dialog"], [aria-modal="true"], [role="alertdialog"]',
  )
}

export function FarcasterProvider({ children }: { children: ReactNode }) {
  // Only the data fields of the context live in state; the two callback
  // fields are derived per-render via useCallback so trigger sites get
  // a stable identity without re-creating state when their dep-free
  // closures haven't changed.
  type StateShape = Omit<
    FarcasterContextValue,
    'promptAddMiniApp' | 'shouldPromptAddMiniApp'
  >
  const [state, setState] = useState<StateShape>({
    isInMiniApp: false,
    ready: false,
    identity: null,
    added: false,
    notificationsEnabled: false,
  })
  // SDK reference for promptAddMiniApp — populated by the bootstrap
  // effect, read by the callback below. useRef so the callback identity
  // is stable across renders (no React refresh thrashing in trigger
  // sites that depend on `promptAddMiniApp` as an effect dep).
  const sdkRef = useRef<typeof import('@farcaster/miniapp-sdk').sdk | null>(null)

  // wagmi auto-reconnects to the Farcaster connector when it's first in
  // the connectors array (see lib/wagmi.ts) and its `isAuthorized()`
  // returns true. This explicit connect() is a safety net for the race
  // where wagmi probes connectors before the SDK's postMessage round-trip
  // to the host has resolved: if reconnect-on-mount missed it, we trigger
  // a deterministic connect once ready() confirms the host is responsive.
  // Guarded by a ref so it only fires once per mount even if wagmi
  // re-renders us mid-bootstrap.
  const { connect, connectors } = useConnect()
  const hasAttemptedConnect = useRef(false)

  useEffect(() => {
    if (!isPotentialMiniAppEnv()) {
      // Regular web user — never load the Mini App SDK, never call ready().
      // Desktop/mobile web behavior is unchanged.
      return
    }

    let cancelled = false
    let teardownFetch: (() => void) | null = null

    ;(async () => {
      try {
        // Dynamic import so the SDK is only fetched for users who land
        // inside a Farcaster host. Webpack code-splits this into its own
        // chunk, keeping the main bundle unaffected.
        const { sdk } = await import('@farcaster/miniapp-sdk')

        // sdk.isInMiniApp does its own context-verification round-trip
        // with a 100ms default timeout, so this resolves quickly even
        // when the pre-flight produced a false positive (e.g. an iframe
        // preview that isn't actually a Farcaster host).
        const confirmed = await sdk.isInMiniApp()
        if (cancelled || !confirmed) return

        // Stash the SDK reference for promptAddMiniApp. Done here (and
        // not at module scope) so the SDK chunk only loads inside hosts.
        sdkRef.current = sdk

        // CRITICAL: without this call the host shows its splash screen
        // forever. Has to come after the rest of the React tree has
        // rendered, which is guaranteed because this useEffect runs
        // after first paint of the FarcasterProvider's children.
        await sdk.actions.ready()
        if (cancelled) return

        // Wire the host wallet through wagmi. If reconnect-on-mount
        // already connected, wagmi's connect() is a no-op for an
        // already-connected connector. The ref guard makes us idempotent
        // across React's effect re-runs.
        if (!hasAttemptedConnect.current) {
          hasAttemptedConnect.current = true
          const fcConnector = connectors.find((c) => c.id === 'farcaster')
          if (fcConnector) {
            try {
              connect({ connector: fcConnector })
            } catch {
              // Host wallet not available — Mint/Collect flows surface
              // their own errors when they try to sign.
            }
          }
        }

        // Install the fetch interceptor BEFORE any authenticated request
        // fires. sdk.quickAuth.getToken returns a cached, auto-refreshed
        // JWT (~1h lifetime) so calling it on every request is cheap
        // after the first.
        teardownFetch = installFetchInterceptor(async () => {
          try {
            const result = await sdk.quickAuth.getToken()
            return result?.token ?? null
          } catch {
            return null
          }
        })

        // Pre-warm the JWT so the first authenticated fetch doesn't pay
        // an ~auth-server round-trip on the critical render path.
        let jwt: string | null = null
        try {
          const result = await sdk.quickAuth.getToken()
          jwt = result?.token ?? null
        } catch {
          // Quick Auth unavailable — UI still renders, just unauthenticated.
        }
        if (cancelled) return

        // `sdk.context` is itself a Promise (the host posts it over the
        // bridge); since isInMiniApp() already resolved true, this is
        // guaranteed to resolve.
        const ctx = await sdk.context
        const ctxUser = ctx?.user
        const hostIdentity: FarcasterIdentity | null = ctxUser
          ? {
              fid: ctxUser.fid,
              username: ctxUser.username ?? null,
              displayName: ctxUser.displayName ?? null,
              pfpUrl: ctxUser.pfpUrl ?? null,
              address: null,
            }
          : null

        // Add + notifications status from the host context. Tokens
        // themselves arrive via the webhook (server-side); we use these
        // flags only to gate the addMiniApp prompt.
        const added = ctx?.client?.added === true
        const notificationsEnabled = !!ctx?.client?.notificationDetails

        // Set partial identity immediately so UI can paint with username +
        // pfp from host context. The address comes from a server round-trip
        // (FID → primary address resolution) and is filled in below.
        setState({
          isInMiniApp: true,
          ready: true,
          identity: hostIdentity,
          added,
          notificationsEnabled,
        })

        // Resolve the address server-side. We can't do this from the
        // client (the JWT carries only the FID, not the address) and we
        // wouldn't want to anyway — the server already caches the
        // FID→address lookup in Redis.
        if (jwt) {
          try {
            const me = await fetch('/api/me')
            if (me.ok) {
              const body = (await me.json()) as { address?: string }
              if (!cancelled && body.address && hostIdentity) {
                const address = body.address
                setState((prev) => ({
                  ...prev,
                  isInMiniApp: true,
                  ready: true,
                  identity: { ...hostIdentity, address },
                }))
              }
            }
          } catch {
            // Network or auth failure — identity stays without an address;
            // unauthenticated UI paths still work.
          }
        }
      } catch (err) {
        // Fail open: if anything in the bootstrap throws, behave as a
        // regular web visit so the page still works.
        console.warn('[farcaster] mini app bootstrap failed', err)
      }
    })()

    return () => {
      cancelled = true
      teardownFetch?.()
    }
    // Mount-once bootstrap: dynamic SDK import, ready(), wagmi connect,
    // and fetch interceptor install all need to run exactly once. The
    // wagmi `connect` and `connectors` references are stable for the
    // lifetime of WagmiProvider, so excluding them from deps is safe;
    // including them would re-run the entire bootstrap on every wagmi
    // re-render (which happens on every account state change).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Web-side FC identity lookup: when the user connects a wallet on
  // regular web (no Mini App), check whether that wallet is verified
  // to a Farcaster account. If yes, populate identity with the FID's
  // primary address — making the FC primary the canonical Kismet
  // identity regardless of which of the user's wallets they connected
  // with. The wagmi-connected wallet remains the transaction signer
  // (exposed via useAccount in components that need it); identity is
  // purely for UI routing — profile URL, nav avatar, display name.
  //
  // Skipped entirely inside a Mini App: the bootstrap effect above
  // already populates identity from the verified Quick Auth JWT, which
  // is the authoritative source there.
  const { address: wagmiAddress } = useAccount()
  useEffect(() => {
    if (isPotentialMiniAppEnv()) return

    if (!wagmiAddress) {
      setState((prev) => (prev.identity ? { ...prev, identity: null } : prev))
      return
    }

    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/profile/${wagmiAddress}`)
        if (!res.ok || cancelled) return
        const data = (await res.json()) as {
          profile?: {
            farcaster?: {
              fid?: number
              username?: string | null
              displayName?: string | null
              avatarUrl?: string | null
              primaryAddress?: string | null
            }
          }
        }
        if (cancelled) return
        const fc = data.profile?.farcaster
        if (fc?.fid && fc?.primaryAddress) {
          setState((prev) => ({
            ...prev,
            identity: {
              fid: fc.fid as number,
              username: fc.username ?? null,
              displayName: fc.displayName ?? null,
              pfpUrl: fc.avatarUrl ?? null,
              address: (fc.primaryAddress as string).toLowerCase(),
            },
          }))
        } else {
          // Wallet has no FC linkage — keep behavior identical to a
          // non-FC user. Clearing handles the wallet-switch case where
          // the previous wallet had an identity.
          setState((prev) =>
            prev.identity ? { ...prev, identity: null } : prev,
          )
        }
      } catch {
        // Best-effort; on network error leave identity unchanged so a
        // transient blip doesn't reset the UI.
      }
    })()

    return () => {
      cancelled = true
    }
  }, [wagmiAddress])

  // Live-state ref so the callbacks below read fresh `added` /
  // `notificationsEnabled` flags without needing them in their dep list.
  // setState mirrors into the ref synchronously via a side-effect below.
  const stateRef = useRef(state)
  stateRef.current = state

  // Sync gate checker shared by both the toast-side
  // `shouldPromptAddMiniApp` and the click-side `promptAddMiniApp`.
  // Encapsulates the four gates so the boolean returned to trigger
  // sites is exactly the predicate the call-site path applies.
  const checkGates = useCallback((surface: 'mint' | 'follow'): boolean => {
    const s = stateRef.current
    if (!s.isInMiniApp) return false
    if (s.added) return false
    if (s.notificationsEnabled) return false
    if (isAnotherDialogOpen()) return false
    try {
      const lastRaw = localStorage.getItem(promptCooldownKey(surface))
      const last = lastRaw ? Number(lastRaw) : 0
      if (Number.isFinite(last) && Date.now() - last < PROMPT_COOLDOWN_MS) return false
    } catch {
      // localStorage unavailable — proceed (don't hide the prompt).
    }
    return true
  }, [])

  // Sync sibling — same gates, no side effects. Suitable to call from
  // render or right before firing a sonner toast with an action.
  const shouldPromptAddMiniApp = useCallback(
    (surface: 'mint' | 'follow') => checkGates(surface),
    [checkGates],
  )

  // Stable callback identity (no deps) so trigger sites can safely
  // include `promptAddMiniApp` in their effect deps. Reads context state
  // via setState's callback form to avoid stale closures over `state`.
  const promptAddMiniApp = useCallback(
    async ({ surface }: { surface: 'mint' | 'follow' }) => {
      try {
        if (!checkGates(surface)) return
        const sdk = sdkRef.current
        if (!sdk) return

        // Stamp the cooldown BEFORE firing the action so a host that
        // dismisses without resolving still counts toward the window.
        // The host owns the actual consent sheet; we hand off and stop
        // caring about the result.
        try {
          localStorage.setItem(promptCooldownKey(surface), String(Date.now()))
        } catch {}

        await sdk.actions.addMiniApp()
      } catch {
        // Host errors (user dismissed, capability missing) are not our
        // problem — the next trigger after the cooldown will retry.
      }
    },
    [checkGates],
  )

  return (
    <FarcasterContext.Provider
      value={{ ...state, promptAddMiniApp, shouldPromptAddMiniApp }}
    >
      {children}
    </FarcasterContext.Provider>
  )
}
