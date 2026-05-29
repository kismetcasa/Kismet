'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAccount, useReadContracts } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { toast } from 'sonner'
import { isAddress } from 'viem'
import { Plus, X } from 'lucide-react'
import { shortAddress, type Moment } from '@/lib/inprocess'
import { MomentImage } from './MomentImage'
import { toastError } from '@/lib/toast'
import { useGrantPermission } from '@/hooks/useGrantPermission'
import { useAirdrop } from '@/hooks/useAirdrop'
import { COLLECTION_ABI } from '@/lib/collections'
import { hasAdminBit, hasMinterBit } from '@/lib/permissions'
import { MAX_AIRDROP_RECIPIENTS } from '@/lib/config'
import { notifyAirdropWithBackoff } from '@/lib/notifyAirdrop'

interface AirdropFormProps {
  moments: Moment[]
  loadingMoments: boolean
}

export function AirdropForm({ moments, loadingMoments }: AirdropFormProps) {
  const { address, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  // Client-side airdrop — the user's EOA calls Zora's adminMint
  // directly (single recipient) or via the inherited multicall
  // (batched). Bypasses inprocess's relay entirely so we're not
  // chasing whichever wallet they route under our shared API key.
  const { airdrop } = useAirdrop()
  // Per-token ADMIN delegation: lets the moment admin grant another
  // wallet permission to airdrop this specific moment from their own
  // wallet. Same useGrantPermission primitive that powers the
  // collection-page authorize banners; just pointed at a delegate.
  const {
    grant: grantDelegate,
    reset: resetDelegateGrant,
    busy: delegating,
    receipt: delegateReceipt,
  } = useGrantPermission()

  const [selected, setSelected] = useState<Moment | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [recipientInput, setRecipientInput] = useState('')
  const [delegateInput, setDelegateInput] = useState('')
  const [recipients, setRecipients] = useState<string[]>([])
  const [sending, setSending] = useState(false)
  const [resultHash, setResultHash] = useState<string | null>(null)

  // Server-side airdrop quota (per-artist daily cadence + weekly cap,
  // configured by admin in /admin/airdrop-quota). The quota only
  // applies to airdrops in the configured Pass collection — for any
  // other collection the server skips the debit, and the UI hides the
  // caption + doesn't gate the button. `passCollection` arrives in the
  // pre-flight response so the form knows when to apply quota UX.
  // Admin sees Number.MAX_SAFE_INTEGER as the remaining value (the
  // server's "unlimited" sentinel) — we hide the caption in that case
  // regardless of which collection they're airdropping.
  const [quota, setQuota] = useState<{
    limits: { day: number; week: number }
    used: { day: number; week: number }
    remaining: { day: number; week: number }
    passCollection: string | null
  } | null>(null)

  const refreshQuota = useCallback(async () => {
    if (!address) {
      setQuota(null)
      return
    }
    try {
      const res = await fetch(`/api/airdrop/quota?artist=${address}`)
      if (!res.ok) return
      setQuota(await res.json())
    } catch {}
  }, [address])

  useEffect(() => {
    void refreshQuota()
  }, [refreshQuota])

  // Permission preflight on the SELECTED moment's collection. The
  // wallet that needs ADMIN now is the connected EOA itself — the
  // user signs the airdrop tx directly, so adminMint's gate runs
  // against `permissions[tokenId][msg.sender] | permissions[0][msg.sender]`
  // (Zora's _hasAnyPermission). Picker-eligible moments come back
  // from /api/timeline?airdroppable=… which already filters to
  // moments where the user holds at least per-token ADMIN, so this
  // read should pass on every selectable moment; we keep the check
  // as a defensive guard against a stale cache.
  const callerAddress =
    address && isAddress(address) ? (address as `0x${string}`) : null
  const { data: airdropPerms } = useReadContracts({
    contracts:
      selected && callerAddress
        ? [
            {
              address: selected.address as `0x${string}`,
              abi: COLLECTION_ABI,
              functionName: 'permissions' as const,
              args: [0n, callerAddress] as const,
            },
            {
              address: selected.address as `0x${string}`,
              abi: COLLECTION_ABI,
              functionName: 'permissions' as const,
              args: [BigInt(selected.token_id), callerAddress] as const,
            },
          ]
        : [],
    query: { enabled: !!selected && !!callerAddress },
  })
  // Zora's adminMint accepts ADMIN | MINTER. Mirror the same mask here —
  // checking ADMIN alone would block MINTER-only authorized minters.
  const callerLacksMintAccess =
    !!selected &&
    !!callerAddress &&
    airdropPerms?.length === 2 &&
    airdropPerms[0].status === 'success' &&
    airdropPerms[1].status === 'success' &&
    (() => {
      const merged =
        (airdropPerms[0].result as bigint) |
        (airdropPerms[1].result as bigint)
      return !hasAdminBit(merged) && !hasMinterBit(merged)
    })()

  // Receipt handler for the delegate grant. Mirrors the previous
  // version exactly — delegation is a fire-and-forget grant, the
  // recipient airdrops separately from their own wallet.
  useEffect(() => {
    if (!delegateReceipt) return
    resetDelegateGrant()
    if (delegateReceipt.status === 'reverted') {
      toast.error('Delegate failed', {
        id: 'delegate-airdrop',
        description:
          'The transaction reverted on-chain — only the moment admin can delegate.',
      })
      return
    }
    setDelegateInput('')
    toast.success('Airdrop delegated', { id: 'delegate-airdrop' })
  }, [delegateReceipt, resetDelegateGrant])

  async function handleDelegateAirdrop() {
    if (!selected) {
      toast.error('Pick a moment to delegate first', { id: 'delegate-airdrop' })
      return
    }
    const target = delegateInput.trim()
    if (!isAddress(target)) {
      toast.error('Invalid address', { id: 'delegate-airdrop' })
      return
    }
    if (!isConnected || !address) {
      openConnectModal?.()
      return
    }
    try {
      toast.loading('Confirm in wallet…', { id: 'delegate-airdrop' })
      const outcome = await grantDelegate({
        collection: selected.address as `0x${string}`,
        grantee: target as `0x${string}`,
        tokenId: BigInt(selected.token_id),
        bit: 'admin',
      })
      if (outcome === 'submitted') {
        toast.loading('Delegating…', { id: 'delegate-airdrop' })
        return
      }
      // Already had ADMIN at this tokenId — no tx needed.
      setDelegateInput('')
      toast.success('Already authorized to airdrop this moment', {
        id: 'delegate-airdrop',
      })
    } catch (err) {
      toastError('Delegate airdrop', err, { id: 'delegate-airdrop' })
    }
  }

  function addRecipient() {
    const addr = recipientInput.trim()
    if (!isAddress(addr)) { toast.error('Invalid address'); return }
    if (recipients.includes(addr.toLowerCase())) { toast.error('Already added'); return }
    if (recipients.length >= MAX_AIRDROP_RECIPIENTS) {
      toast.error(`Max ${MAX_AIRDROP_RECIPIENTS} recipients per airdrop`); return
    }
    setRecipients((prev) => [...prev, addr.toLowerCase()])
    setRecipientInput('')
  }

  function removeRecipient(addr: string) {
    setRecipients((prev) => prev.filter((r) => r !== addr))
  }

  async function handleAirdrop(e: React.FormEvent) {
    e.preventDefault()
    if (!isConnected || !address) { openConnectModal?.(); return }
    if (!selected) { toast.error('Select a moment to airdrop'); return }

    // Auto-commit a pending recipient sitting in the input — clicking
    // AIRDROP with a valid address typed but not yet added is a common
    // footgun. Mirror what pressing Enter or clicking + would do, then
    // proceed with the merged list.
    const pending = recipientInput.trim()
    let activeRecipients = recipients
    if (pending && isAddress(pending) && !recipients.includes(pending.toLowerCase())) {
      activeRecipients = [...recipients, pending.toLowerCase()]
      setRecipients(activeRecipients)
      setRecipientInput('')
    }
    if (activeRecipients.length === 0) { toast.error('Add at least one recipient'); return }
    // Guard the server's cap before broadcasting — otherwise the on-chain
    // adminMint would succeed and the notify record would then 400, stranding
    // the airdrop off-chain (invisible in profile, no recipient inbox entry).
    if (activeRecipients.length > MAX_AIRDROP_RECIPIENTS) {
      toast.error(`Max ${MAX_AIRDROP_RECIPIENTS} recipients per airdrop`); return
    }

    // Pre-flight against the latest quota — but ONLY when this airdrop
    // targets the configured Pass collection. The server applies the
    // quota with the same scoping rule, so a moment from a non-Pass
    // collection skips both the UI block and the ledger debit. We
    // re-fetch to defeat a stale local snapshot (e.g. the artist
    // airdropped from another tab between this form mounting and the
    // click).
    const fresh = await fetch(`/api/airdrop/quota?artist=${address}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null) as typeof quota
    if (fresh) {
      setQuota(fresh)
      const isPassAirdrop =
        !!fresh.passCollection
        && fresh.passCollection.toLowerCase() === selected.address.toLowerCase()
      if (isPassAirdrop) {
        if (activeRecipients.length > fresh.remaining.day) {
          toast.error(
            `Daily airdrop limit reached — ${fresh.remaining.day} of ${fresh.limits.day} left today`,
          )
          return
        }
        if (activeRecipients.length > fresh.remaining.week) {
          toast.error(
            `Weekly airdrop limit reached — ${fresh.remaining.week} of ${fresh.limits.week} left this week`,
          )
          return
        }
      }
    }

    setSending(true)
    setResultHash(null)
    try {
      toast.loading('Confirm airdrop in wallet…', { id: 'airdrop' })
      const txHash = await airdrop({
        collectionAddress: selected.address as `0x${string}`,
        tokenId: BigInt(selected.token_id),
        recipients: activeRecipients as `0x${string}`[],
      })
      setResultHash(txHash)
      setRecipients([])
      toast.success(
        `Airdropped to ${activeRecipients.length} recipient${activeRecipients.length !== 1 ? 's' : ''}!`,
        { id: 'airdrop' },
      )
      // Record the airdrop server-side so it shows up in the sender's profile
      // airdrops section and recipients get an inbox notification. Kismet
      // airdrops bypass inprocess's relay, so without this round-trip neither
      // surface would ever observe the airdrop. Retry-with-backoff: the mint
      // already landed on-chain, and the endpoint is idempotency-locked +
      // verify-gated, so a transient failure self-heals instead of silently
      // stranding the airdrop off-chain.
      void notifyAirdropWithBackoff({
        sender: address,
        collectionAddress: selected.address,
        tokenId: String(selected.token_id),
        recipients: activeRecipients,
        txHash,
      }).then(() => refreshQuota())
    } catch (err) {
      toastError('Airdrop', err, { id: 'airdrop' })
    } finally {
      setSending(false)
    }
  }

  const selectedMeta = selected?.metadata ?? {}

  return (
    <form onSubmit={handleAirdrop} className="flex flex-col gap-6">

      {/* Moment picker */}
      <div>
        <label className="block text-xs font-mono text-dim uppercase tracking-wider mb-2">
          Moment <span className="text-ink">*</span>
        </label>

        {/* Selected moment preview / trigger */}
        <button
          type="button"
          onClick={() => setPickerOpen((v) => !v)}
          className="w-full flex items-center gap-3 bg-surface border border-line px-3 py-2.5 hover:border-muted transition-colors text-left"
        >
          {selected ? (
            <>
              {selectedMeta.image ? (
                <div className="w-8 h-8 relative flex-shrink-0 bg-raised overflow-hidden">
                  <MomentImage
                    src={selectedMeta.image}
                    alt=""
                    fill
                    className="object-cover"
                    sizes="32px"
                    mime={selectedMeta.content?.mime}
                    thumbhash={selectedMeta.kismet_thumbhash}
                  />
                </div>
              ) : selectedMeta.content?.mime === 'text/plain' ? (
                <div className="w-8 h-8 flex-shrink-0 bg-gradient-to-br from-raised to-[#0a0a0a] flex items-center justify-center">
                  <span className="text-[7px] font-mono text-muted uppercase tracking-widest">txt</span>
                </div>
              ) : null}
              <span className="text-sm text-ink font-mono truncate flex-1">
                {selectedMeta.name ?? `#${selected.token_id}`}
              </span>
            </>
          ) : (
            <span className="text-sm text-faint font-mono flex-1">
              {loadingMoments ? 'loading your moments…' : 'select a moment'}
            </span>
          )}
          <span className="text-muted text-xs font-mono flex-shrink-0">
            {pickerOpen ? '▲' : '▼'}
          </span>
        </button>

        {/* Picker grid */}
        {pickerOpen && (
          <div className="border border-t-0 border-line bg-[#0d0d0d] max-h-64 overflow-y-auto">
            {moments.length === 0 ? (
              <p className="text-xs font-mono text-muted px-3 py-4">
                {loadingMoments ? 'loading…' : 'no minted moments found'}
              </p>
            ) : (
              <div className="grid grid-cols-3 gap-px bg-line">
                {moments.map((m, idx) => {
                  const meta = m.metadata ?? {}
                  const isSelected = selected?.address === m.address && selected?.token_id === m.token_id
                  return (
                    <button
                      key={`${m.address}:${m.token_id}`}
                      type="button"
                      onClick={() => { setSelected(m); setPickerOpen(false) }}
                      className={`relative aspect-square bg-surface overflow-hidden group ${isSelected ? 'ring-2 ring-inset ring-accent' : ''}`}
                    >
                      {meta.image ? (
                        <MomentImage
                          src={meta.image}
                          alt={meta.name ?? ''}
                          fill
                          className="object-cover"
                          sizes="120px"
                          priority={idx < 6}
                          mime={meta.content?.mime}
                          thumbhash={meta.kismet_thumbhash}
                        />
                      ) : meta.content?.mime === 'text/plain' ? (
                        <div className="w-full h-full flex flex-col p-2 bg-gradient-to-br from-raised to-[#0a0a0a]">
                          <span className="text-[8px] font-mono text-muted uppercase tracking-widest mb-1">writing</span>
                          <p className="text-[9px] font-mono text-dim leading-tight line-clamp-5">
                            {meta.name ?? `#${m.token_id}`}
                          </p>
                        </div>
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <span className="text-faint font-mono text-[10px]">#{m.token_id}</span>
                        </div>
                      )}
                      <div className="absolute inset-x-0 bottom-0 bg-black/70 px-1.5 py-1 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                        <p className="text-[9px] font-mono text-ink truncate">{meta.name ?? `#${m.token_id}`}</p>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Recipients */}
      <div>
        <label
          htmlFor="airdrop-recipient"
          className="block text-xs font-mono text-dim uppercase tracking-wider mb-2"
        >
          Recipients
        </label>
        <div className="flex gap-2 mb-2">
          <input
            id="airdrop-recipient"
            name="airdrop-recipient"
            type="text"
            value={recipientInput}
            onChange={(e) => setRecipientInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addRecipient() } }}
            placeholder="0x… wallet address"
            aria-label="Recipient wallet address"
            className="flex-1 bg-surface border border-line px-3 py-2.5 text-sm text-ink font-mono placeholder-faint focus:outline-none focus:border-muted"
          />
          <button
            type="button"
            onClick={addRecipient}
            className="px-3 border border-line text-dim hover:border-muted hover:text-ink transition-colors"
          >
            <Plus size={14} />
          </button>
        </div>
        {recipients.length > 0 && (
          <ul className="flex flex-col gap-1 mb-1.5">
            {recipients.map((r) => (
              <li key={r} className="flex items-center justify-between bg-surface border border-line px-3 py-2">
                <span className="text-xs font-mono text-dim">{shortAddress(r)}</span>
                <button type="button" onClick={() => removeRecipient(r)} className="text-muted hover:text-dim">
                  <X size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {recipients.length > 0 && (
          <p className="text-xs font-mono text-muted">
            {recipients.length} recipient{recipients.length !== 1 ? 's' : ''}
            {' — '}each receives 1 fresh copy (minted, not transferred)
          </p>
        )}
      </div>

      {resultHash && (
        <a
          href={`https://basescan.org/tx/${resultHash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-mono text-muted hover:text-dim transition-colors"
        >
          tx: {resultHash.slice(0, 10)}…{resultHash.slice(-8)}
        </a>
      )}

      {/* Defensive: should never fire on the happy path since the
          picker is sourced from authorized-only feeds. Catches stale
          caches and wallet switches; stays silent while reads are
          loading or RPC-failed so the user can still attempt and let
          the chain surface the real revert. */}
      {callerLacksMintAccess && selected && (
        <div className="p-3 sm:p-4 border border-accent/40 bg-accent/5 flex items-start gap-2.5">
          <div className="min-w-0">
            <p className="text-xs font-mono text-ink">
              Your wallet can&apos;t mint on this collection
            </p>
            <p className="text-[11px] font-mono text-dim mt-0.5">
              Airdrops mint directly from your wallet. Switch to a wallet that holds
              ADMIN or MINTER on {shortAddress(selected.address)}, or have
              the creator authorize your address.
            </p>
          </div>
        </div>
      )}

      {/* Treat a valid address typed into the input as a pending recipient
          so the user doesn't have to click + first. handleAirdrop commits
          it to the array before sending; the count below reflects what
          the submit will actually airdrop to. */}
      {(() => {
        const pending = recipientInput.trim()
        const pendingValid =
          !!pending && isAddress(pending) && !recipients.includes(pending.toLowerCase())
        const totalRecipients = recipients.length + (pendingValid ? 1 : 0)
        // Quota gating applies ONLY when the selected moment is in the
        // configured Pass collection AND the connected wallet isn't the
        // admin (admin sees MAX_SAFE_INTEGER as the remaining sentinel).
        // Hidden for any other collection because the server skips the
        // quota check there — surfacing a counter would be misleading.
        const isPassAirdrop =
          !!quota?.passCollection
          && !!selected
          && quota.passCollection.toLowerCase() === selected.address.toLowerCase()
        const unlimited = !quota || quota.remaining.day >= Number.MAX_SAFE_INTEGER
        const gated = isPassAirdrop && !unlimited
        const overDay = gated && quota ? totalRecipients > quota.remaining.day : false
        const overWeek = gated && quota ? totalRecipients > quota.remaining.week : false
        return (
          <button
            type="submit"
            disabled={sending || !selected || totalRecipients === 0 || overDay || overWeek}
            className="w-full py-3 text-xs font-mono tracking-widest uppercase btn-accent disabled:opacity-50"
          >
            {!isConnected
              ? 'connect wallet to airdrop'
              : sending
              ? 'airdropping…'
              : overDay
              ? `daily limit — ${quota?.remaining.day ?? 0} of ${quota?.limits.day ?? 0} left today`
              : overWeek
              ? `weekly limit — ${quota?.remaining.week ?? 0} of ${quota?.limits.week ?? 0} left this week`
              : selected && totalRecipients > 0
              ? `airdrop to ${totalRecipients} wallet${totalRecipients !== 1 ? 's' : ''}`
              : 'airdrop'}
          </button>
        )
      })()}

      <p className="text-[10px] font-mono text-[#444] text-center -mt-2">
        airdrop freshly minted supply to recipients · paid from your wallet
      </p>

      {quota
        && quota.remaining.day < Number.MAX_SAFE_INTEGER
        && selected
        && !!quota.passCollection
        && quota.passCollection.toLowerCase() === selected.address.toLowerCase() && (
        <p className="text-[10px] font-mono text-muted text-center -mt-4">
          {quota.remaining.day} of {quota.limits.day} left today · {quota.remaining.week} of {quota.limits.week} this week
        </p>
      )}

      {/* Delegate airdrop — moved from the moment detail page so all
          airdrop-related actions live on this tab. Renders only when a
          moment is picked (the picker already filtered to moments the
          connected user has airdrop authority on, so showing the
          delegate input is contextually safe). Grants per-token ADMIN
          to the entered address; the recipient airdrops via this same
          form on their own session. */}
      {selected && (
        <div className="flex flex-col gap-2 pt-2">
          <p className="text-[10px] font-mono text-muted uppercase tracking-wider">
            delegate airdrop
          </p>
          <p className="text-[10px] font-mono text-[#444]">
            let another wallet airdrop this specific moment
          </p>
          <div className="flex gap-2">
            <input
              id="airdrop-delegate"
              name="airdrop-delegate"
              type="text"
              value={delegateInput}
              onChange={(e) => setDelegateInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                e.preventDefault()
                void handleDelegateAirdrop()
              }}
              placeholder="0x… wallet address"
              aria-label="Delegate wallet address"
              className="flex-1 bg-surface border border-line px-3 py-2 text-xs text-ink font-mono placeholder-faint focus:outline-none focus:border-muted"
            />
            <button
              type="button"
              onClick={() => void handleDelegateAirdrop()}
              disabled={delegating || !delegateInput.trim()}
              className="text-xs font-mono px-3 py-2 border border-line text-muted hover:border-muted hover:text-ink transition-colors disabled:opacity-40"
            >
              {delegating ? '…' : '→'}
            </button>
          </div>
        </div>
      )}

    </form>
  )
}
