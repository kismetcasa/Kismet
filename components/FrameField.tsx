'use client'

import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Upload } from 'lucide-react'
import { useAccount } from 'wagmi'
import { useUploadSession } from '@/hooks/useUploadSession'
import { useFileUpload } from '@/hooks/useFileUpload'
import { proxyUrl } from '@/lib/media/gateway'
import { prepareFrame, uploadFrame, type PreparedFrame } from '@/lib/experience/frameUpload'
import { toastError } from '@/lib/toast'
import { FRAME_LIMITS, type MachineFrames, type StageFrame } from '@/lib/experience/types'
import type { FrameStatus } from '@/lib/experience/cover'

/**
 * An artist's own frames for a machine's play (MachineStage): picked, prepared
 * and held to FRAME_LIMITS the moment they are chosen, uploaded when the
 * machine is published or saved — once per picked file, as a cover is.
 */

type FrameStage = keyof MachineFrames

/** Each stage, as the studio and the editor describe it. */
const STAGE_COPY: Record<FrameStage, string> = {
  dispense: 'loops while the wallet and the draw work',
  open: 'plays once, as the capsule opens',
}

/** A source larger than a collection cover's limit is no frame to begin with;
 *  what it becomes is held to FRAME_LIMITS. */
const MAX_SOURCE_BYTES = 25 * 1024 * 1024

export function useFramePick(stage: FrameStage) {
  const prepared = useRef<{ file: File; frame: PreparedFrame } | null>(null)
  const uploaded = useRef<{ file: File; frame: StageFrame } | null>(null)
  // A pick still being prepared is not yet the pick: publishing now would
  // leave it out, so what publishes waits on this.
  const [preparing, setPreparing] = useState(false)
  const pick = useFileUpload({
    maxBytes: MAX_SOURCE_BYTES,
    onTooLarge: () => toast.error('A frame must start under 25MB'),
    accept: async (f) => {
      setPreparing(true)
      try {
        const frame = await prepareFrame(f, stage)
        if (typeof frame === 'string') return frame
        prepared.current = { file: f, frame }
        return null
      } finally {
        setPreparing(false)
      }
    },
    onRejected: (_f, reason) => toast.error('That frame will not do', { description: reason }),
  })
  const upload = async (): Promise<StageFrame | null> => {
    const ready = prepared.current
    if (!pick.file || ready?.file !== pick.file) return null
    if (uploaded.current?.file === pick.file) return uploaded.current.frame
    const frame = await uploadFrame(ready.frame)
    uploaded.current = { file: pick.file, frame }
    return frame
  }
  return { ...pick, preparing, upload }
}

type FramePick = ReturnType<typeof useFramePick>

/** One stage's row: what it shows (the picked file, or the frame the machine
 *  has), and the buttons to choose, change or remove it. */
function FrameField({
  stage,
  pick,
  current,
  status,
  reason,
  onRemove,
  disabled,
}: {
  stage: FrameStage
  pick: FramePick
  current: StageFrame | null
  /** Where the server's screening of `current` stands. */
  status?: FrameStatus['state']
  /** Why the screening refused it. */
  reason?: string
  onRemove: () => void
  disabled?: boolean
}) {
  const source = pick.file
  const has = !!source || !!current
  return (
    <div className="flex items-center gap-3">
      <div className="relative w-12 h-12 flex-shrink-0 bg-raised border border-line overflow-hidden">
        {source && pick.preview && source.type.startsWith('video/') ? (
          <video src={pick.preview} muted loop autoPlay playsInline className="w-full h-full object-cover" />
        ) : source && pick.preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={pick.preview} alt="" className="w-full h-full object-cover" />
        ) : current ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={proxyUrl(current.poster, 128)} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="text-line font-mono text-[9px]">capsule</span>
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[11px] font-mono text-dim">{stage}</p>
        <p className="text-[10px] font-mono text-subtle">{STAGE_COPY[stage]}</p>
        {current && !source && status === 'checking' && (
          <p className="text-[10px] font-mono text-muted">checking for flashing — players see the capsule until it passes</p>
        )}
        {current && !source && status === 'refused' && (
          <p className="text-[10px] font-mono text-[#ffcf70]">not shown to players: {reason}</p>
        )}
      </div>
      <button
        type="button"
        onClick={() => pick.inputRef.current?.click()}
        disabled={disabled || pick.preparing}
        className="flex items-center gap-1.5 text-[10px] font-mono text-muted hover:text-dim border border-line px-2 py-1 disabled:opacity-50"
      >
        <Upload size={11} /> {pick.preparing ? 'preparing…' : has ? 'change' : 'choose'}
      </button>
      {has && (
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled || pick.preparing}
          aria-label={`remove ${stage} frame`}
          className="text-[10px] font-mono text-muted hover:text-dim px-1 disabled:opacity-50"
        >
          remove
        </button>
      )}
      <input
        ref={pick.inputRef}
        type="file"
        accept="image/*,video/*"
        onChange={pick.onChange}
        className="hidden"
        aria-label={`${stage} frame`}
      />
    </div>
  )
}

const LIMITS_NOTE =
  `optional · up to ${FRAME_LIMITS.seconds} s, ${FRAME_LIMITS.px} px and ${FRAME_LIMITS.bytes / (1024 * 1024)} MB each, and no flashing more than three times a second · a gif becomes a video · without one, the platform's capsule plays`

/** The studio's frames: one row per stage the machine has. */
export function FrameSlots({ picks, disabled }: { picks: Partial<Record<FrameStage, FramePick>>; disabled?: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[10px] font-mono uppercase tracking-wider text-subtle">frames</span>
      {(Object.entries(picks) as [FrameStage, FramePick][]).map(([stage, pick]) => (
        <FrameField key={stage} stage={stage} pick={pick} current={null} onRemove={pick.clear} disabled={disabled} />
      ))}
      <span className="text-[10px] font-mono text-subtle">{LIMITS_NOTE}</span>
    </div>
  )
}

/** Upload whatever frames were picked (each pick's `upload`), or say why not:
 *  `{}` when none were. */
export async function uploadFramesOrSay(
  uploads: Partial<Record<FrameStage, () => Promise<StageFrame | null>>>,
): Promise<MachineFrames | null> {
  try {
    const frames: MachineFrames = {}
    for (const [stage, upload] of Object.entries(uploads) as [FrameStage, () => Promise<StageFrame | null>][]) {
      const frame = await upload()
      if (frame) frames[stage] = frame
    }
    return frames
  } catch (err) {
    toastError('Upload the frames', err)
    return null
  }
}

/**
 * A creator changing a published machine's frames — the next play shows them.
 * Shown only to `creator`'s wallet; the owner route checks the session.
 */
export function FramesEditor({
  machineId,
  kind,
  current,
  creator,
  onDone,
}: {
  machineId: string
  kind: 'capsule' | 'reveal'
  /** The machine's frames, each with where its screening stands. */
  current: Partial<Record<FrameStage, FrameStatus>> | null
  creator: string
  onDone?: () => void
}) {
  const { address } = useAccount()
  const { ensureSession } = useUploadSession()
  const dispense = useFramePick('dispense')
  const open = useFramePick('open')
  const [removed, setRemoved] = useState<FrameStage[]>([])
  const [busy, setBusy] = useState(false)
  if (address?.toLowerCase() !== creator.toLowerCase()) return null
  const picks: Partial<Record<FrameStage, FramePick>> = kind === 'capsule' ? { dispense, open } : { open }
  const stages = Object.keys(picks) as FrameStage[]
  const changed = removed.length > 0 || stages.some((s) => picks[s]?.file)
  const preparing = stages.some((s) => picks[s]?.preparing)

  const save = async () => {
    setBusy(true)
    try {
      await ensureSession()
      const fresh = await uploadFramesOrSay(
        Object.fromEntries(stages.map((s) => [s, picks[s]!.upload])),
      )
      if (!fresh) return
      const frames: MachineFrames = {}
      for (const stage of stages) {
        const frame = fresh[stage] ?? (removed.includes(stage) ? undefined : current?.[stage]?.frame)
        if (frame) frames[stage] = frame
      }
      const r = await fetch(`/api/experience/machines/${machineId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'frames', frames }),
      })
      const body = await r.json().catch(() => null)
      if (!r.ok) {
        toast.error(body?.error ?? 'Could not change the frames')
        return
      }
      toast.success('Frames updated')
      for (const stage of stages) picks[stage]?.clear()
      setRemoved([])
      onDone?.()
    } catch (err) {
      toastError('Change the frames', err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 flex flex-col gap-2 max-w-md">
      {stages.map((stage) => (
        <FrameField
          key={stage}
          stage={stage}
          pick={picks[stage]!}
          current={removed.includes(stage) ? null : (current?.[stage]?.frame ?? null)}
          status={current?.[stage]?.state}
          reason={current?.[stage]?.reason}
          onRemove={() => {
            picks[stage]?.clear()
            setRemoved((r) => (r.includes(stage) ? r : [...r, stage]))
          }}
          disabled={busy}
        />
      ))}
      {changed && (
        <button
          onClick={() => void save()}
          disabled={busy || preparing}
          className="self-start px-3 py-1.5 text-[10px] font-mono uppercase tracking-wider btn-accent disabled:opacity-40"
        >
          {busy ? 'saving…' : 'save frames'}
        </button>
      )}
    </div>
  )
}
