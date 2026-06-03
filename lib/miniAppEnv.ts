// Cheap, synchronous pre-flight shared by the wagmi config (to decide
// whether to register the Farcaster Mini App connector) and the
// FarcasterProvider bootstrap. Farcaster hosts always render Mini Apps in
// an iframe (web) or a React Native WebView (mobile), so a regular browser
// tab short-circuits to false without touching the SDK.
//
// Coinbase WebView (Base App + Coinbase Wallet mobile dapp browser) is
// explicitly excluded — those are embedded WebViews but NOT Farcaster
// hosts. The Base App dropped the Mini App spec on April 9, 2026 (per
// docs.base.org/apps/guides/migrate-to-standard-web-app) and now loads
// apps as standard web pages with `window.ethereum` injected (EIP-6963
// advertises `rdns: app.base.account` / `com.coinbase.wallet`); the
// Coinbase Wallet mobile browser was never a Mini App host. In both,
// wagmi auto-discovers the injected provider via mipd, so the standard
// web wallet path connects with no prompt — registering the Farcaster
// connector would just burn an `eth_accounts` probe (and the 1.5s
// timeout in lib/wagmi.ts) before falling through, producing a visible
// flicker of failure where there should be a silent auto-connect.
export function isPotentialMiniAppEnv(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || ''
    // CipherBrowser is Coinbase's WebView UA suffix; the Base App UA
    // also carries "CoinbaseWallet" (the app was renamed from Coinbase
    // Wallet but kept the UA token). Either match → not a Mini App env.
    if (/CipherBrowser|CoinbaseWallet/i.test(ua)) return false
    const eth = (window as { ethereum?: { isCoinbaseWallet?: boolean } }).ethereum
    if (eth?.isCoinbaseWallet === true) return false
    const inIframe = window.self !== window.top
    const inReactNativeWebView =
      typeof (window as { ReactNativeWebView?: unknown }).ReactNativeWebView !==
      'undefined'
    return inIframe || inReactNativeWebView
  } catch {
    // Cross-origin iframe access throws on `window.top` — that itself is a
    // strong signal we're embedded. (Base App can't reach here: it's a
    // same-origin WebView so the UA short-circuit above runs first.)
    return true
  }
}
