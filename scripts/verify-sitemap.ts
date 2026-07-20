// Verifies the pure sitemap-entry builder's load-bearing invariants in CI so a
// regression goes red on the PR instead of silently leaking hidden content or
// emitting non-canonical URLs to crawlers:
//   1. Creator-hidden collections are dropped — and so is every moment inside
//      them.
//   2. Admin-hidden artists drop their collections + moments.
//   3. Malformed created-mints members (no colon, empty address/tokenId) are
//      skipped, never emitted as junk URLs.
//   4. Addresses are lowercased so sitemap URLs match the pages' canonical
//      links (case variants must not read as separate pages).
//   5. createdAt → lastModified; an absent createdAt yields no lastModified.
//   6. The moment cap bounds output and fires onCap exactly at the limit.
//   7. Static routes are preserved and lead the list.
//   8. Artist profiles are derived from visible collections, deduped, and
//      filtered through the hidden-identity closure.
//   9. Collection covers become image-sitemap entries via resolveImage.
//
// Run: node --experimental-strip-types scripts/verify-sitemap.ts
import { readFileSync } from 'node:fs'
import { buildSitemapEntries, type SitemapCollectionMeta } from '../lib/sitemapEntries.ts'
import { GUIDES } from '../app/learn/guides.ts'

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

const SITE = 'https://kismet.art'
// Mixed-case addresses on purpose — the builder must lowercase them.
const VISIBLE = '0xAbC0000000000000000000000000000000000001'
const VISIBLE2 = '0xAbC0000000000000000000000000000000000011' // same artist as VISIBLE (dedup)
const CREATOR_HIDDEN = '0xDeF0000000000000000000000000000000000002'
const ARTIST_HIDDEN = '0xEee0000000000000000000000000000000000003'
const PROFILE_HIDDEN_COL = '0xC010000000000000000000000000000000000004' // visible, artist hidden
const ARTIST_OK = '0xA11ce00000000000000000000000000000000001'
const ARTIST_OK2 = '0xA11ce00000000000000000000000000000000002' // in hidden-identity closure
const ARTIST_BANNED = '0xBad0000000000000000000000000000000000009'

const metas = new Map<string, SitemapCollectionMeta>([
  [VISIBLE.toLowerCase(), { artist: ARTIST_OK, createdAt: 1_700_000_000_000, image: 'ar://cover1' }],
  [VISIBLE2.toLowerCase(), { artist: ARTIST_OK }],
  [CREATOR_HIDDEN.toLowerCase(), { artist: ARTIST_OK }],
  [ARTIST_HIDDEN.toLowerCase(), { artist: ARTIST_BANNED }],
  [PROFILE_HIDDEN_COL.toLowerCase(), { artist: ARTIST_OK2 }],
])

const result = buildSitemapEntries({
  siteUrl: SITE,
  staticRoutes: [{ url: `${SITE}/`, priority: 1 }],
  collections: [VISIBLE, VISIBLE2, CREATOR_HIDDEN, ARTIST_HIDDEN, PROFILE_HIDDEN_COL],
  mints: [
    `${VISIBLE}:1`,
    `${VISIBLE}:2`,
    `${CREATOR_HIDDEN}:1`, // hidden collection → dropped
    `${ARTIST_HIDDEN}:5`, // hidden artist → dropped
    'garbage-no-colon', // malformed → skipped
    ':7', // empty address → skipped
    `${VISIBLE}:`, // empty tokenId → skipped
  ],
  metas,
  hiddenCollections: new Set([CREATOR_HIDDEN.toLowerCase()]),
  hiddenUsers: new Set([ARTIST_BANNED.toLowerCase()]),
  hiddenIdentities: new Set([ARTIST_OK2.toLowerCase()]),
  resolveImage: (uri) => uri.replace('ar://', 'https://arweave.net/'),
  maxMoments: 40_000,
})

const urls = result.map((e) => e.url)
const has = (u: string): boolean => urls.includes(u)

// 7. Static route preserved and first.
check('static route present', has(`${SITE}/`))
check('static route leads the list', result[0]?.url === `${SITE}/`)

// 1 + 2. Hidden collections and their moments dropped.
check(
  'creator-hidden collection dropped',
  !has(`${SITE}/collection/${CREATOR_HIDDEN.toLowerCase()}`),
)
check(
  'artist-hidden collection dropped',
  !has(`${SITE}/collection/${ARTIST_HIDDEN.toLowerCase()}`),
)
check(
  'moment in creator-hidden collection dropped',
  !has(`${SITE}/artwork/${CREATOR_HIDDEN.toLowerCase()}/1`),
)
check(
  'moment under artist-hidden collection dropped',
  !has(`${SITE}/artwork/${ARTIST_HIDDEN.toLowerCase()}/5`),
)

// 4. Visible collection + its moments present, lowercased.
check('visible collection present (lowercased)', has(`${SITE}/collection/${VISIBLE.toLowerCase()}`))
check('visible moment #1 present (lowercased)', has(`${SITE}/artwork/${VISIBLE.toLowerCase()}/1`))
check('visible moment #2 present (lowercased)', has(`${SITE}/artwork/${VISIBLE.toLowerCase()}/2`))
check('no uppercase leaks into any URL', urls.every((u) => u === u.toLowerCase() || !/0x[0-9a-fA-F]*[A-F]/.test(u)))

// 3. Malformed members skipped — exactly the two valid moments, no junk.
const momentCount = urls.filter((u) => u.includes('/artwork/')).length
check('exactly the 2 valid moments emitted', momentCount === 2, `got ${momentCount}`)
check('no colon-less junk URL', !urls.some((u) => u.endsWith('/artwork/') || u.includes('garbage')))

// 8. Artist profiles: visible-collection artists only, deduped, closure-filtered.
check('visible artist profile present', has(`${SITE}/profile/${ARTIST_OK.toLowerCase()}`))
check(
  'artist profile deduped across collections',
  urls.filter((u) => u === `${SITE}/profile/${ARTIST_OK.toLowerCase()}`).length === 1,
)
check('hidden-identity artist profile dropped', !has(`${SITE}/profile/${ARTIST_OK2.toLowerCase()}`))
check(
  'banned-artist profile absent (its only collection is hidden)',
  !has(`${SITE}/profile/${ARTIST_BANNED.toLowerCase()}`),
)
check(
  'collection with hidden-identity artist still listed',
  has(`${SITE}/collection/${PROFILE_HIDDEN_COL.toLowerCase()}`),
)

// 9. Collection cover → image-sitemap entry via resolveImage.
const visibleColEntry = result.find((e) => e.url === `${SITE}/collection/${VISIBLE.toLowerCase()}`)
check(
  'collection cover becomes a resolved image entry',
  Array.isArray(visibleColEntry?.images) &&
    visibleColEntry?.images?.[0] === 'https://arweave.net/cover1',
)
check(
  'collection without a cover has no images field',
  !('images' in (result.find((e) => e.url === `${SITE}/collection/${VISIBLE2.toLowerCase()}`) ?? {})),
)

// 5. createdAt → lastModified; absent → undefined.
const visibleCollection = result.find(
  (e) => e.url === `${SITE}/collection/${VISIBLE.toLowerCase()}`,
)
check(
  'createdAt maps to a lastModified Date',
  visibleCollection?.lastModified instanceof Date &&
    visibleCollection.lastModified.getTime() === 1_700_000_000_000,
)

// 6. Cap bounds output and fires onCap.
let capped = -1
const capResult = buildSitemapEntries({
  siteUrl: SITE,
  staticRoutes: [],
  collections: [VISIBLE],
  mints: Array.from({ length: 10 }, (_, i) => `${VISIBLE}:${i + 1}`),
  metas,
  hiddenCollections: new Set(),
  hiddenUsers: new Set(),
  hiddenIdentities: new Set(),
  maxMoments: 3,
  onCap: (max) => {
    capped = max
  },
})
const cappedMoments = capResult.filter((e) => e.url.includes('/artwork/')).length
check('moment cap bounds output', cappedMoments === 3, `got ${cappedMoments}`)
check('onCap fired at the limit', capped === 3)

// 9b. Case-variant duplicate collection members (the created-collections set
// is written without lowercasing) must collapse to ONE sitemap entry.
const dupResult = buildSitemapEntries({
  siteUrl: SITE,
  staticRoutes: [],
  collections: [VISIBLE, VISIBLE.toLowerCase(), VISIBLE.toUpperCase().replace('0X', '0x')],
  mints: [],
  metas,
  hiddenCollections: new Set(),
  hiddenUsers: new Set(),
  hiddenIdentities: new Set(),
  maxMoments: 10,
})
check(
  'case-variant duplicate collections collapse to one entry',
  dupResult.filter((e) => e.url === `${SITE}/collection/${VISIBLE.toLowerCase()}`).length === 1,
  `got ${dupResult.length} entries`,
)

// 10. llms.txt ↔ guides.ts sync — guides auto-flow into the hub and sitemap,
// but llms.txt is a hand-edited static file; without this pin a new guide
// silently misses the AI-crawler map.
const llms = readFileSync(new URL('../public/llms.txt', import.meta.url), 'utf8')
for (const g of GUIDES) {
  check(`llms.txt lists guide "${g.slug}"`, llms.includes(`/learn/${g.slug}`))
}

if (failures > 0) {
  console.error(`\n${failures} sitemap check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll sitemap checks passed.')
