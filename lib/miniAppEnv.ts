// Cheap, synchronous pre-flight shared by the wagmi config (to decide
// whether to register the Farcaster Mini App connector) and the
// FarcasterProvider bootstrap. Farcaster hosts always render Mini Apps in
// an iframe (web) or a React Native WebView (mobile), so a regular browser
// tab short-circuits to false without touching the SDK.
//
// False positives are harmless: the Base App is also an embedded WebView
// but no longer speaks the Mini App protocol (it dropped the spec in April
// 2026), so the connector we register here is time-bounded and the SDK's
// own isInMiniApp() check returns false. False negatives would be bad
// (splash hangs forever) but the two checks below are exhaustive for every
// current Farcaster host.
export function isPotentialMiniAppEnv(): boolean {
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
