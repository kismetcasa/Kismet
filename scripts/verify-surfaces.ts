// Verifies the client-surface classification predicates against real-world
// user agents and embed contexts — the platform matrix as CI checks.
//
// THE BUG IT GUARDS (VIDEO_PLAYBACK_RCA.md, mobile Mini App finding): the
// Farcaster MOBILE Mini App hosts the app in a React Native WebView whose
// custom UA carries no mobile tokens and which is NOT an iframe, so it fell
// through BOTH legs of every "constrained surface" check and was treated as
// an unconstrained desktop (18-item eager feed, uncapped video decoders, no
// proxy-first media). These checks pin each predicate's verdict per surface
// so a UA-regex tweak or a detection-leg removal can't silently reopen it.
//
// Run: node --experimental-strip-types scripts/verify-surfaces.ts

import { isMobileUaString, isWebKitOnlyUaString } from '../lib/deviceUA.ts'
import {
  isCoinbaseWebView,
  isPotentialMiniAppEnv,
  isReactNativeWebView,
} from '../lib/miniAppEnv.ts'

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

// ---- UA layer: one row per real-world surface ----
// columns: [label, ua, expectMobile, expectWebKitOnly]
const UA_MATRIX: Array<[string, string, boolean, boolean]> = [
  [
    'iPhone Safari',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    true,
    true,
  ],
  [
    'Chrome iOS (CriOS — WebKit underneath)',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/125.0.6422.80 Mobile/15E148 Safari/604.1',
    true,
    true,
  ],
  [
    'iOS WKWebView (default UA, no Safari token)',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
    true,
    true,
  ],
  [
    'Android Chrome',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.6422.113 Mobile Safari/537.36',
    true,
    false,
  ],
  [
    'desktop Chrome',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    false,
    false,
  ],
  [
    'desktop Safari (WebKit-only but NOT mobile)',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    false,
    true,
  ],
  [
    'desktop Edge (Chromium)',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0',
    false,
    false,
  ],
  [
    'RN WebView custom UA (the mobile Mini App gap: NO mobile tokens)',
    'Warpcast/1.92 CFNetwork/1494.0.7 Darwin/23.4.0',
    false,
    false,
  ],
]

for (const [label, ua, wantMobile, wantWebKit] of UA_MATRIX) {
  check(`${label}: mobile=${wantMobile}`, isMobileUaString(ua) === wantMobile, ua)
  check(`${label}: webkitOnly=${wantWebKit}`, isWebKitOnlyUaString(ua) === wantWebKit, ua)
}

// ---- embed-context layer: window/navigator stubs ----
// The predicates read globals at CALL time, so mutating stubs between checks
// exercises each context without re-importing modules.
const g = globalThis as Record<string, unknown>
const setContext = (opts: {
  ua?: string
  iframe?: boolean
  rnWebView?: boolean
  ethereum?: unknown
}): void => {
  const win: Record<string, unknown> = {}
  win.self = win
  win.top = opts.iframe ? {} : win
  if (opts.rnWebView) win.ReactNativeWebView = {}
  if (opts.ethereum !== undefined) win.ethereum = opts.ethereum
  g.window = win
  g.navigator = { userAgent: opts.ua ?? UA_MATRIX[4][1] } // default: desktop Chrome
}
const clearContext = (): void => {
  delete g.window
  delete g.navigator
}

// SSR safety: no window → everything false.
clearContext()
check('SSR: isReactNativeWebView false without window', isReactNativeWebView() === false)
check('SSR: isPotentialMiniAppEnv false without window', isPotentialMiniAppEnv() === false)

// Plain desktop tab: nothing matches.
setContext({})
check('top-level tab: not RN WebView', isReactNativeWebView() === false)
check('top-level tab: not a potential Mini App env', isPotentialMiniAppEnv() === false)

// Desktop Mini App: iframe leg.
setContext({ iframe: true })
check('iframe (desktop Mini App): potential Mini App env', isPotentialMiniAppEnv() === true)
check('iframe (desktop Mini App): not RN WebView', isReactNativeWebView() === false)

// Mobile Mini App: RN WebView leg — THE case that fell through before.
setContext({ rnWebView: true, ua: UA_MATRIX[7][1] })
check('RN WebView (mobile Mini App): isReactNativeWebView', isReactNativeWebView() === true)
check('RN WebView (mobile Mini App): potential Mini App env', isPotentialMiniAppEnv() === true)
check(
  'RN WebView UA alone would NOT be classified mobile (why the third leg exists)',
  isMobileUaString(UA_MATRIX[7][1]) === false,
)

// Coinbase/Base mobile in-app browser: excluded from the FC bootstrap but
// STILL a constrained phone webview via the RN leg.
setContext({
  rnWebView: true,
  ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 CipherBrowser/5.0',
})
check('Coinbase webview: isCoinbaseWebView', isCoinbaseWebView() === true)
check('Coinbase webview: excluded from FC Mini App bootstrap', isPotentialMiniAppEnv() === false)
check('Coinbase webview: still constrained via the RN WebView leg', isReactNativeWebView() === true)

clearContext()

if (failures > 0) {
  console.error(`\n${failures} surface-classification check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll surface-classification checks passed.')
