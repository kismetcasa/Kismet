import type { MetadataRoute } from 'next'
import { SITE_URL } from '@/lib/siteUrl'
import { getUserCollections, getCreatedMintsSet, getCollectionMetaBatch } from '@/lib/kv'
import { getHiddenCollectionsSet } from '@/lib/hiddenCollections'
import { getHiddenUsersSet } from '@/lib/hidden-users'
import { getHiddenIdentityClosure } from '@/lib/addressUnion'
import { resolveUri } from '@/lib/inprocess'
import { buildSitemapEntries } from '@/lib/sitemapEntries'
import { GUIDES } from '@/app/learn/guides'

// Regenerate at most hourly. Crawlers refetch sitemaps on their own cadence,
// so an hour of staleness on a freshly minted moment/collection is immaterial
// — and the cap keeps the Redis fan-out (a couple of SMEMBERS + one MGET) off
// the hot path for every bot hit.
export const revalidate = 3600

// Bound the moment listing well under the 50,000-URL / 50 MB per-file sitemap
// limit, leaving headroom for the static + collection entries. If created-mints
// ever grows past this we split via generateSitemaps; until then a single file
// is simpler and correct.
const MAX_MOMENTS = 40_000

// Crawlable app pages that aren't address-scoped. Everything else in the
// sitemap is generated from KV below. /admin and /permissions are deliberately
// excluded (disallowed in robots.ts / noindex at the route).
const STATIC_ROUTES: MetadataRoute.Sitemap = [
  { url: `${SITE_URL}/`, changeFrequency: 'hourly', priority: 1 },
  { url: `${SITE_URL}/learn`, changeFrequency: 'monthly', priority: 0.8 },
  // Each guide's lastModified tracks its own `updated` date, so a content edit
  // (with the date bumped) resurfaces just that page to crawlers.
  ...GUIDES.map((g) => ({
    url: `${SITE_URL}/learn/${g.slug}`,
    lastModified: new Date(g.updated),
    changeFrequency: 'monthly' as const,
    priority: 0.7,
  })),
  { url: `${SITE_URL}/mint`, changeFrequency: 'monthly', priority: 0.5 },
  { url: `${SITE_URL}/market`, changeFrequency: 'daily', priority: 0.6 },
  { url: `${SITE_URL}/agent`, changeFrequency: 'monthly', priority: 0.5 },
]

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  try {
    // getUserCollections / getHiddenCollectionsSet / getHiddenUsersSet each
    // swallow Redis errors internally and return a safe empty default, so this
    // Promise.all won't reject on their account.
    const [collections, hiddenCollections, hiddenUsers] = await Promise.all([
      getUserCollections(),
      getHiddenCollectionsSet(),
      getHiddenUsersSet(),
    ])

    // getHiddenIdentityClosure and getCreatedMintsSet can THROW (unlike the
    // getters above). Isolate each so a blip degrades one facet instead of
    // collapsing the whole sitemap to static-only:
    //   • closure failure → profiles emitted unfiltered. Safe: the profile page
    //     itself returns a real 404 for hidden identities (see its
    //     generateMetadata), so a leaked URL is crawled and dropped, not indexed.
    //   • mints failure → moments omitted, collections/profiles still emitted.
    let hiddenIdentities: Set<string> = new Set()
    try {
      hiddenIdentities = await getHiddenIdentityClosure()
    } catch (err) {
      console.error('[sitemap] hidden-identity closure read failed; profiles unfiltered', err)
    }
    let mints: Set<string> = new Set()
    try {
      mints = await getCreatedMintsSet()
    } catch (err) {
      console.error('[sitemap] created-mints read failed; omitting moments', err)
    }

    const metas = await getCollectionMetaBatch(collections)

    return buildSitemapEntries({
      siteUrl: SITE_URL,
      staticRoutes: STATIC_ROUTES,
      collections,
      mints,
      metas,
      hiddenCollections,
      hiddenUsers,
      hiddenIdentities,
      resolveImage: resolveUri,
      maxMoments: MAX_MOMENTS,
      onCap: (max) =>
        console.warn(`[sitemap] moment cap ${max} reached — split via generateSitemaps`),
    })
  } catch (err) {
    // Never 500 the sitemap on an unexpected failure — a failing sitemap tells
    // crawlers nothing, whereas a static-only one still exposes the core routes
    // for discovery.
    console.error('[sitemap] falling back to static routes', err)
    return STATIC_ROUTES
  }
}
