'use client'

import { useCallback, useState } from 'react'
import { useAccount, useSignMessage } from 'wagmi'
import { toast } from 'sonner'
import { useAdmin } from '@/contexts/AdminContext'
import { toastError } from '@/lib/toast'
import {
  buildRaffleManageMessage,
  type RaffleAction,
} from '@/lib/raffleManageMessage'

interface ManageParams {
  collection: string
  tokenId: string
  address: string
  action: RaffleAction
  /** Signs the manage message (wagmi's signMessageAsync, or equivalent). */
  signMessage: (message: string) => Promise<string>
  winner?: string | null
  closeAt?: number | null
}

/**
 * Perform one signed raffle-management call against /api/raffle/manage:
 * fetch a single-use nonce, sign the manage message, POST. Throws on failure.
 * (Mint-time enabling doesn't come through here — the mint body carries
 * `enableRaffle` and lib/mint-proxy enables server-side, signature-free.)
 *
 * The route authorizes the caller per-moment (creator / moment admin / platform
 * admin) via the signed, nonce'd message — the same model as /api/distribute.
 */
async function performRaffleManage({
  collection,
  tokenId,
  address,
  action,
  signMessage,
  winner,
  closeAt,
}: ManageParams): Promise<Record<string, unknown>> {
  const nonceRes = await fetch(`/api/profile/${address}/nonce`)
  if (!nonceRes.ok) throw new Error('Could not fetch nonce')
  const { nonce } = (await nonceRes.json().catch(() => ({}))) as { nonce?: string }
  if (!nonce) throw new Error('Could not fetch nonce')

  const fields = {
    action,
    collection,
    tokenId,
    address,
    nonce,
    // Floor to match the server (the manage route floors body.closeAt) — a
    // fractional value would make the signed string diverge from the rebuild and
    // silently fail auth. Callers already pass integers; this is belt-and-braces.
    ...(action === 'enable' || action === 'setCloseAt'
      ? { closeAt: closeAt != null && Number.isFinite(closeAt) ? Math.floor(closeAt) : null }
      : {}),
    ...(action === 'drawAndEnd' ? { winner: winner ?? null } : {}),
  }
  const signature = await signMessage(buildRaffleManageMessage(fields))

  const res = await fetch('/api/raffle/manage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...fields, callerAddress: address, signature }),
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: string }
  if (!res.ok) throw new Error(data.error ?? 'Raffle update failed')
  return data
}

/**
 * Self-serve raffle management for one moment, used by the moment-page panel.
 * One wallet signature per action (these are infrequent). enable/disable also
 * sync the global raffle-enabled set so the owned-edition button swaps without a
 * reload.
 */
export function useRaffleManage(collection: string, tokenId: string) {
  const { address } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const { applyRaffleEnabled } = useAdmin()
  const [busy, setBusy] = useState(false)

  const run = useCallback(
    async (
      action: RaffleAction,
      extra?: { winner?: string | null; closeAt?: number | null },
    ): Promise<Record<string, unknown> | null> => {
      if (!address) {
        toast.error('Connect your wallet')
        return null
      }
      setBusy(true)
      try {
        const data = await performRaffleManage({
          collection,
          tokenId,
          address,
          action,
          signMessage: (m) => signMessageAsync({ message: m }),
          ...extra,
        })
        if (action === 'enable') applyRaffleEnabled(collection, tokenId, true)
        if (action === 'disable') applyRaffleEnabled(collection, tokenId, false)
        return data
      } catch (err) {
        toastError('Raffle', err)
        return null
      } finally {
        setBusy(false)
      }
    },
    [address, collection, tokenId, signMessageAsync, applyRaffleEnabled],
  )

  return {
    busy,
    enable: (closeAt: number | null) => run('enable', { closeAt }),
    disable: () => run('disable'),
    setCloseAt: (closeAt: number | null) => run('setCloseAt', { closeAt }),
    drawAndEnd: (winner?: string | null) => run('drawAndEnd', { winner: winner ?? null }),
    reopen: () => run('reopen'),
  }
}
