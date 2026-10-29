// Runs lib/walletPrompt's guard against a scripted page (focus, visibility,
// timers) so the Zen/Rainbow fix can't silently regress: an extension wallet
// is only asked while this page has focus, a prompt that never answers gets
// a notice, and only a signature may be asked again.
//
// Run: node --experimental-strip-types scripts/verify-wallet-prompt.ts

import {
  STALL_NOTICE_MS,
  guardWalletPrompt,
  needsFocusGate,
  type WalletPromptEnv,
  type WalletPromptKind,
} from '../lib/walletPrompt.ts'

let failures = 0
const check = (name: string, cond: boolean): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}`)
    failures++
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

/** A page whose focus/visibility the test drives, plus manual timers. */
function makePage({ focused, gated = true }: { focused: boolean; gated?: boolean }) {
  const listeners = new Map<string, Set<() => void>>()
  const on = (t: string, fn: () => void) => {
    if (!listeners.has(t)) listeners.set(t, new Set())
    listeners.get(t)!.add(fn)
  }
  const off = (t: string, fn: () => void) => listeners.get(t)?.delete(fn)
  const fire = (t: string) => [...(listeners.get(t) ?? [])].forEach((fn) => fn())
  const doc = {
    focused,
    visibilityState: focused ? 'visible' : 'hidden',
    hasFocus() { return this.focused },
    addEventListener: on,
    removeEventListener: off,
  }
  const timers = new Map<number, () => void>()
  let nextTimer = 1
  const events: string[] = []
  let askAgain: (() => void) | undefined
  const env: WalletPromptEnv = {
    focus: gated ? { doc, win: { addEventListener: on, removeEventListener: off } } : null,
    setTimeout: (fn, ms) => {
      if (ms !== STALL_NOTICE_MS) throw new Error(`unexpected timer ${ms}`)
      const id = nextTimer++
      timers.set(id, fn)
      return id
    },
    clearTimeout: (id) => { timers.delete(id as number) },
    onStall: (info) => { events.push(`stall:${info.kind}:${info.askAgain ? 'ask-again' : 'no-ask-again'}`); askAgain = info.askAgain },
    onSettled: () => events.push('settled'),
    onWaitingForFocus: () => events.push('waiting-for-focus'),
    onFocused: () => events.push('focused'),
  }
  return {
    env,
    events,
    get askAgain() { return askAgain },
    get pendingTimers() { return timers.size },
    elapse() { const fns = [...timers.values()]; timers.clear(); fns.forEach((fn) => fn()) },
    focus() { doc.focused = true; doc.visibilityState = 'visible'; fire('visibilitychange'); fire('focus') },
    blur() { doc.focused = false; fire('blur') },
  }
}

/** A wallet request the test answers by hand. */
function makeRequest<T>() {
  const calls: { resolve: (v: T) => void; reject: (e: unknown) => void }[] = []
  const request = () => new Promise<T>((resolve, reject) => { calls.push({ resolve, reject }) })
  return { request, calls }
}

function track<T>(p: Promise<T>) {
  const s: { state: 'pending' | 'resolved' | 'rejected'; value?: unknown } = { state: 'pending' }
  p.then((v) => { s.state = 'resolved'; s.value = v }, (e) => { s.state = 'rejected'; s.value = e })
  return s
}

async function run(kind: WalletPromptKind, page: ReturnType<typeof makePage>) {
  const r = makeRequest<string>()
  const result = track(guardWalletPrompt(kind, r.request, page.env))
  await tick()
  return { r, result }
}

// ── which connectors are gated ──
const plain = { miniApp: false, coinbaseWebView: false }
check('extension (injected) wallet is gated', needsFocusGate('injected', plain))
check('WalletConnect is not gated', !needsFocusGate('walletConnect', plain))
check('Base Account is not gated', !needsFocusGate('baseAccount', plain))
check('no connector is not gated', !needsFocusGate(undefined, plain))
check('injected inside a Farcaster host is not gated', !needsFocusGate('injected', { miniApp: true, coinbaseWebView: false }))
check('injected in a Coinbase WebView is not gated', !needsFocusGate('injected', { miniApp: false, coinbaseWebView: true }))

// ── focus gate ──
{
  const page = makePage({ focused: true })
  const { r, result } = await run('transaction', page)
  check('focused page: wallet asked at once', r.calls.length === 1)
  r.calls[0].resolve('0xhash')
  await tick()
  check('focused page: the reply resolves the prompt', result.state === 'resolved' && result.value === '0xhash')
  check('settled once, stall timer cleared', page.events.join() === 'settled' && page.pendingTimers === 0)
}
{
  const page = makePage({ focused: false })
  const { r, result } = await run('signature', page)
  check('background tab: wallet NOT asked while unfocused', r.calls.length === 0 && result.state === 'pending')
  check('background tab: no stall clock before the wallet is asked', page.pendingTimers === 0)
  check('background tab: waiting-for-focus reported', page.events.includes('waiting-for-focus'))
  page.focus()
  await tick()
  check('background tab: wallet asked once the page has focus', r.calls.length === 1)
  check('background tab: focus regained is reported before the request', page.events.join() === 'waiting-for-focus,focused')
  r.calls[0].resolve('0xsig')
  await tick()
  check('background tab: reply resolves the prompt', result.state === 'resolved' && result.value === '0xsig')
}
{
  const page = makePage({ focused: false })
  const r = makeRequest<string>()
  const doc = page.env.focus!.doc as unknown as { focused: boolean; visibilityState: string }
  void guardWalletPrompt('transaction', r.request, page.env)
  doc.visibilityState = 'visible' // visible but another window has focus
  await tick()
  page.blur()
  await tick()
  check('visible but unfocused is still held back', r.calls.length === 0)
  page.focus()
  await tick()
  check('…and asked on focus', r.calls.length === 1)
}
{
  const page = makePage({ focused: false, gated: false })
  const { r } = await run('signature', page)
  check('ungated connector: asked at once even when unfocused', r.calls.length === 1)
}

// ── stall notice ──
{
  const page = makePage({ focused: true })
  const { r, result } = await run('transaction', page)
  page.elapse()
  check('transaction stall: notice shown without ask-again', page.events.join() === 'stall:transaction:no-ask-again')
  check('transaction stall: the prompt keeps waiting', result.state === 'pending' && r.calls.length === 1)
  r.calls[0].resolve('0xlate')
  await tick()
  check('transaction stall: a late reply still resolves and takes the notice down', result.state === 'resolved' && page.events.at(-1) === 'settled')
}
{
  const page = makePage({ focused: true })
  const { r, result } = await run('signature', page)
  page.elapse()
  check('signature stall: notice offers ask-again', page.events.join() === 'stall:signature:ask-again')
  page.askAgain!()
  await tick()
  check('ask again: a second request goes to the wallet', r.calls.length === 2)
  r.calls[0].reject(new Error('abandoned first request errored late'))
  await tick()
  check('ask again: the abandoned first request failing does not fail the prompt', result.state === 'pending')
  r.calls[1].resolve('0xsig2')
  await tick()
  check('ask again: the second answer resolves the prompt', result.state === 'resolved' && result.value === '0xsig2')
}
{
  const page = makePage({ focused: true })
  const { r, result } = await run('signature', page)
  page.elapse()
  page.askAgain!()
  await tick()
  r.calls[0].resolve('0xfirst')
  await tick()
  check('ask again: the original reply arriving first still wins', result.state === 'resolved' && result.value === '0xfirst')
  r.calls[1].resolve('0xsecond')
  await tick()
  check('…and the later one is ignored', result.value === '0xfirst')
}
{
  const page = makePage({ focused: true })
  const { r, result } = await run('signature', page)
  page.elapse()
  page.askAgain!()
  await tick()
  r.calls[1].reject(Object.assign(new Error('User rejected the request.'), { code: 4001 }))
  await tick()
  check('ask again: rejecting the re-ask rejects the prompt', result.state === 'rejected')
}
{
  const page = makePage({ focused: true })
  const { r, result } = await run('transaction', page)
  r.calls[0].reject(new Error('User rejected the request.'))
  await tick()
  check('rejection: rejects, settles, clears the stall clock', result.state === 'rejected' && page.events.join() === 'settled' && page.pendingTimers === 0)
}

// ── abort (the outcome was learned another way, e.g. the airdrop seen on-chain) ──
{
  const page = makePage({ focused: true })
  const r = makeRequest<string>()
  const ctl = new AbortController()
  const result = track(guardWalletPrompt('transaction', r.request, page.env, ctl.signal))
  await tick()
  ctl.abort(new Error('answered elsewhere'))
  await tick()
  check('abort: settles quietly and clears the stall clock', result.state === 'rejected' && page.events.join() === 'settled' && page.pendingTimers === 0)
  page.elapse()
  r.calls[0].resolve('0xlate')
  await tick()
  check('abort: no stall notice afterwards, a late reply changes nothing', page.events.join() === 'settled')
}
{
  const page = makePage({ focused: false })
  const r = makeRequest<string>()
  const ctl = new AbortController()
  const result = track(guardWalletPrompt('signature', r.request, page.env, ctl.signal))
  await tick()
  ctl.abort(new Error('gone'))
  await tick()
  page.focus()
  await tick()
  check('abort while waiting for focus: the wallet is never asked', r.calls.length === 0 && result.state === 'rejected')
}

console.log(failures === 0 ? '\nAll wallet-prompt checks passed.' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
