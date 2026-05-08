'use client'

import { useEffect, useState } from 'react'
import { useAccount, useReadContracts, useSignMessage } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { toast } from 'sonner'
import { isAddress } from 'viem'
import { Plus, ShieldCheck, X } from 'lucide-react'
import Image from 'next/image'
import { resolveUri, shortAddress, type Moment } from '@/lib/inprocess'
import { toastError } from '@/lib/toast'
import { fetchInprocessSmartWallet, useInprocessSmartWallet } from '@/hooks/useInprocessSmartWallet'
import { useGrantPermission } from '@/hooks/useGrantPermission'
import { COLLECTION_ABI } from '@/lib/collections'
import { hasAdminBit } from '@/lib/permissions'

interface AirdropFormProps {
  moments: Moment[]
  loadingMoments: boolean
}

export function AirdropForm({ moments, loadingMoments }: AirdropFormProps) {
  const { address, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { signMessageAsync } = useSignMessage()
  // The shared addPermission flow: precheck → submit tx → watch receipt.
  // Keeps the airdrop form thin — UX (toasts, retry) lives here, the
  // on-chain primitive lives in the hook.
  const { grant, reset: resetGrant, busy: authBusy, hash: authHash, receipt: authReceipt } =
    useGrantPermission()

  const [selected, setSelected] = useState<Moment | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [recipientInput, setRecipientInput] = useState('')
  const [recipients, setRecipients] = useState<string[]>([])
  const [sending, setSending] = useState(false)
  const [resultHash, setResultHash] = useState<string | null>(null)
  // Tracks an in-flight airdrop that should auto-retry once the auth
  // flow completes — set when an airdrop fails with the admin-perms
  // error, cleared on the retry attempt or on auth failure.
  const [pendingAirdropRetry, setPendingAirdropRetry] = useState(false)

  // Permission preflight on the SELECTED moment's collection. We OR the
  // collection-wide row with the per-token row (mirrors Zora's
  // _hasAnyPermission), so a creator who is per-token admin on a
  // shared collection like the platform contract still passes.
  const { address: smartWallet } = useInprocessSmartWallet(address)
  const { data: airdropPerms } = useReadContracts({
    contracts:
      selected && smartWallet && isAddress(smartWallet)
        ? [
            {
              address: selected.address as `0x${string}`,
              abi: COLLECTION_ABI,
              functionName: 'permissions' as const,
              args: [0n, smartWallet as `0x${string}`] as const,
            },
            {
              address: selected.address as `0x${string}`,
              abi: COLLECTION_ABI,
              functionName: 'permissions' as const,
              args: [BigInt(selected.token_id), smartWallet as `0x${string}`] as const,
            },
          ]
        : [],
    query: { enabled: !!selected && !!smartWallet },
  })
  const airdropPreflightUnauthorized =
    !!selected &&
    !!smartWallet &&
    airdropPerms?.length === 2 &&
    airdropPerms[0].status === 'success' &&
    airdropPerms[1].status === 'success' &&
    !hasAdminBit(
      (airdropPerms[0].result as bigint) | (airdropPerms[1].result as bigint),
    )
  // Inverse signal — both reads succeeded AND the OR'd result holds
  // ADMIN. When this is true, the inprocess smart wallet provably has
  // collection-wide-or-token-scoped ADMIN at this very moment from
  // *our* RPC's view of chain state, so any "admin permission" reject
  // from the upstream airdrop call is indexer lag, not a real auth
  // miss. We use it below to skip the Authorize prompt entirely
  // for moments minted through Kismet — the deploy flow already
  // granted ADMIN at tokenId 0.
  const airdropChainAuthorized =
    !!selected &&
    !!smartWallet &&
    airdropPerms?.length === 2 &&
    airdropPerms[0].status === 'success' &&
    airdropPerms[1].status === 'success' &&
    hasAdminBit(
      (airdropPerms[0].result as bigint) | (airdropPerms[1].result as bigint),
    )

  useEffect(() => {
    if (!authReceipt) return
    resetGrant()
    if (authReceipt.status === 'reverted') {
      // Tx reverted — drop the retry intent so we don't auto-fire an
      // airdrop the user can't actually complete.
      setPendingAirdropRetry(false)
      toast.error('Authorize failed', {
        id: 'authorize-collection',
        description:
          'The transaction reverted on-chain — only the collection admin can grant on this row.',
      })
      return
    }
    // Auto-retry the airdrop when the user kicked off the authorize
    // from the airdrop-failure path. isRetry=true flips the next
    // /api/airdrop "no admin" response into an indexer-lag hint
    // instead of looping back to another authorize prompt.
    if (pendingAirdropRetry && selected) {
      setPendingAirdropRetry(false)
      toast.success('Authorized — retrying airdrop', { id: 'authorize-collection' })
      void submitAirdrop({ isRetry: true })
      return
    }
    toast.success('Collection authorized — airdrops can now mint into it.', {
      id: 'authorize-collection',
    })
  }, [authReceipt])

  // `tokenId` is the scope of the permission grant. 0n is collection-wide
  // (works on collections the user deployed themselves — they hold
  // defaultAdmin). For shared collections like the platform collection
  // where the user isn't defaultAdmin but IS per-token admin of their
  // own moments, callers should pass the moment's tokenId so the grant
  // lands on a row the user has authority to write. useGrantPermission
  // reads both rows and ORs them — same OR Zora's _hasAnyPermission
  // applies when adminMint runs upstream — so the "already authorized"
  // short-circuit matches inprocess's actual gate.
  async function authorizeCollection(
    rawAddr: string,
    tokenId: bigint = 0n,
    // Explicit signal that the caller is the airdrop-failure toast and
    // wants the airdrop re-submitted regardless of `pendingAirdropRetry`
    // state. Sidesteps a React stale-closure bug: the toast's onClick is
    // captured at toast-creation time, *before* the queued
    // setPendingAirdropRetry(true) lands — so the closure reads false and
    // skips the retry. Manual bar callers don't pass this and continue
    // to use the state-driven path.
    forceRetryOnAlready: boolean = false,
  ) {
    const addr = rawAddr.trim()
    if (!isAddress(addr)) {
      toast.error('Invalid collection address', { id: 'authorize-collection' })
      return
    }
    if (!isConnected || !address) {
      openConnectModal?.()
      return
    }
    try {
      // The artist's inprocess smart wallet is the entity that needs
      // ADMIN — same as MintForm. Look it up from the connected EOA.
      const smartWallet = await fetchInprocessSmartWallet(address)
      if (!smartWallet || !isAddress(smartWallet)) {
        throw new Error('Could not resolve your inprocess smart wallet')
      }
      toast.loading('Confirm in wallet…', { id: 'authorize-collection' })
      const outcome = await grant({
        collection: addr as `0x${string}`,
        grantee: smartWallet as `0x${string}`,
        tokenId,
        bit: 'admin',
      })
      if (outcome === 'submitted') {
        toast.loading('Authorizing…', { id: 'authorize-collection' })
        return
      }
      // outcome === 'already' — short-circuit the success-flavored
      // toast and (if appropriate) trigger the airdrop retry.
      const shouldRetry =
        (forceRetryOnAlready || pendingAirdropRetry) &&
        selected &&
        selected.address.toLowerCase() === addr.toLowerCase()
      if (shouldRetry) {
        setPendingAirdropRetry(false)
        toast.success('Already authorized onchain — retrying airdrop', {
          id: 'authorize-collection',
        })
        void submitAirdrop({ isRetry: true })
        return
      }
      toast.success('Already authorized — airdrops can mint into this collection.', {
        id: 'authorize-collection',
      })
    } catch (err) {
      // User cancelled in wallet, RPC failed, etc. Drop the retry
      // intent so a future authorize click doesn't surprise-resubmit
      // the airdrop.
      setPendingAirdropRetry(false)
      toastError('Authorize', err, { id: 'authorize-collection' })
    }
  }

  function addRecipient() {
    const addr = recipientInput.trim()
    if (!isAddress(addr)) { toast.error('Invalid address'); return }
    if (recipients.includes(addr.toLowerCase())) { toast.error('Already added'); return }
    setRecipients((prev) => [...prev, addr.toLowerCase()])
    setRecipientInput('')
  }

  function removeRecipient(addr: string) {
    setRecipients((prev) => prev.filter((r) => r !== addr))
  }

  // Submits the airdrop to /api/airdrop. Pulled out of the form-submit
  // handler so it can be auto-invoked after the auth flow completes
  // without needing a synthetic FormEvent. `isRetry` flips the
  // admin-permission error toast into a stronger "indexer lag" message
  // when the retry hits the same wall — so we don't loop the user
  // through a useless second authorize prompt.
  async function submitAirdrop({ isRetry = false }: { isRetry?: boolean } = {}) {
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

    setSending(true)
    setResultHash(null)
    try {
      const nonceRes = await fetch(`/api/profile/${address}/nonce`)
      if (!nonceRes.ok) throw new Error('Could not fetch nonce')
      const { nonce } = await nonceRes.json().catch(() => ({}))
      if (!nonce) throw new Error('Could not fetch nonce')
      const message = `Airdrop moment on Kismet Art\nCollection: ${selected.address.toLowerCase()}\nToken: ${selected.token_id}\nAddress: ${address.toLowerCase()}\nNonce: ${nonce}`
      toast.loading(isRetry ? 'Re-sign airdrop in wallet…' : 'Sign airdrop in wallet…', { id: 'airdrop' })
      const signature = await signMessageAsync({ message })

      toast.loading(isRetry ? 'Retrying airdrop…' : 'Airdropping…', { id: 'airdrop' })
      const res = await fetch('/api/airdrop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          collectionAddress: selected.address,
          recipients: activeRecipients.map((r) => ({ recipientAddress: r, tokenId: selected.token_id })),
          callerAddress: address,
          signature,
          nonce,
          // Tells the server to bypass the smart-wallet ADMIN preflight.
          // Set when the client just landed an on-chain authorize and is
          // re-submitting — at that point a preflight 'unauthorized'
          // verdict almost always means RPC node staleness (the bit IS
          // set, but a non-canonical node hasn't synced). Trust inprocess
          // to be the authoritative source on retries.
          ...(isRetry ? { isRetry: true } : {}),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        // Surface the full upstream payload to the console so we can debug
        // 400s from inprocess validators without depending on the user
        // copying the toast text. Includes the request payload too so we
        // can verify the wire shape matches what their docs say.
        console.warn('[airdrop] /api/airdrop rejected', {
          status: res.status,
          response: data,
          requestPayload: {
            collectionAddress: selected.address,
            recipients: activeRecipients.map((r) => ({ recipientAddress: r, tokenId: selected.token_id })),
          },
        })
        // Mirrors MintForm.maybeHandleAuthError. Two detection paths:
        //   1. Structured `{ code: 'AUTHORIZE_REQUIRED' }` — what
        //      /api/airdrop returns when it converts the upstream
        //      "admin permission" error itself.
        //   2. Raw `/admin permission/i` match against the upstream
        //      response body — fallback for when the server hasn't
        //      converted (older deploy, edge cache, or any path where
        //      the upstream message reaches us verbatim).
        // Toast action triggers the wallet prompt directly (no nav)
        // so the user can grant ADMIN inline and immediately retry.
        // Manual bar at the bottom of the form is the always-visible
        // alternative for arbitrary collections.
        const authMessage =
          typeof data === 'object' && data !== null
            ? String(
                (data as Record<string, unknown>).error ??
                  (data as Record<string, unknown>).message ??
                  (data as Record<string, unknown>).detail ??
                  '',
              )
            : ''
        const errorCode = (data as { code?: string }).code
        const isIndexerLag = errorCode === 'INDEXER_LAG'
        const isAuthError =
          errorCode === 'AUTHORIZE_REQUIRED' ||
          /admin permission/i.test(authMessage)
        // Server tagged this as indexer lag (chain ADMIN is set but
        // inprocess hasn't picked it up) OR we already retried after a
        // successful authorize and inprocess still rejects OR our own
        // chain reads prove ADMIN is set (so any upstream auth reject
        // must be lag, not a real miss — covers the case where the
        // server-side RPC blip degraded its preflight to 'unknown').
        // Same outcome from the user's perspective: don't loop them
        // through another authorize prompt; show the wait-and-retry
        // toast and clear pending-retry intent so a stale auth-flow
        // context can't auto-resubmit later.
        if (isIndexerLag || (isAuthError && (isRetry || airdropChainAuthorized))) {
          setPendingAirdropRetry(false)
          toast.error("Inprocess hasn't picked up the authorize yet", {
            id: 'airdrop',
            description:
              'On-chain ADMIN is set but the inprocess indexer is still catching up. Wait a minute and tap airdrop again.',
          })
          return
        }
        if (isAuthError) {
          // Mark the airdrop as pending-retry so the auth flow can
          // auto-resubmit once it lands.
          setPendingAirdropRetry(true)
          // Server includes the resolved smart wallet + per-scope
          // perms in AUTHORIZE_REQUIRED responses. Surface the smart
          // wallet address in the description so users can verify it
          // matches the address they granted ADMIN to — the "I
          // already authorized" confusion almost always traces back
          // to granting a different address (or granting MINTER (4)
          // instead of ADMIN (2)).
          const responseData = data as {
            smartWallet?: string
            perms?: Array<{ tokenId: string; value: string | null }>
          }
          const sw = responseData.smartWallet
          const swShort = sw ? `${sw.slice(0, 6)}…${sw.slice(-4)}` : null
          const nonZeroPerms = responseData.perms?.filter(
            (p) => p.value !== null && p.value !== '0',
          )
          const hasOtherBits = (nonZeroPerms?.length ?? 0) > 0
          const description = swShort
            ? hasOtherBits
              ? `Kismet's smart wallet ${swShort} has permissions on this collection but is missing the ADMIN bit. If you granted MINTER instead of ADMIN, re-grant with ADMIN.`
              : `Kismet's smart wallet ${swShort} needs ADMIN on this collection. One-time onchain grant from your wallet.`
            : "This collection hasn't authorized Kismet for minting. One-time onchain grant from your wallet."
          toast.error('Authorization required', {
            id: 'airdrop',
            description,
            action: {
              label: 'Authorize',
              // Pass the moment's tokenId so the grant lands on a row
              // the user has authority to write — critical for the
              // platform collection where they aren't defaultAdmin
              // but ARE per-token admin of their own moments.
              // forceRetryOnAlready=true sidesteps the stale-closure
              // bug where this onClick was registered before the
              // setPendingAirdropRetry(true) update landed.
              onClick: () => void authorizeCollection(selected.address, BigInt(selected.token_id), true),
            },
          })
          return
        }
        const errors = Array.isArray(data.errors)
          ? ': ' + data.errors.map((e: { field?: string; message?: string }) => `${e.field ?? ''} ${e.message ?? ''}`.trim()).join(', ')
          : ''
        throw new Error((data.detail ?? data.error ?? data.message ?? 'Airdrop failed') + errors)
      }
      // Inprocess wraps a CDP-bundler userOp; the hash field name varies
      // across their SDK versions. Accept any of the common shapes.
      const txHash: string | undefined =
        data.hash ?? data.txHash ?? data.transactionHash ?? data.userOpHash
      if (!txHash) throw new Error('Airdrop submitted but no tx hash returned')
      setResultHash(txHash)
      setRecipients([])
      toast.success(`Airdropped to ${activeRecipients.length} recipient${activeRecipients.length !== 1 ? 's' : ''}!`, { id: 'airdrop' })
    } catch (err) {
      toastError('Airdrop', err, { id: 'airdrop' })
    } finally {
      setSending(false)
    }
  }

  async function handleAirdrop(e: React.FormEvent) {
    e.preventDefault()
    // Manual submits clear any prior pending-retry intent so the
    // explicit click is treated as a fresh airdrop attempt, not as
    // a continuation of a stale auth-flow context.
    setPendingAirdropRetry(false)
    await submitAirdrop()
  }

  const selectedMeta = selected?.metadata ?? {}
  const selectedImage = selectedMeta.image ? resolveUri(selectedMeta.image) : null

  return (
    <form onSubmit={handleAirdrop} className="flex flex-col gap-6">

      {/* Moment picker */}
      <div>
        <label className="block text-xs font-mono text-[#888] uppercase tracking-wider mb-2">
          Moment <span className="text-[#efefef]">*</span>
        </label>

        {/* Selected moment preview / trigger */}
        <button
          type="button"
          onClick={() => setPickerOpen((v) => !v)}
          className="w-full flex items-center gap-3 bg-[#111] border border-[#2a2a2a] px-3 py-2.5 hover:border-[#555] transition-colors text-left"
        >
          {selected ? (
            <>
              {selectedImage ? (
                <div className="w-8 h-8 relative flex-shrink-0 bg-[#1a1a1a] overflow-hidden">
                  <Image src={selectedImage} alt="" fill className="object-cover" sizes="32px" />
                </div>
              ) : selectedMeta.content?.mime === 'text/plain' ? (
                <div className="w-8 h-8 flex-shrink-0 bg-gradient-to-br from-[#1a1a1a] to-[#0a0a0a] flex items-center justify-center">
                  <span className="text-[7px] font-mono text-[#555] uppercase tracking-widest">txt</span>
                </div>
              ) : null}
              <span className="text-sm text-[#efefef] font-mono truncate flex-1">
                {selectedMeta.name ?? `#${selected.token_id}`}
              </span>
            </>
          ) : (
            <span className="text-sm text-[#333] font-mono flex-1">
              {loadingMoments ? 'loading your moments…' : 'select a moment'}
            </span>
          )}
          <span className="text-[#555] text-xs font-mono flex-shrink-0">
            {pickerOpen ? '▲' : '▼'}
          </span>
        </button>

        {/* Picker grid */}
        {pickerOpen && (
          <div className="border border-t-0 border-[#2a2a2a] bg-[#0d0d0d] max-h-64 overflow-y-auto">
            {moments.length === 0 ? (
              <p className="text-xs font-mono text-[#555] px-3 py-4">
                {loadingMoments ? 'loading…' : 'no minted moments found'}
              </p>
            ) : (
              <div className="grid grid-cols-3 gap-px bg-[#2a2a2a]">
                {moments.map((m, idx) => {
                  const meta = m.metadata ?? {}
                  const img = meta.image ? resolveUri(meta.image) : null
                  const isSelected = selected?.address === m.address && selected?.token_id === m.token_id
                  return (
                    <button
                      key={`${m.address}:${m.token_id}`}
                      type="button"
                      onClick={() => { setSelected(m); setPickerOpen(false) }}
                      className={`relative aspect-square bg-[#111] overflow-hidden group ${isSelected ? 'ring-2 ring-inset ring-[#8B5CF6]' : ''}`}
                    >
                      {img ? (
                        <Image src={img} alt={meta.name ?? ''} fill className="object-cover" sizes="120px" priority={idx < 6} />
                      ) : meta.content?.mime === 'text/plain' ? (
                        <div className="w-full h-full flex flex-col p-2 bg-gradient-to-br from-[#1a1a1a] to-[#0a0a0a]">
                          <span className="text-[8px] font-mono text-[#555] uppercase tracking-widest mb-1">writing</span>
                          <p className="text-[9px] font-mono text-[#888] leading-tight line-clamp-5">
                            {meta.name ?? `#${m.token_id}`}
                          </p>
                        </div>
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <span className="text-[#333] font-mono text-[10px]">#{m.token_id}</span>
                        </div>
                      )}
                      <div className="absolute inset-x-0 bottom-0 bg-black/70 px-1.5 py-1 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                        <p className="text-[9px] font-mono text-[#efefef] truncate">{meta.name ?? `#${m.token_id}`}</p>
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
          className="block text-xs font-mono text-[#888] uppercase tracking-wider mb-2"
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
            className="flex-1 bg-[#111] border border-[#2a2a2a] px-3 py-2.5 text-sm text-[#efefef] font-mono placeholder-[#333] focus:outline-none focus:border-[#555]"
          />
          <button
            type="button"
            onClick={addRecipient}
            className="px-3 border border-[#2a2a2a] text-[#888] hover:border-[#555] hover:text-[#efefef] transition-colors"
          >
            <Plus size={14} />
          </button>
        </div>
        {recipients.length > 0 && (
          <ul className="flex flex-col gap-1 mb-1.5">
            {recipients.map((r) => (
              <li key={r} className="flex items-center justify-between bg-[#111] border border-[#2a2a2a] px-3 py-2">
                <span className="text-xs font-mono text-[#888]">{shortAddress(r)}</span>
                <button type="button" onClick={() => removeRecipient(r)} className="text-[#555] hover:text-[#888]">
                  <X size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {recipients.length > 0 && (
          <p className="text-xs font-mono text-[#555]">
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
          className="text-xs font-mono text-[#555] hover:text-[#888] transition-colors"
        >
          tx: {resultHash.slice(0, 10)}…{resultHash.slice(-8)}
        </a>
      )}

      {/* Inline Authorize CTA — shows only when the smart wallet is
          missing ADMIN on the selected moment's collection (collection-
          wide row + per-token row OR'd, matching the inprocess relay's
          gate). Replaces the prior manual address input: the address
          and tokenId are unambiguous from the picked moment, so the
          user clicks once instead of typing. */}
      {airdropPreflightUnauthorized && selected && (
        <div className="p-3 sm:p-4 border border-[#8B5CF6]/40 bg-[#8B5CF6]/5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-start gap-2.5 min-w-0">
            <ShieldCheck size={16} className="text-[#8B5CF6] flex-shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-xs font-mono text-[#efefef]">
                Authorize Kismet to airdrop this moment
              </p>
              <p className="text-[11px] font-mono text-[#888] mt-0.5">
                One-time onchain grant on {shortAddress(selected.address)}, scoped to token #{selected.token_id}.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void authorizeCollection(selected.address, BigInt(selected.token_id))}
            disabled={authBusy || !!authHash}
            className="flex-shrink-0 text-xs font-mono tracking-wider uppercase px-4 py-2 btn-accent disabled:opacity-50"
          >
            {authHash ? 'authorizing…' : authBusy ? 'checking…' : 'authorize'}
          </button>
        </div>
      )}

      {/* Treat a valid address typed into the input as a pending recipient
          so the user doesn't have to click + first. submitAirdrop commits
          it to the array before sending; the count below reflects what the
          submit will actually airdrop to. */}
      {(() => {
        const pending = recipientInput.trim()
        const pendingValid =
          !!pending && isAddress(pending) && !recipients.includes(pending.toLowerCase())
        const totalRecipients = recipients.length + (pendingValid ? 1 : 0)
        return (
          <button
            type="submit"
            disabled={sending || !selected || totalRecipients === 0}
            className="w-full py-3 text-xs font-mono tracking-widest uppercase btn-accent disabled:opacity-50"
          >
            {!isConnected
              ? 'connect wallet to airdrop'
              : sending
              ? 'airdropping…'
              : selected && totalRecipients > 0
              ? `airdrop to ${totalRecipients} wallet${totalRecipients !== 1 ? 's' : ''}`
              : 'airdrop'}
          </button>
        )
      })()}

      <p className="text-[10px] font-mono text-[#444] text-center -mt-2">
        airdrop freshly minted supply to recipients
      </p>

    </form>
  )
}
