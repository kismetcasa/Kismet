// Route-coverage guard: every PUBLIC page route must be discoverable and
// self-describing. This is the anti-drift check — the individual SEO surfaces
// (sitemap, llms.txt, canonicals) are each correct today, but nothing forced a
// NEW route to join them. /discover shipped complete in the sitemap and footer
// yet silently missed llms.txt; this test makes that class of omission fail the
// build instead of going unnoticed for weeks.
//
// For every static route under app/ that isn't excluded below, assert:
//   1. it declares metadata (a title — otherwise it inherits the layout's
//      generic one and competes with itself in search results),
//   2. it declares a canonical URL (alternates.canonical),
//   3. it appears in app/sitemap.ts STATIC_ROUTES,
//   4. it appears in public/llms.txt (the AI-crawler map).
//
// Dynamic routes ([address], [slug]) are exempt from 3–4: they're enumerated at
// runtime from Redis/the guides module, which the sitemap tests already cover.
// They are NOT exempt from 1–2 — those are per-route code.
//
// Run: node --experimental-strip-types scripts/verify-route-seo.ts
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

const APP = new URL('../app/', import.meta.url).pathname
// Read sitemap.ts as TEXT rather than importing STATIC_ROUTES: importing it
// pulls @/lib/kv → ./redis and instantiates an Upstash client, giving a pure
// source-level assertion a runtime dependency and side effects. The tradeoff is
// coupling to source formatting (a route written some exotic way could read as
// missing) — acceptable because the failure mode is a FALSE ALARM that a human
// immediately sees, never a silent pass.
const sitemapSrc = readFileSync(new URL('../app/sitemap.ts', import.meta.url), 'utf8')
const llms = readFileSync(new URL('../public/llms.txt', import.meta.url), 'utf8')

// Routes deliberately kept OUT of the sitemap/llms.txt, each for a stated
// reason. Anything not listed here is treated as public and must comply — so
// adding a private route is a conscious act, not an omission.
const EXCLUDED = new Map<string, string>([
  ['/admin', 'operator-only; robots-disallowed + subtree noindex'],
  ['/admin/gate', 'operator-only'],
  ['/admin/pass', 'operator-only'],
  ['/admin/blacklist', 'operator-only'],
  ['/admin/airdrop-quota', 'operator-only'],
  // Added on main by #666 without its exclusion row — every /admin page is
  // operator-only by the same reasoning as the entries above.
  ['/admin/broadcast', 'operator-only'],
  ['/permissions', 'per-wallet dashboard; noindex (empty without a wallet)'],
])

// Walk app/ for page.tsx files → route paths. Skips route groups "(x)",
// parallel/intercepting slots "@modal"/"(.)", and api/.
function findRoutes(dir: string, prefix = ''): { route: string; file: string }[] {
  const out: { route: string; file: string }[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (entry === 'api' || entry.startsWith('@') || entry.startsWith('(.')) continue
    if (statSync(full).isDirectory()) {
      // Route groups "(name)" don't contribute a URL segment.
      const seg = entry.startsWith('(') && entry.endsWith(')') ? '' : `/${entry}`
      out.push(...findRoutes(full, prefix + seg))
    } else if (entry === 'page.tsx') {
      out.push({ route: prefix === '' ? '/' : prefix, file: full })
    }
  }
  return out
}

const routes = findRoutes(APP).sort((a, b) => a.route.localeCompare(b.route))
const isDynamic = (r: string) => r.includes('[')

console.log(`\nroute-seo: auditing ${routes.length} page routes\n`)

for (const { route, file } of routes) {
  if (EXCLUDED.has(route)) continue
  const src = readFileSync(file, 'utf8')

  // 1 + 2: every route owns its title and canonical.
  check(
    `${route} declares metadata`,
    /export const metadata|export async function generateMetadata/.test(src),
  )
  check(
    `${route} declares a canonical`,
    /alternates:\s*\{\s*canonical/.test(src),
    'without one, query-string and case variants can index separately',
  )

  // 3 + 4: static routes must be listed in both discovery surfaces.
  if (!isDynamic(route)) {
    const inSitemap =
      route === '/'
        ? /SITE_URL\}\/`/.test(sitemapSrc)
        : sitemapSrc.includes(`${route}\``) || sitemapSrc.includes(`${route}'`)
    check(`${route} is in sitemap STATIC_ROUTES`, inSitemap)
    check(
      `${route} is in llms.txt`,
      llms.includes(`kismet.art${route === '/' ? '/)' : route}`),
      'AI crawlers use llms.txt as the curated site map',
    )
  }
}

if (failures > 0) {
  console.error(
    `\n${failures} route-seo check(s) FAILED.\n` +
      'Every public route needs: metadata + canonical (in the page), a\n' +
      'STATIC_ROUTES entry (app/sitemap.ts), and an llms.txt line. If the\n' +
      'route is intentionally private, add it to EXCLUDED with a reason.',
  )
  process.exit(1)
}
console.log('\nAll route-seo checks passed.')
