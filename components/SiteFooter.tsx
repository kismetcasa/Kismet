import Link from 'next/link'

// Site-wide footer. Server-rendered (no 'use client') so its links land in the
// initial HTML — the crawl paths that let search engines reach /learn and the
// core surfaces from every page, and that spread internal link equity to the
// content hub.
//
// Design: mirrors the Nav's visual language (uppercase, tracking-wider,
// text-xs mono) at footer quietness — internal links left, socials right on
// one wrapping row, with the brand line beneath in the faintest legible tone.
// Deliberately VISIBLE: hiding footer links (display:none / sr-only) exists
// only for crawlers, which is the hidden-link pattern search engines treat as
// manipulative — the links carry weight precisely because they're real
// navigation.
const FOOTER_LINKS = [
  { href: '/learn', label: 'Learn' },
  { href: '/', label: 'Discover' },
  { href: '/mint', label: 'Mint' },
  { href: '/market', label: 'Market' },
  // Label "Agent" for nav brevity; the /agent URL and its page title ("AI
  // agent — Kismet") stay as-is — the title keeps the query-bearing phrase
  // for search while the anchor stays concise. No redirect needed.
  { href: '/agent', label: 'Agent' },
] as const

// Official external profiles — mirrors the Organization sameAs list in
// lib/structuredData.ts so the visible links and the entity markup agree.
const SOCIAL_LINKS = [
  { href: 'https://x.com/kismetdotart', label: 'Twitter' },
  { href: 'https://farcaster.xyz/kismet', label: 'Farcaster' },
  { href: 'https://www.kismetcasa.xyz', label: 'Kismet Casa' },
] as const

const LINK_CLASS =
  'text-[11px] font-mono uppercase tracking-widest text-muted hover:text-ink transition-colors'

export function SiteFooter() {
  return (
    <footer className="border-t border-line px-4 py-10 font-mono">
      <div className="mx-auto flex max-w-4xl flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3">
          <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2">
            {FOOTER_LINKS.map((l) => (
              // prefetch=false, matching the Nav dropdown's rationale: these
              // are rarely-followed links on every page, and the prefetch cost
              // on a slow Mini App connection outweighs the saved navigation.
              <Link key={l.href} href={l.href} prefetch={false} className={LINK_CLASS}>
                {l.label}
              </Link>
            ))}
          </nav>
          <nav aria-label="Social" className="flex flex-wrap gap-x-6 gap-y-2">
            {SOCIAL_LINKS.map((l) => (
              <a
                key={l.href}
                href={l.href}
                target="_blank"
                rel="noopener noreferrer"
                className={LINK_CLASS}
              >
                {l.label}
              </a>
            ))}
          </nav>
        </div>
        {/* Brand line: keyword-bearing text on every page for crawlers, tuned
            to near-silence for humans. text-muted (not faint) keeps it within
            reach of accessibility contrast on the near-black background. */}
        <p className="text-[11px] leading-relaxed text-muted/80">
          Artists and collectors converge on Kismet. Create, collect and
          curate artwork on Base.
        </p>
      </div>
    </footer>
  )
}
