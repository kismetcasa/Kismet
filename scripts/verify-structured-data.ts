// Verifies the pure schema.org JSON-LD builders' load-bearing invariants so a
// regression can't silently ship malformed markup (which crawlers drop) or an
// Offer whose price contradicts the visible page (which risks a manual action):
//   1. offerAmount mirrors formatPrice's visible number exactly (wei → ETH,
//      base units → USDC, decimal passthrough) and returns null for
//      missing/zero/garbage so no bogus Offer is emitted.
//   2. A moment WITHOUT a live listing is VisualArtwork only — no Product, no
//      Offer.
//   3. A moment WITH a listing is typed [VisualArtwork, Product] and carries an
//      InStock Offer at the matching price.
//   4. Breadcrumbs are positioned 1..n over real URLs, deepest last.
//   5. FAQPage emits one Question/acceptedAnswer per pair.
//   5b. The /learn hub graph keeps mainEntity for the QUESTIONS and hangs the
//      Organization off about/publisher — the entity signal merged from the
//      retired /about page, and the one place it's easy to clobber.
//   6. serializeJsonLd escapes `<` so a string can't close the <script> early.
//
// Run: node --experimental-strip-types --import ./scripts/register-ts-alias.mjs scripts/verify-structured-data.ts
//
// offerAmount replicates lib/inprocess.formatPrice's numeric output; the
// concrete expectations below (0.1, 5) are exactly what formatPrice renders,
// so this test pins the sync without importing inprocess's heavy graph.
import {
  offerAmount,
  momentJsonLd,
  faqJsonLd,
  learnJsonLd,
  articleJsonLd,
  breadcrumbNode,
  organizationNode,
  serializeJsonLd,
} from '../lib/structuredData.ts'

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

// 1. offerAmount matches the visible formatPrice number.
const oneTenthEthWei = '100000000000000000' // 0.1 ETH
const fiveUsdcBase = '5000000' // 5 USDC (6dp)
const ethOffer = offerAmount(oneTenthEthWei, 'eth')
const usdcOffer = offerAmount(fiveUsdcBase, 'usdc')
check('wei → ETH price', ethOffer?.price === '0.1' && ethOffer?.priceCurrency === 'ETH', JSON.stringify(ethOffer))
check('base units → USDC price (emitted as ISO-4217 USD)', usdcOffer?.price === '5' && usdcOffer?.priceCurrency === 'USD', JSON.stringify(usdcOffer))
check('decimal string passthrough', offerAmount('0.25', 'eth')?.price === '0.25')
check('zero → no offer', offerAmount('0', 'eth') === null && offerAmount('0.0', 'eth') === null)
check('missing/garbage → no offer', offerAmount(undefined) === null && offerAmount('abc', 'eth') === null)
check(
  'malformed decimal → no offer',
  offerAmount('abc.def', 'eth') === null &&
    offerAmount('1.2.3', 'eth') === null &&
    offerAmount('.5', 'eth') === null,
)

// 2. No listing → VisualArtwork only.
const unlisted = momentJsonLd({
  url: 'https://kismet.art/artwork/0xabc/1',
  name: 'Sunrise',
  description: 'A generative piece',
  creator: { name: 'alice', url: 'https://kismet.art/profile/0xa11ce' },
  collection: { name: 'Dawn', url: 'https://kismet.art/collection/0xcol' },
  listing: null,
})
const unlistedArt = (unlisted['@graph'] as Record<string, unknown>[])[0]
check('unlisted is VisualArtwork only', unlistedArt['@type'] === 'VisualArtwork')
check('unlisted has no offers', !('offers' in unlistedArt))

// 3. Listing → [VisualArtwork, Product] + InStock Offer.
const listed = momentJsonLd({
  url: 'https://kismet.art/artwork/0xabc/2',
  name: 'Dusk',
  creator: { name: 'bob' },
  listing: { price: oneTenthEthWei, currency: 'eth' },
})
const listedArt = (listed['@graph'] as Record<string, unknown>[])[0]
check(
  'listed is [VisualArtwork, Product]',
  Array.isArray(listedArt['@type']) &&
    (listedArt['@type'] as string[]).includes('VisualArtwork') &&
    (listedArt['@type'] as string[]).includes('Product'),
)
const listedOffer = listedArt.offers as Record<string, unknown> | undefined
check('listed carries InStock Offer at matching price',
  listedOffer?.price === '0.1' &&
  listedOffer?.priceCurrency === 'ETH' &&
  listedOffer?.availability === 'https://schema.org/InStock')

// 3b. artMedium/encodingFormat are DERIVED from the token's MIME — factual,
// and absent (never fabricated) when the MIME is unknown. Attribute-rich
// artwork markup is what earns art-vertical relevance and AI citation; a
// guessed medium would be exactly the schema-vs-page mismatch that risks a
// manual action.
const imageArt = momentJsonLd({
  url: 'https://kismet.art/artwork/0xabc/3',
  name: 'Still',
  mime: 'image/png',
}) as { '@graph': Record<string, unknown>[] }
const videoArt = momentJsonLd({
  url: 'https://kismet.art/artwork/0xabc/4',
  name: 'Motion',
  mime: 'video/mp4',
  hasAnimation: true,
}) as { '@graph': Record<string, unknown>[] }
const unknownArt = momentJsonLd({
  url: 'https://kismet.art/artwork/0xabc/5',
  name: 'Unknown medium',
}) as { '@graph': Record<string, unknown>[] }
check(
  'image MIME → artMedium "Digital image" + encodingFormat',
  imageArt['@graph'][0].artMedium === 'Digital image' &&
    imageArt['@graph'][0].encodingFormat === 'image/png',
)
check(
  'video MIME → artMedium "Digital video"',
  videoArt['@graph'][0].artMedium === 'Digital video',
)
check(
  'unknown MIME → NO artMedium/encodingFormat (never fabricated)',
  !('artMedium' in unknownArt['@graph'][0]) &&
    !('encodingFormat' in unknownArt['@graph'][0]),
)

// 4. Breadcrumb positions and order.
const crumb = breadcrumbNode([
  { name: 'Kismet', url: 'https://kismet.art/' },
  { name: 'Dawn', url: 'https://kismet.art/collection/0xcol' },
  { name: 'Dusk', url: 'https://kismet.art/artwork/0xabc/2' },
]) as { itemListElement: { position: number; name: string; item: string }[] }
check('breadcrumb positions are 1..n', crumb.itemListElement.every((e, i) => e.position === i + 1))
check('breadcrumb deepest last', crumb.itemListElement[2]?.name === 'Dusk')
// The listed moment's own breadcrumb (no collection) is Home › Moment.
const listedCrumb = (listed['@graph'] as Record<string, unknown>[])[1] as {
  itemListElement: unknown[]
}
check('breadcrumb omits absent collection', listedCrumb.itemListElement.length === 2)

// 5. FAQPage shape.
const faq = faqJsonLd([
  { question: 'How do I mint artwork?', answer: 'Connect a wallet and upload your file.' },
  { question: 'What is onchain art?', answer: 'Art whose ownership is recorded on a blockchain.' },
]) as { '@type': string; mainEntity: { '@type': string; acceptedAnswer: { text: string } }[] }
check('FAQPage type', faq['@type'] === 'FAQPage')
check('FAQ one entry per pair', faq.mainEntity.length === 2 && faq.mainEntity[0]['@type'] === 'Question')
check('FAQ answer text preserved', faq.mainEntity[0].acceptedAnswer.text.startsWith('Connect a wallet'))

// 5b. /learn hub graph. This is the entity surface merged from the retired
// /about page (2026-08), and its one subtlety: FAQPage.mainEntity belongs to
// the QUESTIONS, so the Organization must ride on about/publisher instead.
// Setting mainEntity to the Org here would silently destroy the FAQ markup —
// pin both halves.
const learn = learnJsonLd([
  { question: 'Who runs Kismet?', answer: 'Kismet Casa, a hybrid residency program.' },
]) as { '@graph': Record<string, unknown>[] }
const learnFaq = learn['@graph'].find((n) => n['@type'] === 'FAQPage') as
  | Record<string, unknown>
  | undefined
check('learn graph contains the FAQPage node', learnFaq !== undefined)
check(
  'learn FAQPage keeps mainEntity for the questions',
  Array.isArray(learnFaq?.mainEntity) &&
    (learnFaq!.mainEntity as Record<string, unknown>[])[0]['@type'] === 'Question',
)
check(
  'learn FAQPage points about + publisher at the Organization @id',
  (learnFaq?.about as { '@id': string })?.['@id'] === 'https://kismet.art/#organization' &&
    (learnFaq?.publisher as { '@id': string })?.['@id'] === 'https://kismet.art/#organization',
)
check(
  'learn graph includes the Organization node + a 2-level breadcrumb',
  learn['@graph'].some((n) => n['@type'] === 'Organization') &&
    learn['@graph'].some(
      (n) => n['@type'] === 'BreadcrumbList' && (n.itemListElement as unknown[]).length === 2,
    ),
)

// 5c. Article carries dates + Organization author/publisher by reference.
const article = articleJsonLd({
  url: 'https://kismet.art/learn/how-to-mint-onchain-art',
  headline: 'How to mint onchain art',
  description: 'Step by step.',
  datePublished: '2026-07-10',
  dateModified: '2026-07-10',
  breadcrumb: [
    { name: 'Kismet', url: 'https://kismet.art/' },
    { name: 'Learn', url: 'https://kismet.art/learn' },
    { name: 'How to mint', url: 'https://kismet.art/learn/how-to-mint-onchain-art' },
  ],
}) as { '@graph': Record<string, unknown>[] }
const articleNode = article['@graph'][0]
check('Article carries datePublished + dateModified',
  articleNode.datePublished === '2026-07-10' && articleNode.dateModified === '2026-07-10')
check('Article author/publisher reference the Organization @id',
  (articleNode.author as { '@id': string })?.['@id'] === 'https://kismet.art/#organization' &&
  (articleNode.publisher as { '@id': string })?.['@id'] === 'https://kismet.art/#organization')
check('Article graph includes the Organization node + a 3-level breadcrumb',
  article['@graph'].some((n) => n['@type'] === 'Organization') &&
  article['@graph'].some((n) => n['@type'] === 'BreadcrumbList' &&
    (n.itemListElement as unknown[]).length === 3))

// 5d. Organization sameAs carries the owner-confirmed profiles OF KISMET
// ITSELF — https only, and present at all (an empty sameAs silently weakens
// entity resolution; a wrong one misattributes the brand, so pin the exact
// set). Kismet Casa's site must NOT be in sameAs: sameAs means "same
// entity", and Kismet Casa is a distinct parent entity — asserting both
// sameAs and parentOrganization for one URL is the contradiction this
// check guards against.
const org = organizationNode() as {
  name?: string
  alternateName?: string[]
  sameAs?: string[]
  parentOrganization?: { '@type': string; '@id': string; name: string; url: string }
}
check(
  'Organization sameAs = X + Farcaster only (no Kismet Casa)',
  Array.isArray(org.sameAs) &&
    org.sameAs.length === 2 &&
    org.sameAs.includes('https://x.com/kismetdotart') &&
    org.sameAs.includes('https://farcaster.xyz/kismet') &&
    org.sameAs.every((u) => u.startsWith('https://')),
)
// 5e. The cross-site entity join: parentOrganization = Kismet Casa under the
// exact @id kismetcasa.xyz emits for itself (…/#organization). This pair of
// values is the contract with that site's JSON-LD (see SEO.md "Cross-site
// SEO with kismetcasa.xyz") — a drifted @id or url silently unlinks the two
// entities in the knowledge graph, so pin them verbatim.
check(
  'Organization parentOrganization = Kismet Casa with the cross-site @id',
  org.parentOrganization?.['@type'] === 'Organization' &&
    org.parentOrganization?.['@id'] === 'https://www.kismetcasa.xyz/#organization' &&
    org.parentOrganization?.name === 'Kismet Casa' &&
    org.parentOrganization?.url === 'https://www.kismetcasa.xyz',
)
// Primary name "Kismet" + alternateName "Kismet Art" — the pairing that lets
// the brand read as "Kismet" everywhere while preserving the "kismet art"
// query association. Pinned so a future brand-cleanup can't drop it.
check(
  'Organization name = Kismet, alternateName preserves Kismet Art',
  org.name === 'Kismet' &&
    Array.isArray(org.alternateName) &&
    org.alternateName.includes('Kismet Art'),
)

// 6. Serializer escapes `<`.
const serialized = serializeJsonLd({ name: 'a</script><b>x' })
check('serializeJsonLd escapes `<`', !serialized.includes('</script>') && serialized.includes('\\u003c'))

if (failures > 0) {
  console.error(`\n${failures} structured-data check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll structured-data checks passed.')
