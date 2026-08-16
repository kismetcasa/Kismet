'use client'

import Link from 'next/link'
import { useState, useEffect } from 'react'
import { ArrowLeft, ShieldAlert, Radio } from 'lucide-react'
import { toast } from 'sonner'
import { useAccount } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useAdmin } from '@/contexts/AdminContext'
import { toastError } from '@/lib/toast'

// Spec caps (sendNotificationRequestSchema) — mirrored server-side by
// validateBroadcastInput, which is authoritative. Shown here so the admin
// sees limits while typing instead of on submit.
const TITLE_MAX = 32
const BODY_MAX = 128
const ID_MAX = 128

interface Reach {
  eligibleFids: number
  tokens: number
  hosts: Record<string, number>
  skippedMasterOff: number
  prunedNoTokens: number
  truncated: boolean
}

interface RunResult {
  notificationId: string
  eligibleFids: number
  requests: number
  failedRequests: number
  successfulTokens: number
  invalidTokens: number
  rateLimitedTokens: number
  durationMs: number
}

export default function BroadcastAdminPage() {
  const { address, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { isAdmin, withSession } = useAdmin()

  const [notificationId, setNotificationId] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [targetUrl, setTargetUrl] = useState('')

  const [reach, setReach] = useState<Reach | null>(null)
  const [estimating, setEstimating] = useState(false)
  const [sending, setSending] = useState(false)
  const [armed, setArmed] = useState(false)
  const [result, setResult] = useState<RunResult | null>(null)

  // Prefill a date-scoped id in an effect (not a useState initializer) so the
  // SSR pass and hydration render identical markup. A stable per-announcement
  // id is what makes re-running a partial send safe (host-side 24h dedupe).
  useEffect(() => {
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    setNotificationId((prev) =>
      prev || `announcement-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    )
  }, [])

  // Any edit to the message un-arms the send button — the confirmation the
  // admin saw must describe the exact payload that will go out.
  useEffect(() => {
    setArmed(false)
  }, [notificationId, title, body, targetUrl])

  async function handleEstimate() {
    setEstimating(true)
    try {
      const r = await withSession(async () => {
        const res = await fetch('/api/admin/broadcast', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dryRun: true }),
        })
        const json = (await res.json().catch(() => ({}))) as { reach?: Reach; error?: string }
        if (!res.ok || !json.reach) throw new Error(json.error ?? 'Estimate failed')
        return json.reach
      })
      if (!r) return
      setReach(r)
    } catch (err) {
      toastError('Estimate', err)
    } finally {
      setEstimating(false)
    }
  }

  async function handleSend() {
    if (!title.trim() || !body.trim() || !notificationId.trim()) {
      toast.error('notificationId, title and body are required')
      return
    }
    if (!armed) {
      // First click arms; the button relabels to the explicit confirmation.
      setArmed(true)
      return
    }
    setSending(true)
    try {
      const r = await withSession(async () => {
        const res = await fetch('/api/admin/broadcast', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            notificationId: notificationId.trim(),
            title: title.trim(),
            body: body.trim(),
            // Empty string → omit → server defaults to the site root.
            ...(targetUrl.trim() ? { targetUrl: targetUrl.trim() } : {}),
          }),
        })
        const json = (await res.json().catch(() => ({}))) as {
          ok?: boolean
          result?: RunResult
          error?: string
        }
        if (!res.ok || !json.ok || !json.result) throw new Error(json.error ?? 'Send failed')
        return json.result
      })
      if (!r) return
      setResult(r)
      setArmed(false)
      toast.success(`Broadcast sent — ${r.successfulTokens} delivered`)
    } catch (err) {
      toastError('Broadcast', err)
    } finally {
      setSending(false)
    }
  }

  if (!isConnected) {
    return (
      <div className="max-w-lg mx-auto px-4 py-12 flex flex-col items-center gap-4 text-center">
        <h1 className="text-ink font-mono text-lg">Push broadcast</h1>
        <p className="text-dim font-mono text-xs">connect with the admin wallet to continue</p>
        <button onClick={() => openConnectModal?.()} className="px-4 py-2 text-xs font-mono uppercase tracking-widest btn-accent">
          connect wallet
        </button>
      </div>
    )
  }

  if (!isAdmin) {
    return (
      <div className="max-w-lg mx-auto px-4 py-16 flex flex-col gap-4 items-center text-center">
        <ShieldAlert size={20} className="text-accent" />
        <h1 className="text-ink font-mono text-lg">Not authorized</h1>
        <p className="text-dim font-mono text-xs">Switch to the admin wallet and refresh.</p>
      </div>
    )
  }

  return (
    <div className="max-w-lg mx-auto px-4 py-12 flex flex-col gap-6">
      {address && (
        <Link href="/admin" className="text-[10px] font-mono text-muted hover:text-dim flex items-center gap-1.5 w-fit uppercase tracking-wider">
          <ArrowLeft size={11} />
          back to admin
        </Link>
      )}

      <div>
        <h1 className="text-ink font-mono text-lg mb-2 flex items-center gap-2">
          <Radio size={16} className="text-accent" />
          Push broadcast
        </h1>
        <p className="text-dim font-mono text-xs leading-relaxed">
          Sends one native Farcaster push to every user who added Kismet with
          notifications enabled and has push on in Kismet settings. Delivered
          by their Farcaster host (Farcaster app / Base app); tapping opens
          Kismet at the target URL. Re-sending with the same id is safe —
          hosts de-duplicate per user for 24h, so a re-run only reaches
          people missed the first time.
        </p>
      </div>

      <div className="border border-line px-3 py-3 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-mono text-dim uppercase tracking-wider">reach</span>
          <button
            onClick={handleEstimate}
            disabled={estimating}
            className="px-3 py-1.5 text-[10px] font-mono uppercase tracking-widest border border-line hover:border-muted transition-colors disabled:opacity-50"
          >
            {estimating ? 'estimating…' : 'estimate reach'}
          </button>
        </div>
        {reach && (
          <div className="text-[11px] font-mono text-dim leading-relaxed">
            <span className="text-ink">{reach.eligibleFids}</span> users ·{' '}
            <span className="text-ink">{reach.tokens}</span> tokens
            {Object.entries(reach.hosts).map(([host, n]) => (
              <div key={host} className="text-muted truncate">{n} × {host}</div>
            ))}
            {reach.skippedMasterOff > 0 && (
              <div className="text-muted">{reach.skippedMasterOff} skipped (push off in Kismet)</div>
            )}
            {reach.truncated && (
              <div className="text-accent">index scan truncated — reach undercounted</div>
            )}
          </div>
        )}
      </div>

      <div>
        <label className="block text-xs font-mono text-dim uppercase tracking-wider mb-2">
          notification id <span className="text-muted normal-case">({notificationId.length}/{ID_MAX})</span>
        </label>
        <input
          type="text"
          value={notificationId}
          onChange={(e) => setNotificationId(e.target.value)}
          placeholder="announcement-2026-08-16"
          className="w-full bg-[#0a0a0a] border border-line px-3 py-2.5 text-sm text-ink font-mono placeholder-subtle focus:outline-none focus:border-muted"
        />
        <p className="text-[10px] font-mono text-muted mt-1.5">
          idempotency key — keep it stable to retry a partial send; change it for a new announcement.
        </p>
      </div>

      <div>
        <label className="block text-xs font-mono text-dim uppercase tracking-wider mb-2">
          title <span className={`normal-case ${title.length > TITLE_MAX ? 'text-accent' : 'text-muted'}`}>({title.length}/{TITLE_MAX})</span>
        </label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="New drop on Kismet"
          className="w-full bg-[#0a0a0a] border border-line px-3 py-2.5 text-sm text-ink font-mono placeholder-subtle focus:outline-none focus:border-muted"
        />
      </div>

      <div>
        <label className="block text-xs font-mono text-dim uppercase tracking-wider mb-2">
          body <span className={`normal-case ${body.length > BODY_MAX ? 'text-accent' : 'text-muted'}`}>({body.length}/{BODY_MAX})</span>
        </label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={3}
          placeholder="…"
          className="w-full bg-[#0a0a0a] border border-line px-3 py-2.5 text-sm text-ink font-mono placeholder-subtle focus:outline-none focus:border-muted resize-none"
        />
      </div>

      <div>
        <label className="block text-xs font-mono text-dim uppercase tracking-wider mb-2">target url</label>
        <input
          type="text"
          value={targetUrl}
          onChange={(e) => setTargetUrl(e.target.value)}
          placeholder="https://kismet.art/… (empty = homepage)"
          className="w-full bg-[#0a0a0a] border border-line px-3 py-2.5 text-sm text-ink font-mono placeholder-subtle focus:outline-none focus:border-muted"
        />
        <p className="text-[10px] font-mono text-muted mt-1.5">
          must be on kismet.art — a wrong host permanently invalidates notification tokens, so the server rejects anything else.
        </p>
      </div>

      <button
        onClick={handleSend}
        disabled={sending || title.length > TITLE_MAX || body.length > BODY_MAX}
        className={`w-full py-3 text-xs font-mono tracking-widest uppercase disabled:opacity-50 disabled:cursor-not-allowed ${armed ? 'bg-red-600 text-white hover:bg-red-500 transition-colors' : 'btn-accent'}`}
      >
        {sending
          ? 'sending…'
          : armed
            ? `confirm — send to ${reach ? `${reach.eligibleFids} users` : 'everyone'}`
            : 'send broadcast'}
      </button>

      {result && (
        <div className="border border-line px-3 py-3 text-[11px] font-mono text-dim leading-relaxed">
          <div className="text-xs text-ink uppercase tracking-wider mb-1">last run — {result.notificationId}</div>
          <div><span className="text-ink">{result.successfulTokens}</span> delivered · <span className="text-ink">{result.invalidTokens}</span> dead tokens cleaned · <span className="text-ink">{result.rateLimitedTokens}</span> rate-limited</div>
          <div className="text-muted">{result.requests} requests ({result.failedRequests} failed) · {Math.round(result.durationMs / 1000)}s</div>
          {(result.rateLimitedTokens > 0 || result.failedRequests > 0) && (
            <div className="text-accent mt-1">
              some sends deferred — re-send with the SAME id in ~1 minute to retry just the missed ones.
            </div>
          )}
        </div>
      )}
    </div>
  )
}
