import type { Metadata } from 'next'
import { cache } from 'react'
import { cookies } from 'next/headers'
import { notFound, redirect, unstable_rethrow } from 'next/navigation'
import { isAddress } from '@/lib/address'
import { isProfileIdentityHidden, isViewerFidSibling, resolveCanonicalProfile } from '@/lib/addressUnion'
import { SESSION_COOKIE, verifySession } from '@/lib/session'
import { buildFarcasterEmbed } from '@/lib/farcasterEmbed'
import { SITE_URL } from '@/lib/siteUrl'
import { shortAddress } from '@/lib/inprocess'
import { isMobileUA } from '@/lib/serverDevice'
import { ProfileView } from '@/components/ProfileView'
import { JsonLd } from '@/components/JsonLd'
import { profileJsonLd } from '@/lib/structuredData'
import { getProfileTheme } from '@/lib/profileTheme'

interface Props {
  params: Promise<{ address: string }>
}

// Admin-hidden profile → hidden from this viewer unless they own it (any
// of their FID-sibling wallets, via the session cookie — same viewer
// mechanism as the moment page's hidden-moment gate; Mini App bearer auth
// doesn't reach SSR page loads, an accepted limitation there too). React
// cache: generateMetadata and the page render share one evaluation per
// request. Both call sites 404 on true — the metadata call is what makes
// the STATUS a real 404: this route has a loading.tsx, so by the time the
// page body throws notFound() the 200 shell may already be streaming;
// metadata resolution runs before the first flush.
const isProfileHiddenFromViewer = cache(
  async (address: string, canonicalAddress: string): Promise<boolean> => {
    if (!(await isProfileIdentityHidden(address, canonicalAddress))) return false
    const token = (await cookies()).get(SESSION_COOKIE)?.value
    const viewer = token ? await verifySession(token) : null
    return !(await isViewerFidSibling(viewer, canonicalAddress))
  },
)

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  // Wrap in try/catch because error.tsx does NOT catch generateMetadata
  // throws (vercel/next.js#49925). The canonical-profile resolution does
  // several Redis reads; a transient Upstash blip would otherwise crash
  // the page rather than just degrade SEO.
  try {
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

  // Admin-hidden profile: non-owners get notFound() — thrown HERE rather
  // than only in the page body because metadata blocks the first flush,
  // making the response status a genuine 404 (the page-body gate alone
  // fires after the loading.tsx shell has streamed with a 200). The owner
  // still gets a page, but with generic metadata — no name/avatar/FID in
  // the crawler payload regardless of who fetches.
  if (await isProfileIdentityHidden(address, canonicalAddress)) {
    if (await isProfileHiddenFromViewer(address, canonicalAddress)) notFound()
    return { title: 'Profile — Kismet Art' }
  }

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
  } catch (err) {
    // Let Next control-flow errors (the notFound() above) propagate — the
    // catch exists only to keep transient Redis blips from crashing SEO.
    unstable_rethrow(err)
    console.error('[generateMetadata] profile', err)
    return { title: 'Profile — Kismet Art' }
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
  // Resolve canonical (for the redirect), the content theme, and the mobile
  // flag in parallel. The theme read is keyed on the requested address — wasted
  // only on the rare non-canonical request that then redirects; on canonical
  // URLs (the norm) it's the right key and adds no latency. This single small
  // GET is the theme feature's only per-view Redis cost. isMobile: server-side
  // UA detection so the lazy-mount decision is baked into the SSR HTML.
  const [canonical, theme, isMobile] = await Promise.all([
    resolveCanonicalProfile(address),
    getProfileTheme(address),
    isMobileUA(),
  ])
  // Admin-hidden profile → 404 for everyone but the owner, checked BEFORE
  // the canonical redirect so a hidden identity doesn't bounce visitors to
  // its canonical URL first. The status-bearing 404 comes from the same
  // check in generateMetadata (see isProfileHiddenFromViewer); this one is
  // defense in depth for the page body itself — React cache makes it the
  // same single evaluation.
  if (await isProfileHiddenFromViewer(address, canonical.canonicalAddress)) {
    notFound()
  }
  if (canonical.canonicalAddress.toLowerCase() !== address.toLowerCase()) {
    redirect(`/profile/${canonical.canonicalAddress}`)
  }

  // Server-rendered schema.org JSON-LD: a ProfilePage wrapping a Person entity
  // + a Home › Profile breadcrumb. Suppressed for admin-hidden identities so we
  // never emit a name/avatar the metadata deliberately withholds — an owner
  // viewing their own hidden profile still renders the page, just without the
  // rich entity markup. Mirrors the description generateMetadata uses so the
  // structured and meta descriptions agree. Built from the already-resolved
  // canonical profile (no extra fetch).
  const identityHidden = await isProfileIdentityHidden(address, canonical.canonicalAddress)
  const displayName =
    canonical.profile.username ||
    canonical.farcaster?.username ||
    canonical.farcaster?.displayName ||
    shortAddress(canonical.canonicalAddress)
  const jsonLd = identityHidden
    ? null
    : profileJsonLd({
        url: `${SITE_URL}/profile/${canonical.canonicalAddress}`,
        name: displayName,
        description: canonical.farcaster?.username
          ? `@${canonical.farcaster.username} on Kismet Art`
          : `${displayName}'s moments and collections on Kismet Art`,
        image: canonical.profile.avatarUrl || canonical.farcaster?.pfpUrl || undefined,
        sameAs: canonical.farcaster?.username
          ? [`https://warpcast.com/${canonical.farcaster.username}`]
          : undefined,
      })

  return (
    <>
      {jsonLd && <JsonLd data={jsonLd} />}
      <ProfileView address={address} isMobile={isMobile} theme={theme} />
    </>
  )
}
