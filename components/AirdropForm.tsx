'use client'

import { useEffect, useState } from 'react'
import { useAccount, useSignMessage } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { toast } from 'sonner'
import { isAddress } from 'viem'
import { Plus, ShieldCheck, X } from 'lucide-react'
import Image from 'next/image'
import { resolveUri, shortAddress, type Moment } from '@/lib/inprocess'
import { toastError } from '@/lib/toast'
import { fetchInprocessSmartWallet } from '@/hooks/useInprocessSmartWallet'
import { useGrantPermission } from '@/hooks/useGrantPermission'

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

  // Manual authorize bar — lets the user grant ADMIN to their inprocess
  // smart wallet on any collection they control, without navigating to
  // the collection page.
  const [authAddress, setAuthAddress] = useState('')
  // Tracks an in-flight airdrop intent that should auto-retry once the
  // auth flow completes. Set when the airdrop fails with the
  // admin-permission error. Cleared on retry attempt or on auth
  // failure. The `isRetry` arg passed to submitAirdrop on auto-retry
  // is what flips the "still no admin" toast into the indexer-lag
  // hint, so we don't need a separate "retryAttempted" state.
  const [pendingAirdropRetry, setPendingAirdropRetry] = useState(false)

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
    setAuthAddress('')
    // Auto-retry the airdrop if the user kicked off the authorize from
    // the airdrop-failure path AND the address they authorized is the
    // same one their selected moment lives in. Passing isRetry=true to
    // submitAirdrop flips the next /api/airdrop "no admin" response
    // into an indexer-lag hint instead of looping back to authorize.
    if (
      pendingAirdropRetry &&
      selected &&
      selected.address.toLowerCase() === (authAddress || selected.address).toLowerCase()
    ) {
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
  async function authorizeCollection(rawAddr: string, tokenId: bigint = 0n) {
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
      setAuthAddress('')
      if (
        pendingAirdropRetry &&
        selected &&
        selected.address.toLowerCase() === addr.toLowerCase()
      ) {
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
    if (recipients.length === 0) { toast.error('Add at least one recipient'); return }

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
          recipients: recipients.map((r) => ({ recipientAddress: r, tokenId: selected.token_id })),
          callerAddress: address,
          signature,
          nonce,
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
            recipients: recipients.map((r) => ({ recipientAddress: r, tokenId: selected.token_id })),
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
        const isAuthError =
          (data as { code?: string }).code === 'AUTHORIZE_REQUIRED' ||
          /admin permission/i.test(authMessage)
        if (isAuthError && isRetry) {
          // We already authorized once and re-submitted. If inprocess
          // STILL says no admin, the on-chain state and inprocess's
          // view diverge — most likely indexer lag. Don't loop the
          // user through another authorize attempt; surface what's
          // actually happening so they can wait/refresh.
          toast.error('Inprocess hasn\'t picked up the authorize yet', {
            id: 'airdrop',
            description:
              'On-chain ADMIN is set but the inprocess indexer is still catching up. Wait a minute and tap airdrop again.',
          })
          return
        }
        if (isAuthError) {
          // Pre-fill the manual bar so it's obvious which collection
          // we're authorizing, in case the user dismisses the toast.
          setAuthAddress(selected.address)
          // Mark the airdrop as pending-retry so the auth flow can
          // auto-resubmit once it lands.
          setPendingAirdropRetry(true)
          toast.error('Authorization required', {
            id: 'airdrop',
            description:
              "This collection hasn't authorized Kismet for minting. One-time onchain grant from your wallet.",
            action: {
              label: 'Authorize',
              // Pass the moment's tokenId so the grant lands on a row
              // the user has authority to write — critical for the
              // platform collection where they aren't defaultAdmin
              // but ARE per-token admin of their own moments.
              onClick: () => void authorizeCollection(selected.address, BigInt(selected.token_id)),
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
      toast.success(`Airdropped to ${recipients.length} recipient${recipients.length !== 1 ? 's' : ''}!`, { id: 'airdrop' })
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
  // When the manual bar's address matches the selected moment's
  // collection, scope to the moment's tokenId so users on shared
  // collections (PLATFORM) — where they're per-token admin but not
  // defaultAdmin — can grant on a row they have authority to write.
  // Default to 0n (collection-wide) for any other address.
  const authBarTokenId =
    selected && authAddress.trim().toLowerCase() === selected.address.toLowerCase()
      ? BigInt(selected.token_id)
      : 0n

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
              ) : (
                <div className="w-8 h-8 bg-[#1a1a1a] flex-shrink-0" />
              )}
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
        <label className="block text-xs font-mono text-[#888] uppercase tracking-wider mb-2">
          Recipients
        </label>
        <div className="flex gap-2 mb-2">
          <input
            type="text"
            value={recipientInput}
            onChange={(e) => setRecipientInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addRecipient() } }}
            placeholder="0x… wallet address"
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

      {/* Manual authorize: lets the creator grant ADMIN to their
          inprocess smart wallet on any collection they control,
          without leaving the airdrop tab. The same handler powers
          the toast prompt that fires after an airdrop fails with
          "admin permission". When the typed address matches the
          selected moment's collection, we scope the grant to the
          moment's tokenId — required for shared collections like
          PLATFORM where the user is per-token admin but not
          collection-wide admin. */}
      <div>
        <label className="flex items-center gap-1.5 text-xs font-mono text-[#888] uppercase tracking-wider mb-2">
          <ShieldCheck size={12} />
          Authorize collection
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            value={authAddress}
            onChange={(e) => setAuthAddress(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void authorizeCollection(authAddress, authBarTokenId)
              }
            }}
            placeholder="0x… collection address"
            className="flex-1 bg-[#111] border border-[#2a2a2a] px-3 py-2.5 text-sm text-[#efefef] font-mono placeholder-[#333] focus:outline-none focus:border-[#555]"
          />
          <button
            type="button"
            onClick={() => void authorizeCollection(authAddress, authBarTokenId)}
            disabled={authBusy || !authAddress.trim() || !!authHash}
            className="px-4 text-[10px] font-mono tracking-wider uppercase border border-[#2a2a2a] text-[#888] hover:border-[#555] hover:text-[#efefef] transition-colors disabled:opacity-50"
          >
            {authHash ? 'authorizing…' : authBusy ? 'checking…' : 'authorize'}
          </button>
        </div>
        <p className="text-[10px] font-mono text-[#444] mt-1.5">
          {authBarTokenId === 0n
            ? 'one-time onchain grant — only the collection admin can authorize'
            : `scoped to your moment #${selected?.token_id} (you must be admin of this token)`}
        </p>
      </div>

      <button
        type="submit"
        disabled={sending || !selected || recipients.length === 0}
        className="w-full py-3 text-xs font-mono tracking-widest uppercase btn-accent disabled:opacity-50"
      >
        {!isConnected
          ? 'connect wallet to airdrop'
          : sending
          ? 'airdropping…'
          : selected && recipients.length > 0
          ? `airdrop to ${recipients.length} wallet${recipients.length !== 1 ? 's' : ''}`
          : 'airdrop'}
      </button>

      <p className="text-[10px] font-mono text-[#444] text-center -mt-2">
        airdrop freshly minted supply to recipients
      </p>

    </form>
  )
}
