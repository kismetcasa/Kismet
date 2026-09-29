'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import type { Address } from 'viem'
import { useAccount } from 'wagmi'
import { useUpdateMomentSale } from '@/hooks/useUpdateMomentSale'
import { useUploadSession } from '@/hooks/useUploadSession'
import { toastError } from '@/lib/toast'

/**
 * A creator's two actions on their own machine — end it (a live one) or
 * withdraw it (one never on sale) — wherever the machine is shown: its page,
 * the machine list, and the creator's profile. One tap opens the
 * confirmation, which says what the action does; a second carries it out.
 * The route checks the creator (app/api/experience/machines/[id]); `creator`
 * only decides who sees the control.
 */
export function MachineAction({
  machine,
  action,
  creator,
  onDone,
  triggerClassName = 'mt-2 text-[11px] font-mono text-dim hover:text-ink underline',
  panelClassName = 'mt-2 border-t border-line pt-2',
}: {
  machine: { id: string } & ({ kind: 'reveal' } | { kind: 'capsule'; capsule: { collection: string; tokenId: string } })
  action: 'end' | 'withdraw'
  /** Shown only to this wallet. Omit when the caller already knows the viewer is the creator. */
  creator?: string
  /** After it succeeds; by default the server-rendered page refreshes. */
  onDone?: (id: string) => void
  triggerClassName?: string
  panelClassName?: string
}) {
  const { address } = useAccount()
  const router = useRouter()
  const { ensureSession } = useUploadSession()
  const { endNow } = useUpdateMomentSale()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  if (creator !== undefined && address?.toLowerCase() !== creator.toLowerCase()) return null

  const run = async () => {
    setBusy(true)
    try {
      await ensureSession()
      if (action === 'end' && machine.kind === 'capsule') {
        // The on-chain sale first: it is what actually stops capsules being
        // bought, here or on zora.co. Our record only stops the listing. An
        // already-closed sale is a no-op that needs no signature. A reveal
        // machine has no sale of its own; closing it is the listing alone.
        await endNow({ collection: machine.capsule.collection as Address, tokenId: BigInt(machine.capsule.tokenId) })
      }
      const r = await fetch(`/api/experience/machines/${machine.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const body = await r.json().catch(() => null)
      if (!r.ok) {
        toast.error(body?.error ?? 'Could not update this machine')
        return
      }
      toast.success(action === 'end' ? (machine.kind === 'reveal' ? 'Machine closed' : 'Season ended') : 'Machine withdrawn')
      setConfirming(false)
      if (onDone) onDone(machine.id)
      else router.refresh()
    } catch (err) {
      toastError(action === 'end' ? 'End season' : 'Withdraw', err)
    } finally {
      setBusy(false)
    }
  }

  const reveal = machine.kind === 'reveal'
  if (!confirming) {
    return (
      <button onClick={() => setConfirming(true)} className={triggerClassName}>
        {action === 'end' ? (reveal ? 'close machine' : 'end season') : 'withdraw'}
      </button>
    )
  }
  return (
    <div className={panelClassName}>
      <p className="text-[11px] font-mono text-muted leading-relaxed">
        {action === 'end'
          ? reveal
            ? 'This takes the machine off the shelves. Its artworks stay on sale on their own pages.'
            : 'This ends the capsule’s sale on-chain (one signature) and closes the season. Every capsule already sold is still honoured.'
          : reveal
            ? 'This takes the machine back and frees its id, so you can fix it and publish again.'
            : 'This takes the machine back. Its id, its capsule and the editions it held are freed, so you can fix it and publish again.'}
      </p>
      <div className="flex gap-2 mt-2">
        <button
          onClick={() => void run()}
          disabled={busy}
          className="px-3 py-1.5 text-[10px] font-mono uppercase tracking-wider btn-accent disabled:opacity-40"
        >
          {busy ? 'working…' : action === 'end' ? (reveal ? 'confirm close' : 'confirm end season') : 'confirm withdraw'}
        </button>
        <button
          onClick={() => setConfirming(false)}
          disabled={busy}
          className="px-3 py-1.5 text-[10px] font-mono uppercase tracking-wider border border-line text-dim hover:text-ink disabled:opacity-40"
        >
          cancel
        </button>
      </div>
    </div>
  )
}
