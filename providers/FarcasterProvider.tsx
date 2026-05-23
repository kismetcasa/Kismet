'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useAccount, useConnect } from 'wagmi'
import { toast } from 'sonner'
import { isPotentialMiniAppEnv } from '@/lib/miniAppEnv'

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
   * Re-fetch /api/me and update the cached identity. Called by the
   * wallet picker after the user changes their chosen Kismet address —
   * pushes the new address through Nav, ProfileView, etc. without a
   * full page reload.
   */
  refreshIdentity: () => Promise<void>
}

const FarcasterContext = createContext<FarcasterContextValue>({
  isInMiniApp: false,
  ready: false,
  identity: null,
  refreshIdentity: async () => {},
})

export const useFarcaster = () => useContext(FarcasterContext)

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
function installFetchInterceptor(
  getToken: () => Promise<string | null>,
  refreshToken: () => Promise<string | null>,
): () => void {
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

    const baseHeaders = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    let attached: string | null = null
    if (!baseHeaders.has('authorization')) {
      attached = await getToken()
      if (attached) baseHeaders.set('authorization', `Bearer ${attached}`)
    }
    let response = await original(input, { ...init, headers: baseHeaders })

    // Industry-standard single-retry on 401: Apollo's onError link,
    // Axios response interceptors, RTK Query reauth — all do this.
    // Transparent to every consumer; the cost is one extra getToken()
    // call per 401, paid once per stale-JWT cycle. Compare returned
    // token to the one we attached so a legitimately-unauthenticated
    // request (server rejects every JWT for this user) doesn't loop —
    // if refresh returns the same token, the 401 wasn't expiry-driven.
    if (response.status === 401 && attached) {
      const fresh = await refreshToken()
      if (fresh && fresh !== attached) {
        const retryHeaders = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
        retryHeaders.set('authorization', `Bearer ${fresh}`)
        response = await original(input, { ...init, headers: retryHeaders })
      }
    }
    return response
  }

  window.fetch = wrapped
  return () => {
    if (window.fetch === wrapped) window.fetch = original
  }
}

// Persisted open count drives the addMiniApp prompt. We fire the prompt
// exactly when the count transitions to 2 — i.e. on a user's second
// open of the Mini App. First open is intentionally quiet so they can
// look around without an immediate consent ask; once they've come back,
// they've signaled enough interest to be worth offering native push.
//
// localStorage is per-(origin, device) — different devices count
// independently, which is the right model for per-device notification
// opt-in.
const OPEN_COUNT_KEY = 'kismetart:miniapp-opens'
const PROMPT_TARGET_OPEN = 2

function bumpAndReadOpenCount(): number {
  try {
    const prev = Number(localStorage.getItem(OPEN_COUNT_KEY)) || 0
    const next = prev + 1
    localStorage.setItem(OPEN_COUNT_KEY, String(next))
    return next
  } catch {
    // localStorage unavailable (private mode, etc) — return a value
    // that never matches PROMPT_TARGET_OPEN so we don't surface the
    // prompt to anonymous-tier users we can't persist for.
    return 0
  }
}

type FarcasterState = Omit<FarcasterContextValue, 'refreshIdentity'>

export function FarcasterProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<FarcasterState>({
    isInMiniApp: false,
    ready: false,
    identity: null,
  })

  // Re-read /api/me and merge any address change into the cached
  // identity. Called by the wallet picker (and any future flow that
  // can change the user's chosen Kismet address) so consumers like
  // Nav re-render immediately without a page reload. Best-effort —
  // a network blip just leaves the cached state in place.
  const refreshIdentity = useCallback(async () => {
    try {
      const res = await fetch('/api/me')
      if (!res.ok) return
      const body = (await res.json()) as { address?: string }
      if (!body.address) return
      setState((prev) =>
        prev.identity
          ? { ...prev, identity: { ...prev.identity, address: body.address as string } }
          : prev,
      )
    } catch {
      // No-op — stale identity is preferable to a half-applied update.
    }
  }, [])

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

        // Install the JWT interceptor up front so the /api/me fetch
        // below picks up the Bearer token automatically. The token
        // getter is lazy — getToken() returns the in-memory token
        // when one is cached, otherwise acquires a fresh one.
        // Quick Auth caches the JWT in memory and refreshes when it
        // detects expiry. Both arguments are the same call — the
        // interceptor invokes the second one only after the server
        // returned 401, which prompts the SDK to revalidate against
        // the host. If the SDK's own cache check missed the expiry
        // (clock skew, key rotation, etc.) this catches it.
        const getQuickAuthToken = async (): Promise<string | null> => {
          try {
            const result = await sdk.quickAuth.getToken()
            return result?.token ?? null
          } catch {
            return null
          }
        }
        teardownFetch = installFetchInterceptor(getQuickAuthToken, getQuickAuthToken)

        // Parallelize everything we need before ready(). The host's
        // splash screen is showing throughout this block — every ms
        // saved here is invisible to the user, but every ms paid AFTER
        // ready() is a visible "unidentified page" flash. Per the
        // Quick Auth docs, the recommended pattern is to resolve the
        // user, THEN call ready() so the splash dismisses to a
        // fully-painted page.
        //
        // sdk.context: host posts user identity (fid, username, pfp,
        //   safeAreaInsets) over the bridge.
        // /api/me: server-side primary-address resolution (Redis cached
        //   after first hit). The interceptor we just installed injects
        //   the Quick Auth JWT. Wrapped in a 3s timeout so a hung
        //   backend can't pin the splash forever — falls through with
        //   no address (visible profile link + bell stay deferred
        //   until a later retry) and the rest of the identity still
        //   paints from sdk.context.user.
        const meController = new AbortController()
        const meTimeout = setTimeout(() => meController.abort(), 3000)
        const [ctx, meResponse] = await Promise.all([
          sdk.context,
          fetch('/api/me', { signal: meController.signal }).catch(() => null),
        ])
        clearTimeout(meTimeout)
        if (cancelled) return

        // Build the identity from host context + the resolved primary
        // address. If /api/me failed, identity still gets username/pfp
        // from ctx — the UI degrades gracefully (no profile link until
        // a later retry, but name + avatar still visible).
        const ctxUser = ctx?.user
        let resolvedAddress: string | null = null
        if (meResponse?.ok) {
          try {
            const body = (await meResponse.json()) as { address?: string }
            if (body.address) resolvedAddress = body.address
          } catch {
            // /api/me malformed — fall through with no address.
          }
        }
        const hostIdentity: FarcasterIdentity | null = ctxUser
          ? {
              fid: ctxUser.fid,
              username: ctxUser.username ?? null,
              displayName: ctxUser.displayName ?? null,
              pfpUrl: ctxUser.pfpUrl ?? null,
              address: resolvedAddress,
            }
          : null

        // Device chrome insets — notch, Dynamic Island, home indicator,
        // curved edges. Written BEFORE ready() so the first frame after
        // splash dismissal has the right paddings; otherwise the nav
        // would briefly sit behind the notch and reflow once insets
        // arrive. CSS env(safe-area-inset-*) is unreliable inside
        // WebViews (the host controls the viewport, not us) — the host
        // pushes exact pixel values via context instead.
        const insets = ctx?.client?.safeAreaInsets
        if (insets) {
          const root = document.documentElement
          root.style.setProperty('--safe-top', `${insets.top}px`)
          root.style.setProperty('--safe-bottom', `${insets.bottom}px`)
          root.style.setProperty('--safe-left', `${insets.left}px`)
          root.style.setProperty('--safe-right', `${insets.right}px`)
        }

        // Set complete identity BEFORE dismissing the splash so the
        // very first frame the user sees after the splash has the
        // username, pfp, AND resolved address baked in. No "default
        // avatar → resolved" flicker.
        setState({
          isInMiniApp: true,
          ready: true,
          identity: hostIdentity,
        })

        // Pre-fetch the FC pfp at native resolution so the <img> in
        // ProfileAvatar resolves from disk cache the moment ready()
        // dismisses the splash. Without this the browser only starts
        // the request when React mounts the <img>, paying the network
        // round-trip on the visible critical path.
        if (hostIdentity?.pfpUrl) {
          const preload = document.createElement('link')
          preload.rel = 'preload'
          preload.as = 'image'
          preload.href = hostIdentity.pfpUrl
          document.head.appendChild(preload)
        }

        // CRITICAL: without ready() the host shows its splash forever.
        // Called LAST in the pre-paint phase so everything above has
        // settled before the user sees the page.
        //
        // disableNativeGestures: true tells the host we own every
        // touch gesture in our viewport. Kismet has lots of conflicting
        // gestures — vertical-scrolling feeds, swipeable modals,
        // sub-tab bars, draggable section headers — and without this
        // flag the host's swipe-down-to-close detector intercepts
        // start-of-scroll on the feed, begins to animate the modal
        // away, then aborts when our content actually responds. The
        // side effects of that aborted animation (iframe transform,
        // mid-animation resize events) fire our SharedVideoProvider's
        // scroll/resize handlers against half-resolved geometry,
        // producing the "video positioned over wrong card / blank
        // white space below the nav" glitches that appear ONLY in
        // Mini App and NOT in mobile web. Per the canonical SDK
        // (@farcaster/miniapp-core/src/actions/Ready.ts), this is
        // the documented mechanism for apps in our category.
        //
        // Trade-off: users can no longer swipe-down to dismiss the
        // Mini App — they use the host's X button. Acceptable for an
        // app with this much scrollable + interactive surface.
        await sdk.actions.ready({ disableNativeGestures: true })
        if (cancelled) return

        // --- Post-paint bootstrap ---
        //
        // Everything below runs while the user already sees a fully
        // identified page. CRITICAL: defer this whole block behind a
        // setTimeout(0) so it queues AFTER any pending tap/scroll
        // events. Without the defer, the user's first tap on the nav
        // (which they often do within the first half-second after
        // splash dismissal) sits behind ~100-300ms of wagmi connector
        // initialization + back.enableWebNavigation handshake — felt
        // as "nav doesn't work right when it opens". Yielding to the
        // event loop here keeps the main thread interactive.
        const runPostPaint = () => {
          if (cancelled) return

          // Wire the host's back control to browser history. Silent
          // fallback for older hosts that don't expose the capability.
          sdk.back.enableWebNavigation().catch(() => {})

          // Wire the host wallet through wagmi. If reconnect-on-mount
          // already connected, wagmi's connect() is a no-op for an
          // already-connected connector. Doesn't affect first paint —
          // identity above already gives us name/pfp; this just
          // unlocks transactions (mint, follow, etc).
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
        }
        if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
          (window as Window & { requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback(runPostPaint, { timeout: 1000 })
        } else {
          setTimeout(runPostPaint, 0)
        }

        // addMiniApp prompt: only on the user's 2nd confirmed open, and
        // only when they haven't already added or enabled notifications.
        // Fires as a non-modal sonner toast so it can't interfere with
        // any in-flight action.
        const added = ctx?.client?.added === true
        const notificationsEnabled = !!ctx?.client?.notificationDetails
        if (!added && !notificationsEnabled) {
          const opens = bumpAndReadOpenCount()
          if (opens === PROMPT_TARGET_OPEN) {
            toast('Get pinged when someone collects your work.', {
              duration: 8000,
              action: {
                label: 'Add Kismet',
                onClick: () => {
                  // Host owns the consent sheet from here. Errors
                  // (user-dismissed, capability missing) are not our
                  // concern — they don't add, no push tokens land.
                  void sdk.actions.addMiniApp().catch(() => {})
                },
              },
            })
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

  // Memoize so refreshIdentity (stable) doesn't force a re-render
  // every time `state` changes for unrelated reasons.
  const value = useMemo<FarcasterContextValue>(
    () => ({ ...state, refreshIdentity }),
    [state, refreshIdentity],
  )
  return (
    <FarcasterContext.Provider value={value}>{children}</FarcasterContext.Provider>
  )
}
