import type { MetadataRoute } from 'next'
import { SITE_URL } from '@/lib/siteUrl'
import { getUserCollections, getCreatedMintsSet, getCollectionMetaBatch } from '@/lib/kv'
import { getHiddenCollectionsSet } from '@/lib/hiddenCollections'
import { getHiddenUsersSet } from '@/lib/hidden-users'
import { buildSitemapEntries } from '@/lib/sitemapEntries'

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
  { url: `${SITE_URL}/mint`, changeFrequency: 'monthly', priority: 0.5 },
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

    // getCreatedMintsSet deliberately does NOT catch (see lib/kv.ts) so a
    // failure isn't memoized as "no mints". Isolate it with its own catch so a
    // mints-read blip still yields static + collection entries rather than
    // collapsing the whole sitemap to static-only.
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
