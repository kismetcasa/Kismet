'use client'

import dynamic from 'next/dynamic'
import { useAccount } from 'wagmi'
import type { MachineFrames } from '@/lib/experience/types'

// The editors carry the whole upload stack (the Arweave signer, ffmpeg's
// loaders), which only a machine's creator ever uses — so a player's page never
// loads it: the editors are fetched once the connected wallet is the creator's.
const CoverEditor = dynamic(() => import('./CoverField').then((m) => m.CoverEditor), { ssr: false })
const FramesEditor = dynamic(() => import('./FrameField').then((m) => m.FramesEditor), { ssr: false })

/** A published machine's art, changed by its creator on its own page. */
export function MachineArtEditors({
  machine,
  kind,
  onDone,
}: {
  machine: { id: string; creator: string; cover: string | null; frames: MachineFrames | null }
  kind: 'capsule' | 'reveal'
  onDone: () => void
}) {
  const { address } = useAccount()
  if (address?.toLowerCase() !== machine.creator.toLowerCase()) return null
  return (
    <>
      <CoverEditor machineId={machine.id} current={machine.cover} creator={machine.creator} onDone={onDone} />
      <FramesEditor machineId={machine.id} kind={kind} current={machine.frames} creator={machine.creator} onDone={onDone} />
    </>
  )
}
