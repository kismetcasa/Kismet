import { ImageResponse } from 'next/og'
import { displayNameFor } from '@/lib/displayName'
import { shareImageSource } from '@/lib/media/shareImage'
import { machineCovers } from '@/lib/experience/cards'
import { getMachine } from '@/lib/experience/store'
import { isReveal } from '@/lib/experience/types'
import { shareCard, SHARE_CARD_SIZE, SHARE_CARD_CONTENT_TYPE } from '@/lib/shareCard'

export const size = SHARE_CARD_SIZE
export const contentType = SHARE_CARD_CONTENT_TYPE

/**
 * A machine's share card, as a collection's is: its cover, full frame. Only
 * for a machine its page shows — a draft, or one waiting for review, gets the
 * bare card, never its name or its art.
 */
export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  let label = 'MACHINE'
  let title = 'Kismet'
  let creator = ''
  let imageUrl: string | undefined
  try {
    const machine = /^[a-z0-9-]{3,64}$/.test(id) ? await getMachine(id) : null
    if (machine && machine.state !== 'draft' && machine.state !== 'review') {
      label = isReveal(machine) ? 'REVEAL MACHINE' : 'CAPSULE MACHINE'
      title = machine.name
      creator = await displayNameFor(machine.creator)
      imageUrl = await shareImageSource((await machineCovers([machine])).get(id)?.image)
    }
  } catch {
    // The bare card — never a leak, never a 500.
  }
  return new ImageResponse(shareCard({ label, title, creator, imageUrl }), { ...SHARE_CARD_SIZE })
}
