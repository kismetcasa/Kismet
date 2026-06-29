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
  /**
   * Offer the "Add Kismet" prompt so the creator gets push when their
   * work is collected. Self-gating no-op outside a Mini App, when the app
   * is already added / notifications enabled, once shown this session, or
   * after it has fired once on this device. Called from the mint success
   * path so a creator's first mint surfaces the ask.
   */
  maybePromptCollectNotifs: () => void
}

const FarcasterContext = createContext<FarcasterContextValue>({
  isInMiniApp: false,
  ready: false,
  identity: null,
  refreshIdentity: async () => {},
  maybePromptCollectNotifs: () => {},
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

// Pre-ready() await bounds. Both the host-context round-trip and the /api/me
// lookup are individually raced against these so a hung host bridge can't pin
// the splash; context is the cheaper call so it gets the tighter bound.
const CONTEXT_TIMEOUT_MS = 2500
const ME_FETCH_TIMEOUT_MS = 3000

// Hard ceiling on how long the host splash may stay up — the ultimate backstop
// once the per-await bounds above are exhausted. The normal path dismisses well
// under this (isInMiniApp <=1s, then context + me raced in parallel <=3s, ~4s
// worst case), so this only fires when something OUTSIDE those bounds hangs — a
// stalled SDK chunk fetch, or a future unbounded await. Set above the normal
// worst case so it never pre-empts a fully-painted load, but low enough that a
// genuine hang surfaces the app instead of an endless splash.
const SPLASH_READY_DEADLINE_MS = 6000

// One-shot (per device) flag for the post-first-mint "Add Kismet" prompt.
// Set the first time we surface that prompt so a creator who mints
// repeatedly is asked at most once. Independent of OPEN_COUNT_KEY: the two
// triggers (2nd open, 1st mint) each fire at most once, and a session-level
// guard (addPromptShownRef) prevents both landing in the same session.
const MINT_PROMPT_KEY = 'kismetart:miniapp-mint-prompt'

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

type FarcasterState = Omit<
  FarcasterContextValue,
  'refreshIdentity' | 'maybePromptCollectNotifs'
>

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

  // Drives the "Add Kismet" notification prompt, shared by both triggers
  // (2nd open + 1st mint). Set during bootstrap.
  const isInMiniAppRef = useRef(false)
  // Latest host add/notification state, so maybePromptCollectNotifs can
  // gate without re-querying the SDK.
  const addEligibilityRef = useRef({ added: false, notificationsEnabled: false })
  // Session guard: true once the prompt has shown this load, so the two
  // triggers never double-prompt within a single session.
  const addPromptShownRef = useRef(false)

  // The single source of truth for the "Add Kismet" toast. Both triggers
  // route through here so the copy + consent action stay identical and the
  // session guard is set in one place. The SDK chunk is already resolved
  // (bootstrap imported it), so the dynamic import in onClick is instant.
  const showAddKismetPrompt = useCallback(() => {
    addPromptShownRef.current = true
    toast('Get pinged when someone collects your work.', {
      duration: 8000,
      action: {
        label: 'Add Kismet',
        onClick: () => {
          // Host owns the consent sheet from here. Errors (user-dismissed,
          // capability missing) are not our concern — they don't add, no
          // push tokens land.
          void import('@farcaster/miniapp-sdk').then(({ sdk }) =>
            sdk.actions.addMiniApp().catch(() => {}),
          )
        },
      },
    })
  }, [])

  const maybePromptCollectNotifs = useCallback(() => {
    if (!isInMiniAppRef.current || addPromptShownRef.current) return
    const { added, notificationsEnabled } = addEligibilityRef.current
    if (added || notificationsEnabled) return
    try {
      if (localStorage.getItem(MINT_PROMPT_KEY) === '1') return
      localStorage.setItem(MINT_PROMPT_KEY, '1')
    } catch {
      // Can't persist the one-shot (private mode, etc) — skip rather than
      // risk re-prompting on every subsequent mint.
      return
    }
    showAddKismetPrompt()
  }, [showAddKismetPrompt])

  useEffect(() => {
    if (!isPotentialMiniAppEnv()) {
      // Regular web user — never load the Mini App SDK, never call ready().
      // Desktop/mobile web behavior is unchanged.
      return
    }

    let cancelled = false
    let teardownFetch: (() => void) | null = null
    let splashWatchdog: ReturnType<typeof setTimeout> | null = null

    // Dismiss the host splash exactly once, in EVERY path. The Mini App loading
    // guide's #1 pitfall is an infinite/long splash from a ready() that never
    // runs — so a slow context probe, a slow backend, or a throw must never gate
    // it. Reassigned to the real ready() once the SDK loads; a no-op if the
    // import fails or outside a real host (nothing to dismiss there).
    let dismissSplash = (): Promise<void> => Promise.resolve()

    ;(async () => {
      try {
        // Dynamic import so the SDK is only fetched for users who land
        // inside a Farcaster host. Webpack code-splits this into its own
        // chunk, keeping the main bundle unaffected.
        const { sdk } = await import('@farcaster/miniapp-sdk')
        let splashDismissed = false
        dismissSplash = () => {
          if (splashDismissed) return Promise.resolve()
          splashDismissed = true
          // disableNativeGestures: true — see the note at the call site below.
          return sdk.actions.ready({ disableNativeGestures: true }).catch(() => {})
        }

        // Splash watchdog — the ultimate backstop against an infinite splash.
        // Every await before ready() below is individually bounded (isInMiniApp
        // self-times-out at 1000ms, sdk.context and /api/me are raced against
        // timeouts), but a hang is a throw the catch can't see: if any await
        // never settles, dismissSplash() is never reached and the host pins its
        // splash forever (the #1 Mini App loading pitfall). This unconditional
        // timer guarantees ready() fires regardless. Idempotent via the
        // splashDismissed guard, so the normal fully-painted path still wins
        // when the bootstrap completes in time; cleared once it does.
        splashWatchdog = setTimeout(() => {
          void dismissSplash()
        }, SPLASH_READY_DEADLINE_MS)

        // sdk.isInMiniApp races a host context probe against the SDK's 1000ms
        // timeout, returning false if the probe loses — a non-host iframe
        // preview, OR a real host whose cold-load context arrives late. Either
        // way we still dismiss the splash (a no-op when there's no host).
        const confirmed = await sdk.isInMiniApp()
        if (cancelled) return
        if (!confirmed) {
          await dismissSplash()
          return
        }
        isInMiniAppRef.current = true

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
        // Both awaits are host/network round-trips with NO internal timeout
        // (unlike sdk.isInMiniApp), and on desktop the host bridge is a fragile
        // cross-origin postMessage — so each is individually raced against a
        // bound below. On timeout we fall through with null and STILL dismiss
        // the splash; identity/address just resolve later or stay deferred:
        //   • sdk.context — host posts user identity (fid, username, pfp,
        //     safeAreaInsets) over the bridge. null → identity unresolved (host
        //     already confirmed via isInMiniApp), name/pfp deferred.
        //   • /api/me — server-side primary-address resolution (Redis cached
        //     after first hit). It rides the JWT interceptor, which first awaits
        //     sdk.quickAuth.getToken() — ANOTHER unbounded host round-trip (via
        //     signIn). meController.abort() cannot cancel that token step (the
        //     underlying fetch hasn't started yet), so the race — not the
        //     AbortController — is what bounds a hung token acquisition; the
        //     AbortController still earns its keep by freeing a started-but-slow
        //     network request. null → no address (profile link + bell deferred),
        //     rest of identity still paints from sdk.context.user.
        const ctxOrNull = Promise.race([
          sdk.context,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), CONTEXT_TIMEOUT_MS)),
        ])
        const meController = new AbortController()
        const meTimeout = setTimeout(() => meController.abort(), ME_FETCH_TIMEOUT_MS)
        const meOrNull = Promise.race([
          fetch('/api/me', { signal: meController.signal }).catch(() => null),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), ME_FETCH_TIMEOUT_MS)),
        ])
        const [ctx, meResponse] = await Promise.all([ctxOrNull, meOrNull])
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
        // away, then aborts when our content actually responds. That
        // aborted animation produces "blank white space below the nav"
        // glitches that appear ONLY in Mini App and NOT in mobile web,
        // so we suppress the host gesture on our scroll surfaces. Per the
        // canonical SDK
        // (@farcaster/miniapp-core/src/actions/Ready.ts), this is
        // the documented mechanism for apps in our category.
        //
        // Trade-off: users can no longer swipe-down to dismiss the
        // Mini App — they use the host's X button. Acceptable for an
        // app with this much scrollable + interactive surface.
        //
        // Routed through dismissSplash (not a raw ready() call) so the
        // splashDismissed guard owns the single ready() invocation: if a
        // later throw lands us in the catch, its dismissSplash() is a no-op
        // rather than a duplicate ready().
        await dismissSplash()
        // Normal path reached ready() in time — retire the watchdog so it
        // doesn't fire a redundant (no-op) ready() later.
        if (splashWatchdog) clearTimeout(splashWatchdog)
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
        // any in-flight action. The same eligibility (cached here) also
        // gates the post-first-mint trigger via maybePromptCollectNotifs.
        const added = ctx?.client?.added === true
        const notificationsEnabled = !!ctx?.client?.notificationDetails
        addEligibilityRef.current = { added, notificationsEnabled }
        if (!added && !notificationsEnabled) {
          const opens = bumpAndReadOpenCount()
          if (opens === PROMPT_TARGET_OPEN) showAddKismetPrompt()
        }
      } catch (err) {
        // Fail open — but ALWAYS dismiss the splash first. A throw before the
        // ready() call above would otherwise pin the host splash forever
        // (the #1 Mini App loading pitfall). Idempotent: a no-op if ready()
        // already ran.
        console.warn('[farcaster] mini app bootstrap failed', err)
        await dismissSplash()
      }
    })()

    return () => {
      cancelled = true
      teardownFetch?.()
      if (splashWatchdog) clearTimeout(splashWatchdog)
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
    () => ({ ...state, refreshIdentity, maybePromptCollectNotifs }),
    [state, refreshIdentity, maybePromptCollectNotifs],
  )
  return (
    <FarcasterContext.Provider value={value}>{children}</FarcasterContext.Provider>
  )
}
