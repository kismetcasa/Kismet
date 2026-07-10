import Link from 'next/link'

// Site-wide footer. Server-rendered (no 'use client') so its links land in the
// initial HTML — the crawl paths that let search engines reach /learn and the
// core surfaces from every page, and that spread internal link equity to the
// content hub. Deliberately minimal to fit the app's dark, mono aesthetic and
// sit unobtrusively below page content (including under the infinite feed).
const FOOTER_LINKS = [
  { href: '/', label: 'Discover' },
  { href: '/mint', label: 'Mint' },
  { href: '/market', label: 'Market' },
  { href: '/learn', label: 'Learn' },
  { href: '/agent', label: 'AI agent' },
] as const

export function SiteFooter() {
  return (
    <footer className="border-t border-line px-4 py-8 font-mono text-xs text-muted">
      <div className="mx-auto max-w-4xl">
        <nav aria-label="Footer" className="flex flex-wrap gap-x-5 gap-y-2">
          {FOOTER_LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="hover:text-dim transition-colors">
              {l.label}
            </Link>
          ))}
        </nav>
        <p className="mt-4">
          Kismet — an onchain art platform and marketplace on Base. Mint, collect,
          and trade digital art.
        </p>
      </div>
    </footer>
  )
}
