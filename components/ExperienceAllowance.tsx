'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { useGrantPermission } from '@/hooks/useGrantPermission'
import { useMomentAdminPermission } from '@/hooks/useMomentEditPermission'
import { useUploadSession } from '@/hooks/useUploadSession'
import { toastError } from '@/lib/toast'

/**
 * The artist's say over machines, one piece at a time. Two separate choices,
 * because the two kinds of machine use a piece differently:
 *
 *   • REVEAL MACHINES show the piece and the player collects it through this
 *     sale, at this price. Anyone may curate it — on by default — and turning
 *     it off takes it out of every reveal machine at once. A setting on
 *     Kismet, so no signature.
 *   • YOUR OWN CAPSULE MACHINES mint the piece as a prize without this sale,
 *     from Kismet's delivery account, which can only do that once the artist
 *     grants it MINTER. So that grant is one signature, and stopping is one
 *     more. Only the artist's own capsule machines can use it.
 *
 * Shown only to a wallet holding ADMIN on the piece — the right Zora's
 * addPermission and removePermission require, and the one the availability
 * route checks on chain. The address to grant comes from the server, which
 * reads it off the delivery account rather than from configuration.
 */

interface PieceStanding {
  available: boolean | null
  operator: string | null
  allowed: boolean | null
  scope: 'piece' | 'collection' | null
  machines: { id: string; name: string; state: string; kind: 'capsule' | 'reveal' }[]
}

export function ExperienceAllowance({ collection, tokenId }: { collection: string; tokenId: string }) {
  const canManage = useMomentAdminPermission(collection, tokenId)
  const { grant, revoke, reset, busy, hash, receipt } = useGrantPermission()
  const { ensureSession } = useUploadSession()
  const [switching, setSwitching] = useState(false)
  const [standing, setStanding] = useState<PieceStanding | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [lastChange, setLastChange] = useState<'allow' | 'stop' | null>(null)
  // Stopping while live capsule machines draw this piece asks once more.
  const [confirmStop, setConfirmStop] = useState(false)

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

  if (!canManage || !standing) return null

  const setAvailable = async (available: boolean) => {
    setSwitching(true)
    try {
      const send = () =>
        fetch('/api/experience/piece', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ collection, tokenId, available }),
        })
      await ensureSession()
      let r = await send()
      // The session cache can believe in a cookie the server no longer does.
      if (r.status === 401) {
        await ensureSession({ revalidate: true })
        r = await send()
      }
      const body = await r.json().catch(() => null)
      if (!r.ok) {
        toast.error(body?.error ?? 'Could not change this')
        return
      }
      toast.success(available ? 'Curators can add this piece to reveal machines' : 'Removed from every reveal machine')
      load()
    } catch (err) {
      toastError('Reveal machines', err)
    } finally {
      setSwitching(false)
    }
  }

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

  const summary = standing.available === null ? 'unknown' : standing.available ? 'open' : 'off'
  // The artist's own live capsule machines that draw this piece.
  const liveCapsules = standing.machines.filter((m) => m.kind === 'capsule' && m.state === 'live')

  return (
    <div className="mt-4 border border-line">
      <button
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full flex items-center justify-between px-4 py-3 text-[10px] font-mono uppercase tracking-widest text-dim hover:text-ink transition-colors"
      >
        <span>Machines</span>
        <span className="text-muted">{summary} {expanded ? '–' : '+'}</span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 flex flex-col gap-3 border-t border-line pt-3">
          <p className="text-[10px] font-mono uppercase tracking-widest text-muted">reveal machines</p>
          <p className="text-xs font-mono text-muted leading-relaxed -mt-1.5">
            Curators can add this piece to reveal machines. Players pull for free and collect it through this
            sale, at your price. Turning it off takes it out of every reveal machine.
          </p>
          {standing.available === null ? (
            <p className="text-xs font-mono text-[#ffcf70]">Could not read this just now — try again shortly.</p>
          ) : (
            <button
              onClick={() => void setAvailable(!standing.available)}
              disabled={switching}
              role="switch"
              aria-checked={standing.available}
              className={`self-start px-4 py-2 text-[10px] font-mono uppercase tracking-wider disabled:opacity-40 ${
                standing.available ? 'border border-line text-dim hover:text-ink' : 'btn-accent'
              }`}
            >
              {switching ? 'saving…' : standing.available ? 'on · turn off' : 'off · turn on'}
            </button>
          )}

          {standing.operator && (
            <div className="flex flex-col gap-3 mt-2">
              <p className="text-[10px] font-mono uppercase tracking-widest text-muted">your capsule machines</p>
              <p className="text-xs font-mono text-muted leading-relaxed -mt-1.5">
                Let your own capsule machines mint this piece as a prize, paid for by your capsule. You can stop
                at any time; anyone who already drew it is given a fresh draw from what is left.
              </p>
              {standing.allowed === null ? (
                <p className="text-xs font-mono text-[#ffcf70]">Could not read this from the chain — try again shortly.</p>
              ) : standing.scope === 'collection' ? (
                <p className="text-xs font-mono text-dim">
                  Allowed for every piece in this collection. Change it from the collection&apos;s permissions.
                </p>
              ) : confirmStop && standing.allowed ? (
                <div className="flex flex-col gap-2 border border-[#4a3a1a] bg-[#1a1408] p-3">
                  <p className="text-xs font-mono text-[#ffcf70] leading-relaxed">
                    {liveCapsules.map((m) => m.name).join(', ')} {liveCapsules.length === 1 ? 'draws' : 'draw'} this piece now.
                    Stopping takes it out of {liveCapsules.length === 1 ? 'its' : 'their'} draws at once, and anyone who
                    already drew it is given a fresh draw from what is left. If it is the last piece a machine can give,
                    that machine stops selling here — but its capsule keeps selling on zora.co until you end the
                    season, and each capsule sold there waits for an artwork. End the season first if you are done.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => { setConfirmStop(false); void change(false) }}
                      disabled={pending}
                      className="px-4 py-2 text-[10px] font-mono uppercase tracking-wider border border-line text-dim hover:text-ink disabled:opacity-40"
                    >
                      stop anyway
                    </button>
                    <button
                      onClick={() => setConfirmStop(false)}
                      className="px-4 py-2 text-[10px] font-mono uppercase tracking-wider btn-accent"
                    >
                      keep allowing
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => (standing.allowed && liveCapsules.length > 0 ? setConfirmStop(true) : void change(!standing.allowed))}
                  disabled={pending}
                  className={`self-start px-4 py-2 text-[10px] font-mono uppercase tracking-wider disabled:opacity-40 ${
                    standing.allowed ? 'border border-line text-dim hover:text-ink' : 'btn-accent'
                  }`}
                >
                  {pending ? 'confirming…' : standing.allowed ? 'stop allowing' : 'allow capsule machines'}
                </button>
              )}
            </div>
          )}

          {standing.machines.length > 0 && (
            <div>
              <p className="text-[10px] font-mono uppercase tracking-widest text-muted mb-1.5">
                in {standing.machines.length} machine{standing.machines.length === 1 ? '' : 's'}
              </p>
              <ul className="flex flex-col gap-1">
                {standing.machines.map((m) => (
                  <li key={m.id} className="text-xs font-mono">
                    <Link href={`/play/${m.id}`} className="text-dim hover:text-ink underline">
                      {m.name}
                    </Link>{' '}
                    <span className="text-subtle">· {m.kind} · {m.state}</span>
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

/**
 * For every visitor: the live machines this artwork is in, each a link — the
 * way Spotify's "Appears On" leads a listener from a track to the playlists
 * carrying it. A piece whose artist turned reveal machines off lists none of
 * them. Nothing renders when the piece is in no live machine.
 */
export function MachineCallout({ collection, tokenId }: { collection: string; tokenId: string }) {
  const [machines, setMachines] = useState<{ id: string; name: string; kind: 'capsule' | 'reveal' }[]>([])
  useEffect(() => {
    let alive = true
    fetch(`/api/experience/piece?collection=${collection}&tokenId=${tokenId}&public=1`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { machines?: { id: string; name: string; kind: 'capsule' | 'reveal' }[] } | null) => {
        if (alive) setMachines(d?.machines ?? [])
      })
      .catch(() => {})
    return () => { alive = false }
  }, [collection, tokenId])
  if (machines.length === 0) return null
  return (
    <p className="mt-4 text-[11px] font-mono text-muted">
      In {machines.length === 1 ? 'a machine' : `${machines.length} machines`}:{' '}
      {machines.map((m, i) => (
        <span key={m.id}>
          {i > 0 && ' · '}
          <Link href={`/play/${m.id}`} className="text-dim hover:text-ink underline">
            {m.name}
          </Link>
          <span className="text-subtle"> ({m.kind === 'reveal' ? 'pull to reveal' : 'capsule prize'})</span>
        </span>
      ))}
    </p>
  )
}
