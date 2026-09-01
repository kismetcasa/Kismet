import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { SITE_URL } from '@/lib/siteUrl'
import { buildFarcasterEmbed } from '@/lib/farcasterEmbed'
import { getMachine } from '@/lib/experience/store'
import { ExperienceMachine } from '@/components/ExperienceMachine'

interface Props {
  params: Promise<{ id: string }>
}

// A machine cast into a feed renders a launchable card. The button OPENS the
// machine rather than playing in place: a playable surface that cannot show the
// full odds table would be a disclosure hole, and disclosure has to precede
// purchase (Apple 3.1.1, inherited through the Mini App host under 4.7).
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params
  const machine = await getMachine(id).catch(() => null)
  const name = machine?.name ?? 'Capsule machine'
  return {
    title: `${name} — Kismet`,
    description: `Play ${name} on Kismet. Published odds; every play returns a real artwork.`,
    alternates: { canonical: `${SITE_URL}/experience/${id}` },
    other: buildFarcasterEmbed({
      imageUrl:
        process.env.NEXT_PUBLIC_FARCASTER_EMBED_IMAGE_URL ?? `${SITE_URL}/embed-default.png`,
      buttonTitle: 'See the odds',
      action: { url: `${SITE_URL}/experience/${id}` },
    }),
  }
}

export const dynamic = 'force-dynamic'

export default async function MachinePage({ params }: Props) {
  const { id } = await params
  if (!/^[a-z0-9-]{3,64}$/.test(id)) notFound()
  const machine = await getMachine(id).catch(() => null)
  // Drafts and review-queue machines are not public; the creator reads their own
  // through the authenticated route instead.
  if (!machine || machine.state === 'draft' || machine.state === 'review') notFound()

  return (
    <div className="px-4 py-8">
      <ExperienceMachine id={id} />
    </div>
  )
}
