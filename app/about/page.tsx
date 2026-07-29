import type { Metadata } from 'next'
import Link from 'next/link'
import { JsonLd } from '@/components/JsonLd'
import { aboutJsonLd } from '@/lib/structuredData'
import { SITE_URL } from '@/lib/siteUrl'

// The entity page. Search engines and answer engines both weight "who is behind
// this site" — for a marketplace handling other people's money and artwork, an
// explicit operator/provenance page is the concrete E-E-A-T surface the product
// pages can't provide. It's also where the Kismet ↔ Kismet Casa relationship is
// stated in prose, which is what an AI engine quotes when asked "what is
// Kismet". Static, so it prerenders and every crawler gets it in one fetch.

const CANONICAL = `${SITE_URL}/about`

export const metadata: Metadata = {
  title: 'About Kismet — Onchain Art Platform on Base',
  description:
    'Kismet is an onchain art platform and marketplace on Base, built by Kismet Casa. Learn who runs Kismet, how artists and collectors use it, and how the platform works.',
  alternates: { canonical: CANONICAL },
  openGraph: {
    title: 'About Kismet',
    description:
      'Who runs Kismet, how it works, and how artists and collectors use an onchain art platform on Base.',
    url: CANONICAL,
    type: 'article',
  },
}

interface Section {
  heading: string
  body: React.ReactNode
}

const SECTIONS: Section[] = [
  {
    heading: 'What Kismet is',
    body: (
      <>
        <p>
          Kismet is an onchain art platform and marketplace on{' '}
          <span className="text-ink">Base</span>, an Ethereum Layer 2 network.
          Artists mint artworks as ERC-1155 tokens, group them into collections,
          and set their own terms. Collectors discover, collect, and trade that
          work directly from a crypto wallet.
        </p>
        <p>
          Every mint and sale is recorded onchain, and artwork media is stored
          permanently on Arweave — so provenance and the work itself persist
          independently of any single company, including ours.
        </p>
      </>
    ),
  },
  {
    heading: 'Who runs Kismet',
    body: (
      <>
        <p>
          Kismet is built and operated by{' '}
          <a
            href="https://www.kismetcasa.xyz"
            target="_blank"
            rel="noopener noreferrer"
            className="text-ink underline underline-offset-4"
          >
            Kismet Casa
          </a>
          , a hybrid residency program for artists and developers producing work
          that bridges the physical and the onchain. Kismet is the platform side
          of that program: the place the residency&apos;s artists — and anyone
          else — publish and sell onchain work.
        </p>
        <p>
          That relationship is why the platform is opinionated about artists
          first: royalties, self-custody, and permanent storage are defaults, not
          upsells.
        </p>
      </>
    ),
  },
  {
    heading: 'How it works',
    body: (
      <>
        <p>
          Artists{' '}
          <Link href="/mint" className="text-ink underline underline-offset-4">
            mint
          </Link>{' '}
          an image, video, animation, or text piece; Kismet uploads it to Arweave
          and mints the token on Base. Collectors{' '}
          <Link href="/discover" className="text-ink underline underline-offset-4">
            browse every mint and resale
          </Link>{' '}
          and collect in ETH or USDC. Owners can list work for resale, and
          creators earn royalties when it changes hands.
        </p>
        <p>
          You keep custody throughout — Kismet prepares transactions, you sign
          them. The platform never holds your artwork or your funds.
        </p>
      </>
    ),
  },
  {
    heading: 'Where else Kismet lives',
    body: (
      <p>
        Kismet runs as a Farcaster Mini App, and can be operated from an AI
        assistant through Base MCP — see the{' '}
        <Link href="/agent" className="text-ink underline underline-offset-4">
          agent guide
        </Link>
        . New to onchain art? Start with{' '}
        <Link href="/learn" className="text-ink underline underline-offset-4">
          Learn
        </Link>
        .
      </p>
    ),
  },
]

export default function AboutPage() {
  return (
    <>
      <JsonLd data={aboutJsonLd()} />
      <article className="mx-auto max-w-2xl px-4 py-12 font-mono text-sm leading-relaxed text-dim">
        <nav aria-label="Breadcrumb" className="mb-6 text-xs text-muted">
          <Link href="/" className="hover:text-dim">
            Kismet
          </Link>
          <span aria-hidden> / </span>
          <span className="text-dim">About</span>
        </nav>

        <h1 className="mb-4 text-xl text-ink">About Kismet</h1>

        {/* Front-loaded direct answer — the paragraph an answer engine lifts
            when asked "what is Kismet". */}
        <p className="mb-8 text-base text-dim">
          Kismet is an onchain art platform and marketplace on Base, built by
          Kismet Casa. Artists mint artworks as tokens and set their own terms;
          collectors discover, collect and trade that work from their own wallet,
          with every mint and sale recorded onchain.
        </p>

        {SECTIONS.map((s) => (
          <section key={s.heading} className="mb-8">
            <h2 className="mb-3 text-base text-ink">{s.heading}</h2>
            <div className="space-y-3">{s.body}</div>
          </section>
        ))}

        <section className="border-t border-line pt-6 text-xs text-muted">
          <p>
            Find Kismet on{' '}
            <a
              href="https://x.com/kismetdotart"
              target="_blank"
              rel="noopener noreferrer"
              className="text-ink underline underline-offset-4"
            >
              X
            </a>{' '}
            and{' '}
            <a
              href="https://farcaster.xyz/kismet"
              target="_blank"
              rel="noopener noreferrer"
              className="text-ink underline underline-offset-4"
            >
              Farcaster
            </a>
            .
          </p>
        </section>
      </article>
    </>
  )
}
