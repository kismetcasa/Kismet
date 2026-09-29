import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { SITE_URL } from '@/lib/siteUrl'
import { buildFarcasterEmbed } from '@/lib/farcasterEmbed'
import { getMachine } from '@/lib/experience/store'
import { ExperienceMachine } from '@/components/ExperienceMachine'
import { RevealMachine } from '@/components/RevealMachine'
import { isReveal } from '@/lib/experience/types'

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
  const reveal = machine ? isReveal(machine) : false
  return {
    title: `${name} — Kismet`,
    description: reveal
      ? `Pull ${name} on Kismet for free and collect the artwork you reveal.`
      : `Play ${name} on Kismet. Published odds; every play returns a real artwork.`,
    alternates: { canonical: `${SITE_URL}/play/${id}` },
    other: buildFarcasterEmbed({
      // Its own card (opengraph-image), led by its cover, as a collection's is.
      imageUrl: `${SITE_URL}/play/${id}/opengraph-image`,
      buttonTitle: reveal ? 'Pull' : 'See the odds',
      action: { url: `${SITE_URL}/play/${id}` },
    }),
  }
}

export const dynamic = 'force-dynamic'

export default async function MachinePage({ params }: Props) {
  const { id } = await params
  if (!/^[a-z0-9-]{3,64}$/.test(id)) notFound()
  const machine = await getMachine(id).catch(() => null)
  // Drafts and review-queue machines are not public; the creator sees their own
  // on their profile.
  if (!machine || machine.state === 'draft' || machine.state === 'review') notFound()

  return (
    <div className="px-4 py-8">
      {isReveal(machine) ? <RevealMachine id={id} /> : <ExperienceMachine id={id} />}
    </div>
  )
}
