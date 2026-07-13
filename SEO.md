# SEO & AI-discoverability

How Kismet is optimized for search engines and AI answer engines (ChatGPT,
Perplexity, Google AI Overviews), what's wired up, and the operational steps
that only a human with console access can finish.

## What's implemented (in code)

**Technical foundation**
- `app/robots.ts` → `/robots.txt`: allows content, disallows `/api` `/admin`
  `/permissions`, points to the sitemap + canonical host.
- `app/sitemap.ts` → `/sitemap.xml`: static routes, curated collections (with
  cover images via the `<image:image>` extension), artist profiles, and every
  Kismet-minted moment. Hidden collections / hidden artists / hidden identities
  are filtered out; degrades to static routes on a Redis blip; revalidates
  hourly; capped under the 50k-URL per-file limit.
- Canonical URLs (`alternates.canonical`, lowercased address) on moment,
  collection, and profile pages — collapses address-case variants.
- Thin/empty moments (no title, description, or image) are `noindex`ed to
  protect crawl budget; titled or image-bearing art stays indexable.

**Structured data** (`lib/structuredData.ts`, rendered via `components/JsonLd.tsx`)
- Homepage: `Organization` + `WebSite`.
- Moment: `VisualArtwork`, upgraded to `Product` + `Offer` when a live listing
  exists (price mirrors the visible `formatPrice` number exactly). Breadcrumb.
- Collection: `CollectionPage` + creator + breadcrumb.
- Profile: `ProfilePage` + `Person` + breadcrumb (suppressed for hidden identities).
- `/learn` + guides: `FAQPage`, `Article`, `BreadcrumbList`.

All JSON-LD is server-rendered (crawlers ignore JS-injected markup) and escapes
`<` to prevent script-breakout.

**Content & GEO**
- `/learn` hub + `/learn/[slug]` guides: front-loaded, declarative answers to
  the intent queries ("how to mint artwork", "onchain minting platform",
  "onchain art marketplace"), mirrored into `FAQPage` schema.
- `public/llms.txt`: curated content map for AI crawlers.
- `components/SiteFooter.tsx`: site-wide crawlable internal links.
- Keyword-informed titles/descriptions; `sr-only` H1 on the homepage.

**Verification (`app/layout.tsx`)** — `GOOGLE_SITE_VERIFICATION` /
`BING_SITE_VERIFICATION` env vars render the ownership `<meta>` tags.

## Operational checklist (needs console access)

1. **Verify ownership.**
   - Google Search Console (search.google.com/search-console) → add
     `kismet.art` → "HTML tag" method → copy the token → set
     `GOOGLE_SITE_VERIFICATION` → redeploy → click Verify.
   - Bing Webmaster Tools (bing.com/webmasters) → add site → copy the
     `msvalidate.01` token → set `BING_SITE_VERIFICATION` → redeploy → verify.
     **Do not skip Bing:** ChatGPT draws the majority of its citations from
     Bing's index, so Bing coverage ≈ ChatGPT visibility.
2. **Submit the sitemap** in both consoles: `https://kismet.art/sitemap.xml`.
3. **Validate rich results.** Run a few moment/collection/profile/learn URLs
   through the [Rich Results Test](https://search.google.com/test/rich-results)
   and the [Schema Validator](https://validator.schema.org/). Fix any error
   before it becomes a manual action. Include one moment WITH a live listing:
   its Offer uses crypto tickers (ETH/USDC) for priceCurrency — explicitly
   allowed by schema.org, but Google's price display for non-ISO-4217
   currencies is best-effort, so observe how the test renders it.
4. **Socials — done.** `SAME_AS` (lib/structuredData.ts) and the footer carry
   the owner-confirmed profiles: x.com/kismetdotart, farcaster.xyz/kismet, and
   www.kismetcasa.xyz. Keep the two lists in sync if they ever change. The
   reciprocal link — kismetcasa.xyz linking to kismet.art — is the
   highest-authority backlink the team controls; add it on that site.
5. **Monitor.** Watch Search Console Coverage/Indexing (how many moments get
   indexed — the thin-content signal), Core Web Vitals, and the queries you
   surface for. Track AI visibility separately (share-of-answer tools).

## Host & crawl-policy decisions (validated, with rationale)

- **www → apex**: DNS resolves `www.kismet.art` to the same box as the apex, so
  next.config.mjs carries a permanent host-based redirect (www → apex) —
  versioned in-repo, active regardless of proxy config. **http → https stays at
  the proxy**; post-deploy, from any normal network, verify both:
  `curl -sI https://www.kismet.art | head -3` and
  `curl -sI http://kismet.art | head -3` → each should 301/308 to
  `https://kismet.art`. If http doesn't redirect, enable force-HTTPS in
  Coolify/Traefik.
- **Non-canonical hosts are noindexed at the header level** (next.config.mjs):
  any request whose Host isn't the canonical one — staging domains, direct-IP,
  previews — gets `X-Robots-Tag: noindex, nofollow` on every route. No
  per-host Coolify config to remember.
- **/permissions**: noindex only, NOT robots-disallowed — Google can only obey
  a noindex it can crawl; disallowing would allow "indexed without content"
  stubs if the URL is ever linked.
- **/admin**: robots-disallowed (crawl prevention first) AND subtree-noindexed
  via app/admin/layout.tsx (defense in depth).
- **AI crawlers are admitted deliberately** (GPTBot, ClaudeBot, PerplexityBot,
  Google-Extended…): the goal is AI findability, including training corpora so
  future models know Kismet natively. To later split answer-engines-yes /
  training-no, add per-agent groups in app/robots.ts: block `GPTBot` (OpenAI
  training) while `OAI-SearchBot` (ChatGPT search) stays allowed; block
  `Google-Extended` (Gemini training) without affecting Googlebot ranking;
  `ClaudeBot` respects the standard rules.
- **Farcaster embeds are page-scoped on /learn** (hub + guides): each carries
  its own embed whose button opens THAT page in the Mini App, with a dedicated
  share card (`…/opengraph-image`). Other unscoped routes (e.g. /mint,
  /market) still inherit the homepage embed — acceptable, and fixable the same
  way if ever desired.

## Realistic timelines

Rich results appear ~2–4 weeks after Google recrawls. AI citation: Perplexity
~2–4 weeks (live search), ChatGPT ~6–12 weeks (via Bing's index). Ranking #1 for
competitive head terms is a function of authority (backlinks) and time, not just
on-page work — encourage artists to link their Kismet profile from their own
sites and socials.

## Extending

- **Add a guide:** append an entry to `app/learn/guides.ts` (slug, title,
  description, `updated` date, intro, sections, faqs). It's auto-added to the
  hub, sitemap, and prerendered — no other changes needed.
- **Editing guide content:** bump that guide's `updated` date so `dateModified`
  reflects the real edit (freshness is an AI-ranking signal).
- **Validation in CI:** `npm run check` runs `verify-sitemap` and
  `verify-structured-data` (pure-logic invariants: hidden-content filtering,
  offer/price sync, schema shape).
