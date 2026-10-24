'use client'

// The app's wallet-prompt hooks. Same names and shapes as wagmi's, with every
// prompt routed through lib/walletPrompt's guard (focus gate + stall notice —
// the file comment there has the incident). eslint.config.mjs forbids
// importing these hooks from 'wagmi' anywhere else, so a new prompt can't
// skip the guard.
//
// Only the *Async functions are exposed: the fire-and-forget variants
// (writeContract, signMessage, …) would need their own guarded twin, and no
// caller uses them — leaving them out makes a new use a type error instead
// of a silent bypass.

import { useCallback, useRef } from 'react'
import {
  useAccount,
  useSendCalls as useWagmiSendCalls,
  useSendTransaction as useWagmiSendTransaction,
  useSignMessage as useWagmiSignMessage,
  useSignTypedData as useWagmiSignTypedData,
  useWriteContract as useWagmiWriteContract,
} from 'wagmi'
import { toast } from 'sonner'
import { guardWalletPrompt, needsFocusGate, type WalletPromptEnv, type WalletPromptKind } from '@/lib/walletPrompt'
import { isCoinbaseWebView, isPotentialMiniAppEnv } from '@/lib/miniAppEnv'

const STALL_TOAST_ID = 'wallet-stall'
const FOCUS_TOAST_ID = 'wallet-focus'

function walletPromptEnv(connectorType: string | undefined): WalletPromptEnv {
  const gated = needsFocusGate(connectorType, {
    miniApp: isPotentialMiniAppEnv(),
    coinbaseWebView: isCoinbaseWebView(),
  })
  return {
    focus: gated ? { doc: document, win: window } : null,
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
    onStall: ({ kind, askAgain }) => {
      toast.warning('Your wallet hasn’t answered this page yet', {
        id: STALL_TOAST_ID,
        duration: Infinity,
        description:
          kind === 'transaction'
            ? 'If you already approved, it may have gone through — check your wallet’s activity before trying again.'
            : 'If you already signed, the reply didn’t reach this tab. Ask again to sign once more.',
        ...(askAgain ? { action: { label: 'Ask again', onClick: askAgain } } : {}),
      })
    },
    onSettled: () => {
      toast.dismiss(STALL_TOAST_ID)
      toast.dismiss(FOCUS_TOAST_ID)
    },
    // Visible but not focused — another window (often the wallet's own popup,
    // closed without handing focus back) has it. The artist is looking at
    // this page, so say what moves it on. A hidden page shows nothing: the
    // request simply waits until the artist comes back.
    onWaitingForFocus: () => {
      if (document.visibilityState !== 'visible') return
      toast.info('Click this page to continue to your wallet', { id: FOCUS_TOAST_ID, duration: Infinity })
    },
    onFocused: () => toast.dismiss(FOCUS_TOAST_ID),
  }
}

// One guard per hook instance. `abortPrompts` stands down every prompt this
// instance has in flight: for a caller that learned the outcome another way
// (useAirdrop sees its mint on-chain), so no stall notice follows a success.
function useGuard() {
  const { connector } = useAccount()
  const connectorType = connector?.type
  const inFlight = useRef(new Set<AbortController>())
  const guard = useCallback(
    <T>(kind: WalletPromptKind, request: () => Promise<T>) => {
      const controller = new AbortController()
      inFlight.current.add(controller)
      return guardWalletPrompt(kind, request, walletPromptEnv(connectorType), controller.signal).finally(() =>
        inFlight.current.delete(controller),
      )
    },
    [connectorType],
  )
  const abortPrompts = useCallback(() => {
    for (const c of inFlight.current) c.abort(new DOMException('Answered elsewhere', 'AbortError'))
    inFlight.current.clear()
  }, [])
  return { guard, abortPrompts }
}

export function useWriteContract(...args: Parameters<typeof useWagmiWriteContract>) {
  const { writeContract: _w, ...rest } = useWagmiWriteContract(...args)
  const { guard, abortPrompts } = useGuard()
  const inner = rest.writeContractAsync
  const writeContractAsync = useCallback(
    (...a: Parameters<typeof inner>) => guard('transaction', () => inner(...a)),
    [guard, inner],
  ) as typeof inner
  return { ...rest, writeContractAsync, abortPrompts }
}

export function useSendTransaction(...args: Parameters<typeof useWagmiSendTransaction>) {
  const { sendTransaction: _s, ...rest } = useWagmiSendTransaction(...args)
  const { guard, abortPrompts } = useGuard()
  const inner = rest.sendTransactionAsync
  const sendTransactionAsync = useCallback(
    (...a: Parameters<typeof inner>) => guard('transaction', () => inner(...a)),
    [guard, inner],
  ) as typeof inner
  return { ...rest, sendTransactionAsync, abortPrompts }
}

export function useSendCalls(...args: Parameters<typeof useWagmiSendCalls>) {
  const { sendCalls: _s, ...rest } = useWagmiSendCalls(...args)
  const { guard, abortPrompts } = useGuard()
  const inner = rest.sendCallsAsync
  const sendCallsAsync = useCallback(
    (...a: Parameters<typeof inner>) => guard('transaction', () => inner(...a)),
    [guard, inner],
  ) as typeof inner
  return { ...rest, sendCallsAsync, abortPrompts }
}

export function useSignMessage(...args: Parameters<typeof useWagmiSignMessage>) {
  const { signMessage: _s, ...rest } = useWagmiSignMessage(...args)
  const { guard, abortPrompts } = useGuard()
  const inner = rest.signMessageAsync
  const signMessageAsync = useCallback(
    (...a: Parameters<typeof inner>) => guard('signature', () => inner(...a)),
    [guard, inner],
  ) as typeof inner
  return { ...rest, signMessageAsync, abortPrompts }
}

export function useSignTypedData(...args: Parameters<typeof useWagmiSignTypedData>) {
  const { signTypedData: _s, ...rest } = useWagmiSignTypedData(...args)
  const { guard, abortPrompts } = useGuard()
  const inner = rest.signTypedDataAsync
  const signTypedDataAsync = useCallback(
    (...a: Parameters<typeof inner>) => guard('signature', () => inner(...a)),
    [guard, inner],
  ) as typeof inner
  return { ...rest, signTypedDataAsync, abortPrompts }
}
