'use client'

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

type FarcasterContextValue = {
  /** True only after the Farcaster SDK confirms we're inside a host. */
  isInMiniApp: boolean
  /** True after sdk.actions.ready() has resolved successfully. */
  ready: boolean
}

const FarcasterContext = createContext<FarcasterContextValue>({
  isInMiniApp: false,
  ready: false,
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

export function FarcasterProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<FarcasterContextValue>({
    isInMiniApp: false,
    ready: false,
  })

  useEffect(() => {
    if (!isPotentialMiniAppEnv()) {
      // Regular web user — never load the Mini App SDK, never call ready().
      // Desktop/mobile web behavior is unchanged.
      return
    }

    let cancelled = false

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

        setState({ isInMiniApp: true, ready: true })
      } catch (err) {
        // Fail open: if anything in the bootstrap throws, behave as a
        // regular web visit so the page still works.
        console.warn('[farcaster] mini app bootstrap failed', err)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <FarcasterContext.Provider value={state}>{children}</FarcasterContext.Provider>
  )
}
