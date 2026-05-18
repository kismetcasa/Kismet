'use client'

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useAccount, useConnect } from 'wagmi'
import { toast } from 'sonner'

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
}

const FarcasterContext = createContext<FarcasterContextValue>({
  isInMiniApp: false,
  ready: false,
  identity: null,
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

export function FarcasterProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<FarcasterContextValue>({
    isInMiniApp: false,
    ready: false,
    identity: null,
  })

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

        // CRITICAL: without this call the host shows its splash screen
        // forever. Has to come after the rest of the React tree has
        // rendered, which is guaranteed because this useEffect runs
        // after first paint of the FarcasterProvider's children.
        await sdk.actions.ready()
        if (cancelled) return

        // Wire the host's back control (swipe-from-edge on iOS, hardware
        // back on Android, header button on web) to the browser's
        // navigation history. Without this, the host's default behavior
        // is to dismiss the entire Mini App on a back gesture — which
        // breaks the user's expectation when they're mid-flow inside
        // Kismet (e.g. mint → moment detail → back). The SDK uses the
        // modern Navigation API where available and falls back to
        // History API otherwise. Silent fallback for older hosts that
        // don't expose the back capability at all.
        try {
          await sdk.back.enableWebNavigation()
        } catch {
          // Older host — leave default close-on-swipe gestures in place.
        }
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

        // Set partial identity immediately so UI can paint with username +
        // pfp from host context. The address comes from a server round-trip
        // (FID → primary address resolution) and is filled in below.
        setState({
          isInMiniApp: true,
          ready: true,
          identity: hostIdentity,
        })

        // Device chrome insets — notch, Dynamic Island, home indicator,
        // curved edges. The host pushes exact pixel values via context
        // because CSS env(safe-area-inset-*) is unreliable inside WebViews
        // (the host controls the viewport, not us). Setting them as CSS
        // custom properties on :root means every consumer (Nav, layout
        // <main>, NotificationModal) reads them via var() without prop
        // drilling or re-renders. Defaults stay at 0 in globals.css for
        // web users — those `var()`s evaluate to 0 and nothing shifts.
        const insets = ctx?.client?.safeAreaInsets
        if (insets) {
          const root = document.documentElement
          root.style.setProperty('--safe-top', `${insets.top}px`)
          root.style.setProperty('--safe-bottom', `${insets.bottom}px`)
          root.style.setProperty('--safe-left', `${insets.left}px`)
          root.style.setProperty('--safe-right', `${insets.right}px`)
        }

        // addMiniApp prompt: only on the user's 2nd confirmed open, and
        // only when they haven't already added or enabled notifications.
        // Fires as a non-modal sonner toast so it can't interfere with
        // any in-flight action (mint, follow, etc). The host's own
        // consent sheet handles the actual permission ask.
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

  return (
    <FarcasterContext.Provider value={state}>{children}</FarcasterContext.Provider>
  )
}
