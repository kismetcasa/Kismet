'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { ArrowLeft, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import { useAccount, useSignMessage } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { toastError } from '@/lib/toast'

interface BackfillResponse {
  ok?: boolean
  backfilled?: number
  recipients?: string[]
  unresolved?: string[]
  error?: string
}

/**
 * Admin-only dashboard. Currently hosts the airdrop-backfill tool —
 * the place to retroactively replay airdrops that landed before
 * /api/airdrop/notify existed (or any future skew between an on-chain
 * adminMint and our Redis stores). New admin utilities should land
 * here too rather than being scattered across one-off pages.
 *
 * Auth model: we hit /api/admin/me with the connected wallet to check
 * the IS_ADMIN bit. That endpoint reads ADMIN_ADDRESS server-side, so
 * we don't duplicate the comparison client-side. The actual mutating
 * call (/api/airdrop/backfill) re-verifies via signed-message session,
 * so a malicious client that bypasses the gate still can't write.
 */
export function AdminDashboard() {
  const { address, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { signMessageAsync } = useSignMessage()

  const [adminCheck, setAdminCheck] = useState<{ checked: boolean; isAdmin: boolean }>({
    checked: false,
    isAdmin: false,
  })

  useEffect(() => {
    if (!address) {
      setAdminCheck({ checked: false, isAdmin: false })
      return
    }
    let cancelled = false
    fetch(`/api/admin/me?address=${address}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return
        setAdminCheck({ checked: true, isAdmin: !!d.isAdmin })
      })
      .catch(() => {
        if (!cancelled) setAdminCheck({ checked: true, isAdmin: false })
      })
    return () => {
      cancelled = true
    }
  }, [address])

  if (!isConnected) {
    return (
      <div className="text-center flex flex-col gap-4 items-center py-16">
        <h1 className="text-[#efefef] font-mono text-lg">Admin</h1>
        <p className="text-[#888] font-mono text-xs max-w-md">
          Connect with the admin wallet to access admin utilities.
        </p>
        <button
          onClick={() => openConnectModal?.()}
          className="text-xs font-mono tracking-wider uppercase px-4 py-2 btn-accent"
        >
          connect wallet
        </button>
      </div>
    )
  }

  if (!adminCheck.checked) {
    return (
      <div className="text-center py-16">
        <p className="text-xs font-mono text-[#555]">checking admin status…</p>
      </div>
    )
  }

  if (!adminCheck.isAdmin) {
    return (
      <div className="flex flex-col gap-4 items-center text-center py-16">
        <ShieldAlert size={20} className="text-[#8B5CF6]" />
        <h1 className="text-[#efefef] font-mono text-lg">Not authorized</h1>
        <p className="text-[#888] font-mono text-xs max-w-md">
          The connected wallet is not the admin. Switch to the admin wallet and refresh.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {address && (
        <Link
          href={`/profile/${address}`}
          className="text-[10px] font-mono text-[#555] hover:text-[#888] transition-colors flex items-center gap-1.5 w-fit uppercase tracking-wider"
        >
          <ArrowLeft size={11} />
          back to profile
        </Link>
      )}

      <div>
        <h1 className="text-[#efefef] font-mono text-lg mb-2">Admin</h1>
        <p className="text-[#888] font-mono text-xs leading-relaxed">
          Admin-only utilities. Every action below requires a fresh signed-message session.
        </p>
      </div>

      <AirdropBackfillCard
        adminAddress={address!}
        signMessage={signMessageAsync}
      />
    </div>
  )
}

function AirdropBackfillCard({
  adminAddress,
  signMessage,
}: {
  adminAddress: string
  signMessage: (args: { message: string }) => Promise<string>
}) {
  const [sender, setSender] = useState('')
  const [collection, setCollection] = useState('')
  const [tokenId, setTokenId] = useState('')
  const [recipientsRaw, setRecipientsRaw] = useState('')
  const [txHash, setTxHash] = useState('')
  const [airdropTimestamp, setAirdropTimestamp] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<BackfillResponse | null>(null)

  function parseRecipients(raw: string): string[] {
    return raw
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  }

  async function handleSubmit() {
    setResult(null)
    const recipients = parseRecipients(recipientsRaw)
    if (!sender.trim() || !collection.trim() || !tokenId.trim() || recipients.length === 0) {
      toast.error('sender, collection, tokenId, and at least one recipient are required', {
        id: 'backfill',
      })
      return
    }
    setSubmitting(true)
    try {
      // The verifying route lowercases ADMIN_ADDRESS server-side and
      // embeds it in the message text. We sign with the same lowercase
      // form so the bytes match. The gate above already confirmed
      // adminAddress == ADMIN_ADDRESS, so adminAddress.toLowerCase()
      // is the canonical value.
      const ts = Date.now()
      const message = `Kismet Art admin session\nAddress: ${adminAddress.toLowerCase()}\nTimestamp: ${ts}`
      const signature = await signMessage({ message })
      const body = {
        signature,
        timestamp: ts,
        sender: sender.trim(),
        collectionAddress: collection.trim(),
        tokenId: tokenId.trim(),
        recipients,
        ...(txHash.trim() ? { txHash: txHash.trim() } : {}),
        ...(airdropTimestamp.trim()
          ? { airdropTimestamp: Number(airdropTimestamp.trim()) }
          : {}),
      }
      const res = await fetch('/api/airdrop/backfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = (await res.json().catch(() => ({}))) as BackfillResponse
      setResult(json)
      if (!res.ok || !json.ok) {
        throw new Error(json.error ?? 'Backfill failed')
      }
      toast.success(
        `Backfilled ${json.backfilled} recipient${json.backfilled === 1 ? '' : 's'}`,
        { id: 'backfill' },
      )
    } catch (err) {
      toastError('Backfill', err, { id: 'backfill' })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="border border-[#2a2a2a] bg-[#161616] p-4 flex flex-col gap-3">
      <div>
        <h2 className="text-[#efefef] font-mono text-sm">Airdrop backfill</h2>
        <p className="text-[11px] font-mono text-[#888] mt-1 leading-relaxed">
          Replay an on-chain airdrop into the Redis stores so it shows up under the
          sender&apos;s Airdrops tab and each recipient&apos;s Collected tab. Recipients accept
          0x addresses or .eth names.
        </p>
      </div>

      <Field
        label="sender (creator who airdropped)"
        value={sender}
        onChange={setSender}
        placeholder="0x…"
      />
      <Field
        label="collection address"
        value={collection}
        onChange={setCollection}
        placeholder="0x…"
      />
      <Field
        label="token id"
        value={tokenId}
        onChange={setTokenId}
        placeholder="1"
      />
      <div className="flex flex-col gap-1.5">
        <label className="text-[10px] font-mono text-[#888] uppercase tracking-wider">
          recipients (comma, space, or newline-separated)
        </label>
        <textarea
          value={recipientsRaw}
          onChange={(e) => setRecipientsRaw(e.target.value)}
          rows={3}
          placeholder="dwn2erth.eth, 0x..."
          className="bg-[#0a0a0a] border border-[#2a2a2a] focus:border-[#555] outline-none px-2 py-1.5 text-xs font-mono text-[#efefef] placeholder:text-[#444]"
        />
      </div>
      <Field
        label="tx hash (optional)"
        value={txHash}
        onChange={setTxHash}
        placeholder="0x…"
      />
      <Field
        label="airdrop timestamp ms (optional, defaults to now)"
        value={airdropTimestamp}
        onChange={setAirdropTimestamp}
        placeholder="1715260000000"
      />

      <button
        type="button"
        onClick={handleSubmit}
        disabled={submitting}
        className="text-xs font-mono tracking-wider uppercase px-4 py-2 btn-accent disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {submitting ? 'signing + backfilling…' : 'sign & backfill'}
      </button>

      {result && (
        <div className="border border-[#2a2a2a] bg-[#0a0a0a] p-2 text-[10px] font-mono text-[#888] whitespace-pre-wrap break-all">
          {JSON.stringify(result, null, 2)}
        </div>
      )}
    </section>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[10px] font-mono text-[#888] uppercase tracking-wider">
        {label}
      </label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="bg-[#0a0a0a] border border-[#2a2a2a] focus:border-[#555] outline-none px-2 py-1.5 text-xs font-mono text-[#efefef] placeholder:text-[#444]"
      />
    </div>
  )
}
