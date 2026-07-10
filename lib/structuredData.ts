import { SITE_URL } from './siteUrl'

// schema.org JSON-LD for the homepage. Gives search engines an explicit
// entity for the Kismet brand (name, logo, description) plus the canonical
// site URL, which strengthens brand-SERP / knowledge-panel presentation and
// links the WebSite node to its publisher Organization.
//
// No SearchAction (sitelinks searchbox): search on Kismet is an in-app
// overlay with no indexable results URL, and declaring a searchbox target
// that doesn't resolve is worse than omitting it.
//
// Rendered as a <script type="application/ld+json"> from the homepage. All
// values are static constants, so serializing with JSON.stringify into
// dangerouslySetInnerHTML carries no injection surface.
export function homeJsonLd(): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': `${SITE_URL}/#organization`,
        name: 'Kismet',
        url: SITE_URL,
        logo: `${SITE_URL}/logo.png`,
        description: 'Artists and collectors converge on Kismet',
      },
      {
        '@type': 'WebSite',
        '@id': `${SITE_URL}/#website`,
        name: 'Kismet',
        url: SITE_URL,
        publisher: { '@id': `${SITE_URL}/#organization` },
      },
    ],
  }
}
