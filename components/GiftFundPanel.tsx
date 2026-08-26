'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAccount, usePublicClient, useSendTransaction } from 'wagmi'
import { base } from 'wagmi/chains'
import { formatEther, parseEther } from 'viem'
import { toast } from 'sonner'
import { shortAddress } from '@/lib/inprocess'
import { useEnsureBase } from '@/lib/useEnsureBase'
import { useEnsureConnected } from '@/hooks/useEnsureConnected'
import { MIN_CONTRIBUTION_WEI } from '@/lib/giftFund'

/**
 * The Gift Fund panel — an active campaign's progress bar and backing flow
 * (model in lib/giftFund: reimbursement, artist already gifted, backers send
 * plain ETH to the organizer).
 *
 * Renders nothing when the artwork has no active campaign, so it can mount
 * unconditionally on the surfaces that opt in (Patron artwork pages first —
 * one cheap GET per view). Backing is the universal wallet primitive: a bare
 * ETH send — no approvals, no signatures beyond the transfer — then the tx
 * hash is claimed against the campaign. The claim route derives the backer
 * from the chain, so the POST carries no identity to get wrong; retries
 * absorb RPC indexing lag exactly like /api/collect's recording loop.
 */

interface Contribution {
  contribTx: string
  backer: string
  amountWei: string
}

interface Campaign {
  giftTx: string
  organizer: string
  recipient: string
  goalWei: string
  raisedWei: string
  backers: number
  note: string
  closesAtMs: number
  status: 'open' | 'funded' | 'expired'
  progressPercent: number
  contributions: Contribution[]
}

const fmtEth = (wei: string) => {
  const n = Number(formatEther(BigInt(wei || '0')))
  // Display-grade: 4 decimals covers the realistic contribution range.
  return `${n.toFixed(n >= 0.01 ? 3 : 4)} ETH`
}

export function GiftFundPanel({
  collection,
  tokenId,
  refreshNonce = 0,
}: {
  collection: string
  tokenId: string
  /** Bump to force a refetch (e.g. right after this page opened a fund). */
  refreshNonce?: number
}) {
  const { address: connected } = useAccount()
  const publicClient = usePublicClient({ chainId: base.id })
  const { sendTransactionAsync } = useSendTransaction()
  const ensureBase = useEnsureBase()
  const ensureConnected = useEnsureConnected()

  const [campaign, setCampaign] = useState<Campaign | null>(null)
  const [amount, setAmount] = useState('')
  const [backing, setBacking] = useState(false)

  const refetch = useCallback(() => {
    let cancelled = false
    fetch(`/api/gift-fund?collection=${collection}&tokenId=${tokenId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d) setCampaign(d.campaign ?? null)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [collection, tokenId])

  useEffect(() => refetch(), [refetch, refreshNonce])

  if (!campaign) return null

  const isOrganizer = !!connected && connected.toLowerCase() === campaign.organizer.toLowerCase()
  const open = campaign.status === 'open'

  async function handleBack() {
    if (backing || !open || !campaign) return
    let valueWei: bigint
    try {
      valueWei = parseEther(amount.trim() as `${number}`)
    } catch {
      toast.error('Enter an ETH amount')
      return
    }
    if (valueWei <= 0n) {
      toast.error('Enter an ETH amount')
      return
    }
    // Server-mirrored minimum, checked BEFORE money moves: a below-minimum
    // send would arrive at the organizer but be refused credit — the one
    // failure where the backer loses something, so it must be impossible to
    // reach from this form.
    if (valueWei < MIN_CONTRIBUTION_WEI) {
      toast.error('Minimum contribution is 0.0001 ETH')
      return
    }
    const account = await ensureConnected()
    if (!account) return
    if (account.toLowerCase() === campaign.organizer.toLowerCase()) {
      toast.error('You are the organizer — backers reimburse you')
      return
    }
    setBacking(true)
    try {
      await ensureBase()
      toast.loading('Confirm the transfer in your wallet…', { id: 'gift-fund' })
      const hash = await sendTransactionAsync({
        chainId: base.id,
        to: campaign.organizer as `0x${string}`,
        value: valueWei,
      })
      toast.loading('Confirming on-chain…', { id: 'gift-fund' })
      if (publicClient) {
        await publicClient.waitForTransactionReceipt({ hash, timeout: 300_000 })
      }
      // Claim with bounded retries — the server reads the tx by hash and can
      // lag the wallet's receipt by a beat (same posture as /api/collect).
      toast.loading('Recording…', { id: 'gift-fund' })
      let ok = false
      let lastMsg = ''
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 800 * attempt))
        try {
          const res = await fetch('/api/gift-fund/claim', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ campaignId: campaign.giftTx, txHash: hash }),
            keepalive: true,
          })
          if (res.ok) ok = true
          else lastMsg = ((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? ''
        } catch {
          // retry
        }
      }
      if (ok) {
        toast.success('Backed!', { id: 'gift-fund' })
        setAmount('')
        refetch()
      } else {
        // The transfer itself succeeded — say so, with the server's reason.
        toast.error(lastMsg || 'Sent, but recording failed — it can be claimed later', {
          id: 'gift-fund',
        })
      }
    } catch {
      toast.error('Transfer cancelled', { id: 'gift-fund' })
    } finally {
      setBacking(false)
    }
  }

  return (
    <div className="border border-line p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-mono text-muted uppercase tracking-widest">gift fund</h3>
        <span className="text-[10px] font-mono text-muted">
          {campaign.status === 'funded'
            ? 'funded'
            : campaign.status === 'expired'
              ? 'closed'
              : `ends ${new Date(campaign.closesAtMs).toLocaleDateString()}`}
        </span>
      </div>
      <p className="text-[11px] font-mono text-dim leading-relaxed">
        {shortAddress(campaign.organizer)} gifted this artwork to {shortAddress(campaign.recipient)}
        {' — backers chip in to reimburse the gift.'}
        {campaign.note ? ` “${campaign.note}”` : ''}
      </p>
      <div>
        <div className="h-1.5 bg-raised overflow-hidden">
          <div
            className="h-full transition-[width]"
            // The shared gradient var (single source with .accent-grad /
            // .accent-grad-hover) — no bg utility class exists for it.
            style={{ width: `${campaign.progressPercent}%`, background: 'var(--accent-grad)' }}
          />
        </div>
        <div className="mt-1.5 flex justify-between text-[10px] font-mono text-muted">
          <span>
            {fmtEth(campaign.raisedWei)} of {fmtEth(campaign.goalWei)}
          </span>
          <span>
            {campaign.backers} backer{campaign.backers === 1 ? '' : 's'}
          </span>
        </div>
      </div>
      {open && !isOrganizer && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.01"
            disabled={backing}
            aria-label="amount in ETH"
            className="w-24 border border-line bg-transparent px-3 py-1.5 text-xs font-mono text-ink placeholder:text-muted focus:outline-none focus:border-dim disabled:opacity-60"
          />
          <button
            onClick={() => void handleBack()}
            disabled={backing}
            className={`border border-line px-3 py-1.5 text-xs font-mono uppercase tracking-widest transition-colors ${
              backing ? 'opacity-70 cursor-wait' : 'accent-grad-hover'
            }`}
          >
            <span className={backing ? undefined : 'accent-grad'}>
              {backing ? 'backing…' : 'back this gift'}
            </span>
          </button>
        </div>
      )}
      {campaign.contributions.length > 0 && (
        <div className="flex flex-col gap-1">
          {campaign.contributions.slice(0, 5).map((c) => (
            <div key={c.contribTx} className="flex justify-between text-[10px] font-mono text-muted">
              <span>{shortAddress(c.backer)}</span>
              <span>{fmtEth(c.amountWei)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
