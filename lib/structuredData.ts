import { formatEther, formatUnits } from 'viem'
import { SITE_URL } from './siteUrl'

// schema.org JSON-LD builders. All pure functions returning plain objects so
// they're unit-testable (scripts/verify-structured-data.ts) and render
// identically on the server. Rendered via <JsonLd> (components/JsonLd.tsx),
// which requires the markup in the SSR HTML — the form Google and AI crawlers
// consume. Guiding rules baked in here:
//   • Emit only what the page visibly shows (a mismatch between JSON-LD and
//     on-page price/availability can trigger a site-wide manual action), so an
//     Offer is produced ONLY when there's a live listing with a real price.
//   • Prices mirror lib/inprocess.formatPrice's numeric output exactly, so the
//     structured price equals the number the buyer sees.

const ORG_ID = `${SITE_URL}/#organization`
const WEBSITE_ID = `${SITE_URL}/#website`

// Verified public brand profiles for the entity (sameAs) — reinforces
// knowledge-panel / entity resolution. Owner-confirmed URLs only (a wrong
// sameAs misattributes the brand): the platform's X and Farcaster profiles,
// plus the Kismet Casa site — the organization behind the platform.
const SAME_AS: string[] = [
  'https://x.com/kismetdotart',
  'https://farcaster.xyz/kismet',
  'https://www.kismetcasa.xyz',
]

// The Organization node. Shared by reference (@id) from WebSite, breadcrumbs,
// and product/offer sellers so the whole graph resolves to one entity.
export function organizationNode(): Record<string, unknown> {
  return {
    '@type': 'Organization',
    '@id': ORG_ID,
    name: 'Kismet',
    url: SITE_URL,
    logo: `${SITE_URL}/logo.png`,
    image: `${SITE_URL}/icon.png`,
    description:
      'Kismet is an onchain art platform on Base where artists mint moments, create collections, and collectors discover, collect, and trade digital art.',
    ...(SAME_AS.length ? { sameAs: SAME_AS } : {}),
  }
}

export function websiteNode(): Record<string, unknown> {
  return {
    '@type': 'WebSite',
    '@id': WEBSITE_ID,
    name: 'Kismet',
    url: SITE_URL,
    publisher: { '@id': ORG_ID },
  }
}

// Homepage graph: Organization (the brand entity) + WebSite (the property).
// No SearchAction — search is an in-app overlay with no indexable results URL.
export function homeJsonLd(): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@graph': [organizationNode(), websiteNode()],
  }
}

// BreadcrumbList from an ordered list of {name, url}. Every url must be a real,
// crawlable page (Google drops breadcrumbs whose items don't resolve).
export function breadcrumbNode(
  items: { name: string; url: string }[],
): Record<string, unknown> {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: item.url,
    })),
  }
}

// Numeric price + currency ticker for an Offer, matching formatPrice's visible
// number exactly (same trailing-zero trim). Returns null for missing/zero/
// unparseable prices so we never emit a bogus or "free" Offer — those pages
// render as VisualArtwork only. `price` is either a decimal string ("0.1") or
// base units (wei / USDC 6dp), mirroring the listing shape.
export function offerAmount(
  price: string | undefined,
  currency: 'eth' | 'usdc' = 'eth',
): { price: string; priceCurrency: string } | null {
  if (!price) return null
  let decimal: string
  if (price.includes('.')) {
    // Strict numeric check — a malformed decimal ("abc.def", "1.2.3") must
    // yield NO offer, not a garbage price in the structured data.
    if (!/^\d+\.\d+$/.test(price)) return null
    decimal = price
  } else {
    let value: bigint
    try {
      value = BigInt(price)
    } catch {
      return null
    }
    if (value === 0n) return null
    decimal = currency === 'usdc' ? formatUnits(value, 6) : formatEther(value)
  }
  const trimmed = decimal.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
  if (trimmed === '' || trimmed === '0') return null
  return { price: trimmed, priceCurrency: currency === 'usdc' ? 'USDC' : 'ETH' }
}

export interface MomentJsonLdInput {
  url: string // canonical moment URL (absolute)
  name: string
  description?: string
  image?: string // absolute artwork image URL (poster for video)
  creator?: { name: string; url?: string }
  collection?: { name: string; url: string }
  // Live listing, if any. Only a non-null offerAmount() result produces an Offer.
  listing?: { price: string; currency: 'eth' | 'usdc' } | null
}

// A moment = a digital artwork that may also be for sale. We type the node as
// both VisualArtwork (art-native attributes for AI + niche crawlers) and, when
// listed, Product (so Google surfaces the merchant-listing price). Breadcrumb:
// Home › [Collection] › Moment.
export function momentJsonLd(input: MomentJsonLdInput): Record<string, unknown> {
  const offer = input.listing
    ? offerAmount(input.listing.price, input.listing.currency)
    : null

  const artwork: Record<string, unknown> = {
    '@type': offer ? ['VisualArtwork', 'Product'] : 'VisualArtwork',
    '@id': `${input.url}#artwork`,
    name: input.name,
    url: input.url,
    artform: 'Digital art',
    ...(input.description ? { description: input.description } : {}),
    ...(input.image ? { image: input.image } : {}),
    ...(input.creator
      ? {
          creator: {
            '@type': 'Person',
            name: input.creator.name,
            ...(input.creator.url ? { url: input.creator.url } : {}),
          },
        }
      : {}),
    ...(input.collection
      ? {
          isPartOf: {
            '@type': 'Collection',
            name: input.collection.name,
            url: input.collection.url,
          },
        }
      : {}),
    ...(offer
      ? {
          offers: {
            '@type': 'Offer',
            price: offer.price,
            priceCurrency: offer.priceCurrency,
            availability: 'https://schema.org/InStock',
            url: input.url,
          },
        }
      : {}),
  }

  const crumbs = [{ name: 'Kismet', url: `${SITE_URL}/` }]
  if (input.collection) crumbs.push({ name: input.collection.name, url: input.collection.url })
  crumbs.push({ name: input.name, url: input.url })

  return {
    '@context': 'https://schema.org',
    '@graph': [artwork, breadcrumbNode(crumbs)],
  }
}

export interface CollectionJsonLdInput {
  url: string
  name: string
  description?: string
  image?: string
  creator?: { name: string; url?: string }
}

// A collection page: a curated set of moments. CollectionPage + breadcrumb.
export function collectionJsonLd(
  input: CollectionJsonLdInput,
): Record<string, unknown> {
  const collection: Record<string, unknown> = {
    '@type': 'CollectionPage',
    '@id': `${input.url}#collection`,
    name: input.name,
    url: input.url,
    isPartOf: { '@id': WEBSITE_ID },
    ...(input.description ? { description: input.description } : {}),
    ...(input.image ? { image: input.image } : {}),
    ...(input.creator
      ? {
          creator: {
            '@type': 'Person',
            name: input.creator.name,
            ...(input.creator.url ? { url: input.creator.url } : {}),
          },
        }
      : {}),
  }

  return {
    '@context': 'https://schema.org',
    '@graph': [
      collection,
      breadcrumbNode([
        { name: 'Kismet', url: `${SITE_URL}/` },
        { name: input.name, url: input.url },
      ]),
    ],
  }
}

export interface ProfileJsonLdInput {
  url: string
  name: string
  description?: string
  image?: string
  sameAs?: string[]
}

// An artist/collector profile. ProfilePage wrapping a Person entity — the
// pattern Google documents for profile pages — plus a breadcrumb.
export function profileJsonLd(
  input: ProfileJsonLdInput,
): Record<string, unknown> {
  const person: Record<string, unknown> = {
    '@type': 'Person',
    '@id': `${input.url}#person`,
    name: input.name,
    url: input.url,
    ...(input.image ? { image: input.image } : {}),
    ...(input.description ? { description: input.description } : {}),
    ...(input.sameAs && input.sameAs.length ? { sameAs: input.sameAs } : {}),
  }

  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'ProfilePage',
        '@id': `${input.url}#profilepage`,
        url: input.url,
        mainEntity: { '@id': `${input.url}#person` },
        isPartOf: { '@id': WEBSITE_ID },
      },
      person,
      breadcrumbNode([
        { name: 'Kismet', url: `${SITE_URL}/` },
        { name: input.name, url: input.url },
      ]),
    ],
  }
}

export interface ArticleJsonLdInput {
  url: string
  headline: string
  description: string
  datePublished: string // ISO date, e.g. '2026-07-10'
  dateModified: string // bump on edits — freshness is an AI-ranking signal
  breadcrumb: { name: string; url: string }[]
  image?: string
}

// Article for a guide/informational page, authored + published by the Kismet
// Organization (included in the graph so the author/publisher @id resolves).
// Paired on the page with faqJsonLd() for the guide's Q&A.
export function articleJsonLd(input: ArticleJsonLdInput): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Article',
        '@id': `${input.url}#article`,
        headline: input.headline,
        description: input.description,
        datePublished: input.datePublished,
        dateModified: input.dateModified,
        inLanguage: 'en',
        author: { '@id': ORG_ID },
        publisher: { '@id': ORG_ID },
        mainEntityOfPage: input.url,
        ...(input.image ? { image: input.image } : {}),
      },
      organizationNode(),
      breadcrumbNode(input.breadcrumb),
    ],
  }
}

// FAQPage from Q&A pairs. The highest-leverage type for AI answer engines:
// each pair is a discrete, machine-readable citation candidate. Answers should
// be self-contained and declarative (see the /learn content).
export function faqJsonLd(
  items: { question: string; answer: string }[],
): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer },
    })),
  }
}

// Serialize for a <script type="application/ld+json">, escaping `<` so no
// string field can close the script element early (JSON-LD XSS guard).
export function serializeJsonLd(data: Record<string, unknown>): string {
  return JSON.stringify(data).replace(/</g, '\\u003c')
}
