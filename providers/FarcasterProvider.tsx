'use client'

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

export type FarcasterIdentity = {
  /** Numeric Farcaster ID — comes from `sdk.context.user.fid` and the verified JWT. */
  fid: number
  /** Username (`@alice`) from the host context, when set. */
  username: string | null
  /** Free-text display name from the host context, when set. */
  displayName: string | null
  /** Profile picture URL from the host context, when set. */
  pfpUrl: string | null
  /** Server-resolved primary Ethereum address bound to this FID. */
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

export function FarcasterProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<FarcasterContextValue>({
    isInMiniApp: false,
    ready: false,
    identity: null,
  })

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
        if (hostIdentity) {
          setState({ isInMiniApp: true, ready: true, identity: hostIdentity })
        } else {
          setState({ isInMiniApp: true, ready: true, identity: null })
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
                setState({
                  isInMiniApp: true,
                  ready: true,
                  identity: { ...hostIdentity, address: body.address },
                })
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
  }, [])

  return (
    <FarcasterContext.Provider value={state}>{children}</FarcasterContext.Provider>
  )
}
