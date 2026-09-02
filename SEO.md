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
- `/learn` hub: `FAQPage` + the full `Organization` node (the hub's FAQPage
  points at it via `about`/`publisher` — `mainEntity` is reserved for the
  questions) + `BreadcrumbList`. Guides: `Article`, `FAQPage`, `BreadcrumbList`.

All JSON-LD is server-rendered (crawlers ignore JS-injected markup) and escapes
`<` to prevent script-breakout.

**Content & GEO**
- `/learn` hub + `/learn/[slug]` guides: front-loaded, declarative answers to
  the intent queries ("how to mint artwork", "onchain minting platform",
  "onchain art marketplace"), mirrored into `FAQPage` schema. The hub also
  carries the operator/provenance section (`#who-runs-kismet`) merged from
  the former `/about` — the E-E-A-T "who is responsible for this site"
  surface, kept last on the page so the intent queries keep the
  front-loaded positions.
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
4. **Socials — done.** `SAME_AS` (lib/structuredData.ts) carries the
   owner-confirmed profiles of Kismet itself (x.com/kismetdotart,
   farcaster.xyz/kismet); www.kismetcasa.xyz rides the `parentOrganization`
   edge instead (it's a different entity — see "Cross-site SEO with
   kismetcasa.xyz" below). The footer shows all three visibly. Keep the
   lists in sync if they ever change. The reciprocal link — kismetcasa.xyz
   linking to kismet.art — is the highest-authority backlink the team
   controls; the cross-site section below is the checklist for that side.
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
- **Public artwork URL is `/artwork/<address>/<tokenId>`** (migrated from
  `/moment/…`, 2026-07). The slug now matches the user-facing noun (see the
  terminology note in `lib/inprocess.ts`). Every historical `/moment/…` link —
  casts, notification deep-links, shared URLs, search-index entries — rides a
  permanent 308 in `next.config.mjs` kept forever, covering the page, its
  opengraph-image/embed-preview children, and query strings, so old links
  never break and ranking signals consolidate on the `/artwork` form.
  Canonicals, sitemap entries, OG/JSON-LD, and every internal emitter build
  `/artwork` directly (lint-enforced via `no-restricted-syntax` in
  `eslint.config.mjs`); the paste-URL parsers (agent refs, CuratePanel,
  AdminDashboard) accept both forms forever. The internal API deliberately
  stayed `/api/moment/*` — it is a wire path, not a user-facing surface — and
  `/api/artwork/*` exists only as a compatibility rewrite for stale bundles.
  Provenance is unaffected: recorded onchain + on Arweave keyed by
  (contract address, tokenId), never by page URL.

- **`/about` merged into `/learn`** (2026-08). The About page duplicated ~80%
  of `/learn` — a near-verbatim lead paragraph and a second copy of the Kismet
  Casa story — so the two competed for the "what is Kismet" intent while
  `/about` (footer-only, priority 0.6, one URL, no rich-result-eligible schema)
  captured no non-brand demand of its own. Its unique operator content moved to
  `/learn#who-runs-kismet` and `next.config.mjs` carries a permanent 308
  `/about` → that anchor. **Keep the redirect forever:** `/about` is the
  conventional URL third parties link to, and the 308 is what folds those
  signals into `/learn`. Nothing was lost in the merge — the `Organization`
  node with `sameAs` already rendered on the homepage and all three guides, and
  the visible x.com / farcaster.xyz / kismetcasa.xyz links live site-wide in
  `components/SiteFooter.tsx`. The footer's "About" label was retained at
  first, pointed at the anchor, then dropped (2026-08) as redundant next to
  the footer's existing `/learn` link; the operator section stays reachable
  via the permanent `/about` 308 and from `/learn` itself.

## Cross-site SEO with kismetcasa.xyz

kismet.art (the platform) and www.kismetcasa.xyz (Kismet Casa, the residency
organization that builds and operates it) are two properties of one team, and
set up correctly they compound: links pass authority in both directions, and
explicit entity markup lets Google merge them into one knowledge-graph
neighborhood, so trust signals ("who runs this site") earned by either domain
accrue to both. "Kismet" is a crowded term — the Casa relationship is also a
disambiguation signal that helps engines pick *this* Kismet.

**The entity model.** Each site is the authoritative home of its own entity,
and each declares the relationship to the other:

- kismet.art emits `Organization "Kismet"` (`https://kismet.art/#organization`)
  with `parentOrganization` → `Organization "Kismet Casa"`
  (`https://www.kismetcasa.xyz/#organization`). Implemented in
  lib/structuredData.ts; pinned by verify-structured-data. Kismet Casa is
  deliberately NOT in `sameAs` — sameAs asserts "same entity", and claiming
  both sameAs and parentOrganization for one URL is a contradiction that
  muddies both entities.
- kismetcasa.xyz must emit the inverse under the SAME `@id`s — the shared
  `@id` is the join key. Copy-paste for that site's `<head>` (server-rendered,
  not JS-injected):

  ```html
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": "https://www.kismetcasa.xyz/#organization",
    "name": "Kismet Casa",
    "url": "https://www.kismetcasa.xyz",
    "description": "Kismet Casa runs hybrid residencies for artists and developers producing experiences that bridge IRL and onchain, and builds and operates Kismet.",
    "sameAs": [],
    "subOrganization": {
      "@type": "Organization",
      "@id": "https://kismet.art/#organization",
      "name": "Kismet",
      "url": "https://kismet.art"
    }
  }
  </script>
  ```

  Fill `sameAs` with Kismet Casa's OWN confirmed profiles (its X/Farcaster/
  Instagram — not Kismet's). If either `@id` ever changes on one site it must
  change on both, or the join silently breaks.

**Checklist for the kismetcasa.xyz side** (owner action — that site is not in
this repo):

1. **Reciprocal link, site-wide.** A visible footer (or nav) link to
   `https://kismet.art` on every page, with descriptive anchor text — "Kismet
   — onchain art marketplace" or similar, not a bare URL or "here". Leave it
   dofollow (the default). This is the single highest-value item: kismet.art
   already links kismetcasa.xyz site-wide, so this completes the exchange.
2. **One in-content editorial link.** A sentence in the main home/about copy
   describing Kismet with a contextual link — in-content links carry more
   weight than footer boilerplate.
3. **The JSON-LD above**, server-rendered on at least the homepage.
4. **Deep-link residency content.** When Kismet Casa writes about residency
   artists, drops, or FarCon programming, link the artist's
   `kismet.art/profile/<address>` and the specific
   `kismet.art/artwork/<address>/<tokenId>` pages — not just the homepage.
   Deep links push authority to the long-tail pages that need it most and
   are the most natural anchors. (Old `/moment/…` links still work via a
   permanent 308, but emit `/artwork/…` directly.)
5. **Divide the query space; never duplicate content.** kismetcasa.xyz owns
   residency/organization/IRL intents ("art residency", "Kismet Casa");
   kismet.art owns platform intents ("mint onchain art", "onchain art
   marketplace"). Don't copy the /learn guides over — near-duplicate pages on
   two domains split ranking signals and can suppress both. Where one site
   needs the other's topic, link to it instead of rewriting it.
6. **Consistent entity facts.** Same spelling ("Kismet Casa"), same logo
   where possible, and each site lists its own socials consistently —
   contradictory facts are what stall entity merging.
7. **Console coverage for that domain too.** Verify www.kismetcasa.xyz in
   Google Search Console AND Bing Webmaster Tools, submit its sitemap — same
   Bing-≈-ChatGPT rationale as item 1 above.
8. **Optional: llms.txt on kismetcasa.xyz** with the same one-line
   description of Kismet used in ours (public/llms.txt), so AI crawlers get
   the same story from both sides.

**What's already done on the kismet.art side:** site-wide footer link +
`/learn#who-runs-kismet` operator section with contextual links (the E-E-A-T
surface), the `parentOrganization` edge, and an explicit operator line in
public/llms.txt.

**Verify after the other site ships:** run kismetcasa.xyz's homepage through
validator.schema.org (both Organization nodes should show the paired
sub/parent edges), and `curl -s https://www.kismetcasa.xyz | grep kismet.art`
to confirm the link is in the server HTML, not injected by JS.

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
