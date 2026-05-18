import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { isAddress } from '@/lib/address'
import { getProfile } from '@/lib/profile'
import { getFarcasterProfileByAddress } from '@/lib/farcasterProfile'
import { buildFarcasterEmbed } from '@/lib/farcasterEmbed'
import { shortAddress } from '@/lib/inprocess'
import { ProfileView } from '@/components/ProfileView'

interface Props {
  params: Promise<{ address: string }>
}

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://kismet.art'

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { address } = await params
  if (!isAddress(address)) return { title: 'Profile — Kismet Art' }

  // Fan out the same lookups used by /api/profile/[address] so the
  // page metadata (title, description, share card) reflects whichever
  // identity layer is richest — Kismet profile > FC profile > address.
  const [profile, farcaster] = await Promise.all([
    getProfile(address),
    getFarcasterProfileByAddress(address),
  ])

  const displayName =
    profile.username ||
    farcaster?.username ||
    farcaster?.displayName ||
    shortAddress(address)
  const title = `${displayName} — Kismet Art`
  const description =
    farcaster?.username
      ? `@${farcaster.username} on Kismet Art`
      : `${displayName}'s moments and collections on Kismet Art`
  const avatarUrl = profile.avatarUrl || farcaster?.pfpUrl || undefined

  // Share card image. The profile-specific opengraph-image route renders
  // a 1200x800 (3:2) card with avatar + name + FID, so it's the right
  // surface for both FC and OG crawlers. avatarUrl alone (often 1:1)
  // wouldn't satisfy FC's 3:2 spec and would also miss the branded chrome.
  const canonicalUrl = `${SITE_URL}/profile/${address}`
  const embedImageUrl = `${canonicalUrl}/opengraph-image`
  const fcEmbed = buildFarcasterEmbed({
    imageUrl: embedImageUrl,
    buttonTitle: 'view profile',
    action: {
      url: canonicalUrl,
      name: title,
    },
  })

  return {
    title,
    description,
    openGraph: {
      title: displayName,
      description,
      // Prefer the dynamic share card over the raw avatar so OG previews
      // include the branded chrome too. The avatarUrl ends up in
      // `twitter:image` via fallback to the opengraph route when no
      // explicit images[] is set; here we set it explicitly.
      images: [{ url: embedImageUrl }],
    },
    twitter: {
      card: 'summary_large_image',
      title: displayName,
      description,
      images: [embedImageUrl],
    },
    other: fcEmbed,
    // Hint to dependent consumers (Discord, link unfurlers) that follow
    // og:image — also expose the raw avatar so platforms that prefer a
    // square asset can use it.
    ...(avatarUrl ? { icons: { icon: avatarUrl } } : {}),
  }
}

export default async function ProfilePage({ params }: Props) {
  const { address } = await params
  if (!isAddress(address)) notFound()

  return <ProfileView address={address} />
}
