import type { Metadata } from 'next'

// One noindex for the entire /admin subtree. The index page carried its own
// robots meta but the subpages (gate, pass, blacklist, airdrop-quota) had
// none — layout metadata merges down to every child route, closing that gap
// in one place and covering any admin page added later. robots.txt also
// disallows /admin (crawl prevention); this is the defense-in-depth layer
// that keeps the pages out of the index if that rule is ever loosened.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return children
}
