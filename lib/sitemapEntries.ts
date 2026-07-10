import type { MetadataRoute } from 'next'

// Pure sitemap-entry builder. All Redis I/O lives in app/sitemap.ts; this
// module just transforms the already-fetched data into sitemap rows, so the
// load-bearing bits — hidden-content filtering, address normalization, the
// moment cap — are unit-testable without a running Redis or Next server (see
// scripts/verify-sitemap.ts).

// Minimal shape the builder reads from a collection-meta row. lib/kv's
// CollectionMeta structurally satisfies this.
export interface SitemapCollectionMeta {
  artist?: string
  createdAt?: number
}

export interface SitemapEntryInputs {
  siteUrl: string
  // Non-address-scoped routes (/, /mint, …) prepended verbatim.
  staticRoutes: MetadataRoute.Sitemap
  // Curated collection addresses (any case).
  collections: string[]
  // Created-mints members, each `<collection>:<tokenId>`.
  mints: Iterable<string>
  // collection address (lowercased) → meta, for artist + createdAt lookups.
  metas: Map<string, SitemapCollectionMeta>
  // Creator-hidden collection addresses (lowercased).
  hiddenCollections: Set<string>
  // Admin-hidden artist addresses (lowercased).
  hiddenUsers: Set<string>
  // Upper bound on moment rows, to stay under the 50k-URL per-file limit.
  maxMoments: number
  // Side-effect-free hook so the pure builder stays console-free in tests.
  onCap?: (max: number) => void
}

export function buildSitemapEntries(input: SitemapEntryInputs): MetadataRoute.Sitemap {
  const {
    siteUrl,
    staticRoutes,
    collections,
    mints,
    metas,
    hiddenCollections,
    hiddenUsers,
    maxMoments,
    onCap,
  } = input

  // A collection (and every moment inside it) is public only when the
  // contract isn't creator-hidden AND its deployer isn't admin-hidden — the
  // same bar searchCollections applies to every public surface.
  const isHiddenCollection = (address: string): boolean => {
    const lower = address.toLowerCase()
    if (hiddenCollections.has(lower)) return true
    const artist = metas.get(lower)?.artist?.toLowerCase()
    return !!artist && hiddenUsers.has(artist)
  }

  const collectionEntries: MetadataRoute.Sitemap = collections
    .filter((address) => !isHiddenCollection(address))
    .map((address) => {
      const createdAt = metas.get(address.toLowerCase())?.createdAt
      return {
        // Lowercase the address so the sitemap URL matches the canonical the
        // collection page declares (alternates.canonical). Ethereum addresses
        // are case-insensitive in routing; a case mismatch would make crawlers
        // treat the listed URL as non-canonical.
        url: `${siteUrl}/collection/${address.toLowerCase()}`,
        lastModified: createdAt ? new Date(createdAt) : undefined,
        changeFrequency: 'weekly' as const,
        priority: 0.7,
      }
    })

  // Created-mints members are `<collection>:<tokenId>`. Drop any whose
  // collection is hidden; per-moment (creator-toggled) hidden state lives in
  // inprocess and isn't enumerable here — the same limitation the Mints feed
  // has — so a rare hidden moment may still be listed. A crawler that hits one
  // gets the "hidden by the creator" placeholder, not real content.
  const momentEntries: MetadataRoute.Sitemap = []
  for (const member of mints) {
    const sep = member.indexOf(':')
    if (sep <= 0) continue
    const address = member.slice(0, sep)
    const tokenId = member.slice(sep + 1)
    if (!tokenId || isHiddenCollection(address)) continue
    momentEntries.push({
      url: `${siteUrl}/moment/${address.toLowerCase()}/${tokenId}`,
      changeFrequency: 'weekly',
      priority: 0.6,
    })
    if (momentEntries.length >= maxMoments) {
      onCap?.(maxMoments)
      break
    }
  }

  return [...staticRoutes, ...collectionEntries, ...momentEntries]
}
