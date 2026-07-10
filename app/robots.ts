import type { MetadataRoute } from 'next'
import { SITE_URL } from '@/lib/siteUrl'

// Crawl policy for search engines. Static route — no dynamic data — so
// Next prerenders it to /robots.txt at build time.
//
// The content surfaces (/, /moment, /collection, /profile, /mint, /agent)
// stay crawlable via the top-level allow. We disallow:
//   - /api/       machine endpoints, never a landing page
//   - /admin      operator-only dashboard (also noindex'd at the route)
//   - /permissions per-wallet dashboard that renders empty without a
//                 connected wallet — nothing worth indexing
// The sitemap + host lines point crawlers at the canonical apex and the
// generated sitemap (app/sitemap.ts).
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/api/', '/admin', '/permissions'],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  }
}
