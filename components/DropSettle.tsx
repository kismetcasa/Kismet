'use client'

import { useState } from 'react'
import { usePublicClient } from 'wagmi'
import { base } from 'wagmi/chains'
import { toast } from 'sonner'
import type { MintBody } from '@/lib/intent'
import { useAirdrop } from '@/hooks/useAirdrop'
import { useEnsureConnected } from '@/hooks/useEnsureConnected'
import { useIntentAuth } from '@/hooks/useIntentAuth'
import { useUploadSession } from '@/hooks/useUploadSession'
import { useEnsureBase } from '@/lib/useEnsureBase'
import { notifyAirdropWithBackoff } from '@/lib/notifyAirdrop'
import { TERMINAL_TOAST_DURATION_MS, toastError } from '@/lib/toast'

type Step = 'idle' | 'preparing' | 'minting' | 'airdropping' | 'recording'

interface Minted {
  collection: `0x${string}`
  tokenId: string
}

const STEP_LABEL: Record<Step, string> = {
  idle: '',
  preparing: 'Preparing the edition…',
  minting: 'Minting the edition…',
  airdropping: 'Confirm the airdrop in your wallet…',
  recording: 'Delivering…',
}

// The server's view of Base can trail the wallet's by a block or two.
const RECORD_RETRY_MS = [0, 2_000, 4_000, 8_000, 15_000]

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = (await res.json().catch(() => ({}))) as { error?: string; detail?: string }
  if (!res.ok) throw new Error(json.error ?? json.detail ?? `Request failed (${res.status})`)
  return json as T
}

/**
 * Settling a closed drop, as one button the artist can press again at any
 * point: every step is recorded server-side and resumes where it stopped.
 *
 *   1. …/settle/prepare — the edition's mint is built (artwork copied from
 *      Swarm to Arweave), sized to the claims plus the artist's copy, with
 *      its sale closed at creation.
 *   2. One free signature — the mint runs through Kismet's relay
 *      (…/settle/mint → the same sponsored mint as /api/mint).
 *   3. One transaction — the airdrop to every claimer (useAirdrop: Zora's
 *      adminMint, no mint fee, a little Base gas), confirmed from the chain.
 *   4. …/settle — the delivery is verified from Base and recorded on Arkiv;
 *      the airdrop is also recorded like any Kismet airdrop, so every
 *      collector gets the usual airdrop notification.
 */
export function DropSettle({
  dropKey,
  artist,
  claimCount,
  editionSize,
  onDelivered,
}: {
  dropKey: string
  artist: string
  claimCount: number
  /** lib/drops settlementRecipients: each claim's owner, once, plus the artist. */
  editionSize: number
  onDelivered: () => void
}) {
  const ensureConnected = useEnsureConnected()
  const { ensureSession } = useUploadSession()
  const { signMintIntent } = useIntentAuth()
  const ensureBase = useEnsureBase()
  const { airdrop } = useAirdrop()
  const publicClient = usePublicClient({ chainId: base.id })
  const [step, setStep] = useState<Step>('idle')

  async function record(txHash?: `0x${string}`): Promise<boolean> {
    for (const delay of txHash ? RECORD_RETRY_MS : [0]) {
      if (delay) await new Promise((r) => setTimeout(r, delay))
      const { delivered } = await post<{ delivered: boolean }>(`/api/drops/${dropKey}/settle`, txHash ? { txHash } : {})
      if (delivered) return true
    }
    return false
  }

  async function deliver() {
    if (step !== 'idle') return
    const id = 'settle-drop'
    const account = await ensureConnected()
    if (!account) return
    if (account.toLowerCase() !== artist) {
      toast.error('Switch to the wallet that opened this drop', { id, duration: TERMINAL_TOAST_DURATION_MS })
      return
    }
    try {
      await ensureSession()
      setStep('preparing')
      toast.loading(STEP_LABEL.preparing, { id, description: 'Copying the artwork to Arweave — minted art is permanent.' })
      const prepared = await post<{ body: MintBody; recipients: `0x${string}`[]; minted: Minted | null }>(
        `/api/drops/${dropKey}/settle/prepare`,
        {},
      )

      let minted = prepared.minted
      if (minted) {
        // Minted on an earlier visit — the airdrop may have landed too.
        if (await record()) return finish(id)
      } else {
        setStep('minting')
        await ensureBase()
        toast.loading('Confirm in wallet…', {
          id,
          description: 'Free signature — your wallet may warn it can’t preview it; the mint runs through Kismet’s relay.',
        })
        const { intent } = await signMintIntent(prepared.body, 'mint')
        toast.loading(STEP_LABEL.minting, { id, description: undefined })
        minted = await post<Minted>(`/api/drops/${dropKey}/settle/mint`, { intent })
      }

      setStep('airdropping')
      const n = prepared.recipients.length
      toast.loading(`Confirm the airdrop to ${n} ${n === 1 ? 'wallet' : 'wallets'}…`, {
        id,
        description: 'One transaction — no mint fee, only a little Base gas.',
      })
      const txHash = await airdrop({
        collectionAddress: minted.collection,
        tokenId: BigInt(minted.tokenId),
        recipients: prepared.recipients,
      })

      setStep('recording')
      toast.loading(STEP_LABEL.recording, { id, description: 'Waiting for Base, then recording the delivery on Arkiv.' })
      const receipt = await publicClient?.waitForTransactionReceipt({ hash: txHash }).catch(() => null)
      if (receipt?.status === 'reverted') {
        throw new Error('The airdrop failed on Base, so nothing was delivered — press Deliver to try again')
      }
      void notifyAirdropWithBackoff({
        sender: account,
        collectionAddress: minted.collection,
        tokenId: minted.tokenId,
        recipients: prepared.recipients,
        txHash,
      })
      if (!(await record(txHash))) {
        throw new Error('The airdrop is on its way — press Deliver again in a minute to finish recording it')
      }
      finish(id)
    } catch (err) {
      toastError('Delivery', err, { id })
    } finally {
      setStep('idle')
    }
  }

  function finish(id: string) {
    toast.success('Delivered', {
      id,
      description: 'Every claimer has the artwork in their wallet.',
      duration: TERMINAL_TOAST_DURATION_MS,
    })
    onDelivered()
  }

  return (
    <div className="border border-accent/40 bg-accent/5 p-4 flex flex-col gap-3">
      <h2 className="text-xs font-mono uppercase tracking-widest text-ink">Deliver this drop</h2>
      <p className="text-xs text-muted">
        {claimCount} {claimCount === 1 ? 'collector' : 'collectors'} claimed. Delivering mints an edition of {editionSize}{' '}
        (one per claim, plus yours) and airdrops it to every claimer: a free signature, then one transaction with no
        mint fee — only a little Base gas.
      </p>
      <button
        type="button"
        onClick={deliver}
        disabled={step !== 'idle'}
        className="w-full py-3 text-xs font-mono tracking-widest uppercase btn-accent"
      >
        {step === 'idle' ? `Deliver to ${claimCount} ${claimCount === 1 ? 'collector' : 'collectors'}` : STEP_LABEL[step]}
      </button>
      <p className="text-[11px] text-muted">
        Interrupted? Press it again — it picks up where it stopped.
      </p>
    </div>
  )
}
