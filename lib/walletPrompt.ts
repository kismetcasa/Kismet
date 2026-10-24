// Guard for every wallet prompt the app raises (transactions and signatures).
// Pure: no wagmi, no sonner, no `document` at import time — the browser
// bindings are passed in, so scripts/verify-wallet-prompt.ts runs the real
// module in node. hooks/useWallet.ts is the only production caller.
//
// Why it exists (2026-10, Zen desktop + Rainbow extension): a mint signature
// and an airdrop both completed in the wallet — the airdrop landed on-chain —
// yet the page waited forever. Rainbow's background script sends each reply
// to the tab that is active in the last-focused window WHEN THE REQUEST
// ARRIVES (browser-extension src/core/messengers/internal/tab.ts,
// tabs.query({ active, lastFocusedWindow })), not to the tab that asked
// (sender.tab). A request raised while the artist looks at another tab or
// window — the mint signature fires on its own after a minutes-long upload —
// has its reply delivered there, and the page never hears back.
//
// Two layers:
//   1. Focus gate. An injected (extension) wallet is only asked while this
//      page has focus, so this tab IS the active tab of the focused window
//      when the request reaches the extension. A request raised in the
//      background waits until the artist comes back. A click always passes
//      at once (the click focused the page).
//   2. Stall notice. If the wallet still hasn't answered after
//      STALL_NOTICE_MS, say so, instead of a spinner that never ends. A
//      signature has no on-chain effect, so the notice can offer to ask again
//      (whichever answer arrives first wins). A transaction never gets that
//      offer — asking again could send it twice; the notice tells the artist
//      to check the wallet's activity first.

export type WalletPromptKind = 'transaction' | 'signature'

/** How long a prompt may go unanswered before the stall notice shows. Long
 *  enough to read a confirm screen; a reply normally lands within seconds of
 *  the click on Approve. */
export const STALL_NOTICE_MS = 60_000

/** The slice of `document` / `window` the focus gate reads. */
export interface FocusEnv {
  hasFocus(): boolean
  visibilityState: string
  addEventListener(type: string, fn: () => void): void
  removeEventListener(type: string, fn: () => void): void
}

export interface WalletPromptEnv {
  /** null: no gate (the connector's replies don't depend on which tab is focused). */
  focus: { doc: FocusEnv; win: Pick<FocusEnv, 'addEventListener' | 'removeEventListener'> } | null
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  /** Show the stall notice. `askAgain` is set for signatures only. */
  onStall(info: { kind: WalletPromptKind; askAgain?: () => void }): void
  /** The prompt settled (or is being asked again): take the notice down. */
  onSettled(): void
  /** The request is waiting for the page to regain focus. */
  onWaitingForFocus?(): void
  /** …and the page has it again; the request goes to the wallet now. */
  onFocused?(): void
}

/**
 * Which connectors need the focus gate: browser-extension wallets, whose
 * replies are routed by the extension. Not the Farcaster host or a Coinbase
 * WebView (an in-app browser has one page, and focus inside a host frame
 * isn't ours to read), not WalletConnect (replies ride the relay to this
 * page's own socket), not Base Account (its popup answers the opener that
 * opened it).
 */
export function needsFocusGate(
  connectorType: string | undefined,
  env: { miniApp: boolean; coinbaseWebView: boolean },
): boolean {
  return connectorType === 'injected' && !env.miniApp && !env.coinbaseWebView
}

export function pageHasFocus(doc: Pick<FocusEnv, 'hasFocus' | 'visibilityState'>): boolean {
  return doc.visibilityState === 'visible' && doc.hasFocus()
}

/** Resolves once the page is visible and focused (at once if it already is),
 *  or when `signal` aborts — the caller checks which. */
export function waitForPageFocus(
  focus: NonNullable<WalletPromptEnv['focus']>,
  signal?: AbortSignal,
): Promise<void> {
  const { doc, win } = focus
  if (pageHasFocus(doc) || signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      doc.removeEventListener('visibilitychange', check)
      win.removeEventListener('focus', check)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const check = () => {
      if (pageHasFocus(doc)) done()
    }
    doc.addEventListener('visibilitychange', check)
    win.addEventListener('focus', check)
    signal?.addEventListener('abort', done)
  })
}

/**
 * Runs one wallet prompt behind the focus gate, with the stall notice. For a
 * signature, the notice's "ask again" raises the same request again (behind
 * the gate); the first answer from any attempt wins, and a rejection only
 * counts from the latest attempt — an abandoned first request that errors
 * later must not fail a re-ask the artist is approving.
 *
 * `signal`: the caller learned the outcome another way (the airdrop sees its
 * mint on-chain) and stops listening. The guard settles quietly — no stall
 * notice later — and rejects with the abort reason; a request still waiting
 * for focus is never sent.
 */
export function guardWalletPrompt<T>(
  kind: WalletPromptKind,
  request: () => Promise<T>,
  env: WalletPromptEnv,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    let attempt = 0
    let timer: unknown = null

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      if (timer !== null) env.clearTimeout(timer)
      env.onSettled()
      fn()
    }

    if (signal) {
      if (signal.aborted) {
        finish(() => reject(signal.reason))
        return
      }
      signal.addEventListener('abort', () => finish(() => reject(signal.reason)), { once: true })
    }

    const run = async () => {
      const mine = ++attempt
      if (env.focus && !pageHasFocus(env.focus.doc)) {
        env.onWaitingForFocus?.()
        await waitForPageFocus(env.focus, signal)
        env.onFocused?.()
      }
      if (settled) return
      if (timer !== null) env.clearTimeout(timer)
      timer = env.setTimeout(() => {
        if (settled || mine !== attempt) return
        env.onStall({
          kind,
          askAgain:
            kind === 'signature'
              ? () => {
                  if (settled) return
                  env.onSettled()
                  void run()
                }
              : undefined,
        })
      }, STALL_NOTICE_MS)
      let result: T
      try {
        result = await request()
      } catch (err) {
        if (mine === attempt) finish(() => reject(err))
        return
      }
      finish(() => resolve(result))
    }

    void run()
  })
}
