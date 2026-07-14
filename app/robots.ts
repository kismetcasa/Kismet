import type { MetadataRoute } from 'next'
import { SITE_URL } from '@/lib/siteUrl'

// Crawl policy for search engines. Static route — no dynamic data — so
// Next prerenders it to /robots.txt at build time.
//
// The content surfaces (/, /moment, /collection, /profile, /learn, /mint,
// /market, /agent) stay crawlable via the top-level allow. We disallow:
//   - /api/   machine endpoints, never a landing page. (Note: the moment/
//             collection/profile opengraph-image routes live under their page
//             paths, not /api, so share images stay fetchable.)
//   - /admin  operator-only dashboard. Crawl prevention is the priority here;
//             the whole subtree is ALSO noindexed (app/admin/layout.tsx) as
//             defense in depth for the day this rule is ever loosened.
//
// /permissions is deliberately NOT disallowed: it must stay OUT of the index,
// and Google's documented mechanism for that is the noindex robots meta (set
// in app/permissions/page.tsx) — which crawlers can only read if the page is
// crawlable. Disallowing it would hide the noindex and let an externally
// linked URL surface as an "indexed without content" stub.
//
// AI crawlers (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, etc.) are
// admitted by the wildcard ON PURPOSE: the platform's goal is to be findable
// and citable by AI assistants, and that includes training corpora so future
// models know Kismet natively. To later allow answer-engines but refuse
// training, add per-agent groups here (e.g. `{ userAgent: 'GPTBot',
// disallow: '/' }` blocks OpenAI training while ChatGPT search uses
// OAI-SearchBot) — see SEO.md.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/api/', '/admin'],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  }
}
