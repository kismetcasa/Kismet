'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { useGrantPermission } from '@/hooks/useGrantPermission'
import { useMomentAdminPermission } from '@/hooks/useMomentEditPermission'
import { toastError } from '@/lib/toast'

/**
 * The artist's consent to capsule machines, one piece at a time.
 *
 * A machine delivers a prize by minting it from Kismet's delivery account, and
 * that account can only mint a piece its artist has granted it MINTER on. So
 * the grant IS the consent: allowing a piece is one signature from the
 * artist's own wallet, and stopping is one more. Nothing else in the app could
 * give it — the publish gate refuses any piece without it — so without this
 * panel no artist's work could ever enter a machine.
 *
 * Shown only to a wallet holding ADMIN on the piece, the right Zora's
 * addPermission and removePermission require: the button can never outrun the
 * write it makes. The address to grant comes from the server, which reads it
 * off the delivery account rather than from configuration.
 */

interface PieceStanding {
  operator: string | null
  allowed: boolean | null
  scope: 'piece' | 'collection' | null
  machines: { id: string; name: string; state: string }[]
}

export function ExperienceAllowance({ collection, tokenId }: { collection: string; tokenId: string }) {
  const canManage = useMomentAdminPermission(collection, tokenId)
  const { grant, revoke, reset, busy, hash, receipt } = useGrantPermission()
  const [standing, setStanding] = useState<PieceStanding | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [lastChange, setLastChange] = useState<'allow' | 'stop' | null>(null)

  const load = useCallback(() => {
    fetch(`/api/experience/piece?collection=${collection}&tokenId=${tokenId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: PieceStanding | null) => setStanding(d))
      .catch(() => setStanding(null))
  }, [collection, tokenId])

  useEffect(() => {
    if (canManage) load()
  }, [canManage, load])

  // A submitted change settles when its receipt lands; only then is the chain
  // worth re-reading.
  useEffect(() => {
    if (!receipt) return
    if (receipt.status === 'success') {
      toast.success(lastChange === 'stop' ? 'Capsule machines can no longer mint this piece' : 'Capsule machines can now mint this piece')
    } else {
      toast.error('That change reverted on-chain')
    }
    reset()
    load()
  }, [receipt, lastChange, reset, load])

  if (!canManage || !standing?.operator) return null

  const pending = busy || !!hash
  const change = async (allow: boolean) => {
    setLastChange(allow ? 'allow' : 'stop')
    const req = {
      collection: collection as `0x${string}`,
      grantee: standing.operator as `0x${string}`,
      tokenId: BigInt(tokenId),
      bit: 'minter' as const,
    }
    try {
      if ((await (allow ? grant(req) : revoke(req))) === 'already') load()
    } catch (err) {
      toastError(allow ? 'Allow capsule machines' : 'Stop capsule machines', err)
    }
  }

  const summary =
    standing.allowed === null ? 'unknown' : standing.allowed ? 'allowed' : 'not allowed'

  return (
    <div className="mt-4 border border-line">
      <button
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full flex items-center justify-between px-4 py-3 text-[10px] font-mono uppercase tracking-widest text-dim hover:text-ink transition-colors"
      >
        <span>Capsule machines</span>
        <span className="text-muted">{summary} {expanded ? '–' : '+'}</span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 flex flex-col gap-3 border-t border-line pt-3">
          <p className="text-xs font-mono text-muted leading-relaxed">
            Let capsule machines on Kismet mint this piece as a prize. A machine can only include it if its
            capsule pays you, and every machine is reviewed before it goes live. You can stop at any time;
            anyone who already drew it waits until you allow it again.
          </p>

          {standing.allowed === null ? (
            <p className="text-xs font-mono text-[#ffcf70]">Could not read this from the chain — try again shortly.</p>
          ) : standing.scope === 'collection' ? (
            <p className="text-xs font-mono text-dim">
              Allowed for every piece in this collection. Change it from the collection&apos;s permissions.
            </p>
          ) : (
            <button
              onClick={() => void change(!standing.allowed)}
              disabled={pending}
              className={`self-start px-4 py-2 text-[10px] font-mono uppercase tracking-wider disabled:opacity-40 ${
                standing.allowed ? 'border border-line text-dim hover:text-ink' : 'btn-accent'
              }`}
            >
              {pending ? 'confirming…' : standing.allowed ? 'stop allowing' : 'allow capsule machines'}
            </button>
          )}

          {standing.machines.length > 0 && (
            <div>
              <p className="text-[10px] font-mono uppercase tracking-widest text-muted mb-1.5">
                in {standing.machines.length} machine{standing.machines.length === 1 ? '' : 's'}
              </p>
              <ul className="flex flex-col gap-1">
                {standing.machines.map((m) => (
                  <li key={m.id} className="text-xs font-mono">
                    <Link href={`/experience/${m.id}`} className="text-dim hover:text-ink underline">
                      {m.name}
                    </Link>{' '}
                    <span className="text-subtle">· {m.state}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
