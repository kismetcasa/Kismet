'use client'

import { useEffect, useRef } from 'react'
import dynamic from 'next/dynamic'
import { useAccount } from 'wagmi'
import type { MachineFrames } from '@/lib/experience/types'
import type { FrameStatus } from '@/lib/experience/cover'

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
  machine: {
    id: string
    creator: string
    cover: string | null
    /** Every frame, played or not, with its screening (the payload's frameStatus). */
    frameStatus: Partial<Record<keyof MachineFrames, FrameStatus>> | null
  }
  kind: 'capsule' | 'reveal'
  onDone: () => void
}) {
  const { address } = useAccount()
  const mine = address?.toLowerCase() === machine.creator.toLowerCase()
  // While a frame is being screened, look again every few seconds — for a
  // minute at most — so its creator sees the verdict, and their own stage
  // plays the frame once it passes, without reloading.
  const checking = Object.values(machine.frameStatus ?? {}).some((f) => f?.state === 'checking')
  const looks = useRef(0)
  useEffect(() => {
    if (!mine || !checking) {
      looks.current = 0
      return
    }
    if (looks.current >= 20) return
    const t = setTimeout(() => {
      looks.current++
      onDone()
    }, 3000)
    return () => clearTimeout(t)
  }, [mine, checking, machine.frameStatus, onDone])
  if (!mine) return null
  return (
    <>
      <CoverEditor machineId={machine.id} current={machine.cover} creator={machine.creator} onDone={onDone} />
      <FramesEditor machineId={machine.id} kind={kind} current={machine.frameStatus} creator={machine.creator} onDone={onDone} />
    </>
  )
}
