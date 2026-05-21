import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { isAddress } from '@/lib/address'
import { resolveCanonicalProfile } from '@/lib/addressUnion'
import { buildFarcasterEmbed } from '@/lib/farcasterEmbed'
import { SITE_URL } from '@/lib/siteUrl'
import { shortAddress } from '@/lib/inprocess'
import { isMobileUA } from '@/lib/serverDevice'
import { ProfileView } from '@/components/ProfileView'

interface Props {
  params: Promise<{ address: string }>
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { address } = await params
  if (!isAddress(address)) return { title: 'Profile — Kismet Art' }

  // Canonical resolution drives BOTH the share-card content and the
  // canonical URL we hand back to crawlers. The page itself also
  // redirects non-canonical addresses (see ProfilePage below), so for
  // human visits the metadata for the original requested address is
  // effectively unreachable. We still build it correctly so crawlers
  // that index without following the redirect (some SEO tools) emit
  // the right canonical link.
  const { profile, farcaster, canonicalAddress } = await resolveCanonicalProfile(address)

  const displayName =
    profile.username ||
    farcaster?.username ||
    farcaster?.displayName ||
    shortAddress(canonicalAddress)
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
  const canonicalUrl = `${SITE_URL}/profile/${canonicalAddress}`
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
    // <link rel="canonical"> — for crawlers that index content without
    // following the page-level 307 redirect (some SEO tools, archive
    // services). Belt-and-suspenders alongside the redirect in
    // ProfilePage below.
    alternates: { canonical: canonicalUrl },
    openGraph: {
      title: displayName,
      description,
      url: canonicalUrl,
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
  // Canonical-URL redirect (307). When the queried address isn't the
  // canonical one for this FID — either because the user switched
  // their FidProfile.currentAddress elsewhere, or because a sibling
  // holds the address-keyed profile data — serve a redirect so
  // shares, bookmarks, embed crawlers, and stale links all converge
  // on the same URL. 307 (not 308) because the canonical can flip
  // back if the user switches again; we don't want browsers to cache
  // an outdated redirect.
  const canonical = await resolveCanonicalProfile(address)
  if (canonical.canonicalAddress.toLowerCase() !== address.toLowerCase()) {
    redirect(`/profile/${canonical.canonicalAddress}`)
  }
  // Server-side UA detection so the lazy-mount decision is baked into
  // the SSR HTML. ProfileView renders multiple grids of MomentCards
  // directly (no PaginatedGrid wrapper) — on mobile we wrap items
  // beyond EAGER_MOUNT_COUNT in LazyMount so heavy profile pages
  // don't re-pay the full mount cost on every click-through.
  const isMobile = await isMobileUA()
  return <ProfileView address={address} isMobile={isMobile} />
}
