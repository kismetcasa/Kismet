// Cheap, synchronous environment pre-flights shared by the wagmi config and
// the FarcasterProvider bootstrap — no SDK, no async, safe to call on render.

// True only inside the Base App's (or Coinbase Wallet's) *mobile in-app
// browser*, which injects a wallet that discovery can't surface (reached via a
// plain injected() connector — see lib/wagmi.ts and hooks/useBaseAppAutoConnect).
//
// Primary signal: Coinbase's WebView UA token ("CipherBrowser"; the Base App,
// renamed from Coinbase Wallet, kept "CoinbaseWallet"). Fallback: the injected
// isCoinbaseWallet flag, gated to mobile — the desktop *extension* sets that
// flag too, but extensions can't run on mobile, so (flag && mobile) still pins
// the in-app browser (surviving a UA-token rename) while the desktop extension,
// where an on-load auto-connect would pop an unsolicited prompt, never matches.
export function isCoinbaseWebView(): boolean {
  if (typeof window === 'undefined') return false
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || ''
  if (/CipherBrowser|CoinbaseWallet/i.test(ua)) return true
  const eth = (window as { ethereum?: { isCoinbaseWallet?: boolean } }).ethereum
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua)
  return eth?.isCoinbaseWallet === true && isMobile
}

// True only for a *potential* Farcaster Mini App host: an embedded context
// (iframe on web, RN WebView on mobile) that is NOT a Coinbase context. A
// regular browser tab short-circuits to false without touching the SDK; the
// FarcasterProvider bootstrap then confirms with sdk.isInMiniApp().
export function isPotentialMiniAppEnv(): boolean {
  if (typeof window === 'undefined') return false
  try {
    // The ONLY Coinbase context we hard-exclude is the *mobile in-app browser*,
    // detected by UA (isCoinbaseWebView) — it dropped the Mini App spec, so
    // registering the FC connector there would just burn its eth_accounts probe
    // (and the 1.5s timeout in lib/wagmi.ts) before falling through.
    //
    // We deliberately do NOT exclude on the bare window.ethereum.isCoinbaseWallet
    // flag. A browser *extension* (Coinbase Wallet, and wallets that mirror the
    // flag) injects window.ethereum into EVERY frame — including a genuine
    // Farcaster *desktop* Mini App iframe. Excluding on that flag classified a
    // real FC desktop host as "not a Mini App", so FarcasterProvider bailed
    // before sdk.actions.ready() and the host splash hung forever. Extensions
    // only exist on desktop, which is exactly why that bug was desktop-only.
    // The cheap pre-flight stays permissive (iframe / RN WebView); the async
    // sdk.isInMiniApp() context probe in FarcasterProvider is the authoritative
    // confirmation that we're inside a real host.
    if (isCoinbaseWebView()) return false
    const inIframe = window.self !== window.top
    const inReactNativeWebView =
      typeof (window as { ReactNativeWebView?: unknown }).ReactNativeWebView !==
      'undefined'
    return inIframe || inReactNativeWebView
  } catch {
    // Cross-origin iframe access throws on `window.top` — that itself is a
    // strong signal we're embedded. (A Coinbase WebView can't reach here: it's
    // a same-origin WebView so the UA short-circuit above runs first.)
    return true
  }
}
