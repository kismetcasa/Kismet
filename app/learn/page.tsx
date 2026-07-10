import type { Metadata } from 'next'
import Link from 'next/link'
import { JsonLd } from '@/components/JsonLd'
import { faqJsonLd, breadcrumbNode } from '@/lib/structuredData'
import { SITE_URL } from '@/lib/siteUrl'

// Static informational hub. This is the page that lets Kismet rank for — and
// get cited by AI answer engines on — the intent queries ("how to mint
// artwork", "onchain minting platform", "onchain art marketplace"). The
// product pages describe individual artworks; nothing on the site answered
// those questions until this page. Content follows GEO guidance: front-loaded,
// self-contained, declarative answers under clear headings, mirrored 1:1 into
// FAQPage schema (Google requires FAQ markup to match visible text).

const CANONICAL = `${SITE_URL}/learn`

export const metadata: Metadata = {
  title: 'How to Mint & Collect Onchain Art — Kismet',
  description:
    'Learn how to mint artwork onchain, create collections, and collect digital art on Kismet — an onchain art platform and marketplace on Base. Step-by-step guide plus FAQs.',
  alternates: { canonical: CANONICAL },
  openGraph: {
    title: 'How to Mint & Collect Onchain Art — Kismet',
    description:
      'A guide to minting, collecting, and trading onchain art on Kismet, an art platform on the Base network.',
    url: CANONICAL,
    type: 'article',
  },
}

// Single source of truth for the FAQ: rendered visibly below AND emitted as
// FAQPage schema, so the two never drift. Answers are 40–70 words, declarative,
// and lead with the direct answer — the shape AI engines extract as citations.
const FAQ: { question: string; answer: string }[] = [
  {
    question: 'What is Kismet?',
    answer:
      'Kismet is an onchain art platform and marketplace on Base, an Ethereum Layer 2 network. Artists mint digital artworks — called moments — as tokens, group them into collections, and set their price. Collectors discover, collect, and trade that art directly from a crypto wallet, with every mint and sale recorded onchain.',
  },
  {
    question: 'What is onchain art?',
    answer:
      'Onchain art is digital artwork whose ownership and provenance are recorded on a blockchain. Minting the work creates a token that proves who made it and who owns it, without a central intermediary. On Kismet, artworks are minted on Base and their media is stored permanently on Arweave, so the piece and its record persist independently of any single company.',
  },
  {
    question: 'What is an onchain minting platform?',
    answer:
      'An onchain minting platform lets creators publish digital work directly to a blockchain as a token — a process called minting. It handles uploading and storing the media, deploying or reusing a smart contract, and recording the mint onchain. Kismet is an onchain minting platform on Base: it mints artwork as ERC-1155 tokens and stores the files permanently on Arweave.',
  },
  {
    question: 'How do I mint artwork onchain on Kismet?',
    answer:
      'To mint on Kismet, connect a Base wallet, open Mint, upload your image, video, or text, add a title and description, and confirm. Kismet stores the file on Arweave and mints it as an onchain token on Base. You can mint a standalone moment or add it to a collection, and set whether collectors mint it for free or for a price.',
  },
  {
    question: 'What is an onchain art marketplace?',
    answer:
      'An onchain art marketplace is where digital artworks are bought and sold with transactions settled on a blockchain rather than through a private ledger. Kismet is an onchain art marketplace on Base: collectors can collect newly minted moments and buy or list existing ones on the secondary market in ETH or USDC, with ownership transferring onchain.',
  },
  {
    question: 'How do I collect art on Kismet?',
    answer:
      'To collect on Kismet, open any moment and choose Collect. Primary mints are collected for free or for the price the creator set; listed pieces are bought on the secondary market in ETH or USDC. You confirm the transaction in your Base wallet, and the token transfers to you onchain. You can also list moments you own for sale.',
  },
  {
    question: 'What blockchain does Kismet use?',
    answer:
      'Kismet runs on Base, an Ethereum Layer 2 built by Coinbase. Base offers low transaction fees and fast confirmation while inheriting Ethereum security, which makes minting and collecting affordable. Artwork media is stored on Arweave, a network designed for permanent storage, so the files remain available for the long term.',
  },
  {
    question: 'What is a moment on Kismet?',
    answer:
      'A moment is a single artwork minted on Kismet — an image, video, animation, or text piece published onchain as an ERC-1155 token on Base. Each moment has a creator, a title and description, and its media stored on Arweave. Moments can stand alone or belong to a collection, and can be collected or listed for sale.',
  },
  {
    question: 'Can an AI assistant collect art on Kismet?',
    answer:
      'Yes. Kismet exposes an agent interface so you can collect, buy, and list moments from an AI assistant connected through Base MCP. The assistant prepares each action and you approve it in your own Base Account, so you keep custody while the agent handles discovery and transaction setup. See the agent page for setup.',
  },
  {
    question: 'How much does it cost to mint on Kismet?',
    answer:
      'Minting on Kismet costs the Base network transaction fee, which is typically a few cents because Base is a low-fee Ethereum Layer 2. Creators choose whether collectors mint their work for free or for a set price, and earn from primary collects and from royalties on secondary sales.',
  },
]

interface Section {
  id: string
  heading: string
  body: React.ReactNode
}

const SECTIONS: Section[] = [
  {
    id: 'what-is-kismet',
    heading: 'What is Kismet?',
    body: (
      <>
        <p>
          Kismet is an onchain art platform and marketplace on{' '}
          <span className="text-ink">Base</span>, an Ethereum Layer 2 network.
          Artists mint digital artworks — called <em>moments</em> — as onchain
          tokens, organize them into collections, and set their price.
          Collectors discover, collect, and trade that art directly from a
          crypto wallet.
        </p>
        <p>
          Every mint and sale is recorded onchain, and each artwork&apos;s media
          is stored permanently on Arweave — so provenance and the work itself
          persist independently of any single company.
        </p>
      </>
    ),
  },
  {
    id: 'how-to-mint',
    heading: 'How to mint artwork onchain',
    body: (
      <ol className="list-decimal space-y-2 pl-5">
        <li>Connect a Base wallet, or create one when you first sign in.</li>
        <li>
          Open <Link href="/mint" className="text-ink underline underline-offset-4">Mint</Link>{' '}
          and upload your image, video, animation, or text.
        </li>
        <li>Add a title and description so collectors — and search engines — understand the work.</li>
        <li>Choose a standalone moment or add it to a collection, and set it to collect for free or for a price.</li>
        <li>Confirm. Kismet stores the file on Arweave and mints it as an ERC-1155 token on Base.</li>
      </ol>
    ),
  },
  {
    id: 'how-to-collect',
    heading: 'How collecting and trading works',
    body: (
      <>
        <p>
          Open any moment and choose <span className="text-ink">Collect</span>.
          Primary mints are collected for free or for the creator&apos;s set
          price; pieces listed on the secondary market are bought in ETH or
          USDC. You confirm in your Base wallet and the token transfers to you
          onchain.
        </p>
        <p>
          Moments you own can be listed for sale at a price you choose. Creators
          earn from primary collects and from royalties when their work resells.
        </p>
      </>
    ),
  },
  {
    id: 'ai-agent',
    heading: 'Use Kismet from an AI assistant',
    body: (
      <p>
        Kismet exposes an{' '}
        <Link href="/agent" className="text-ink underline underline-offset-4">agent interface</Link>{' '}
        so you can collect, buy, and list moments from an AI assistant connected
        through Base MCP. The assistant prepares each action; you approve it in
        your own Base Account, keeping custody while the agent handles discovery
        and transaction setup.
      </p>
    ),
  },
]

export default function LearnPage() {
  return (
    <>
      <JsonLd data={faqJsonLd(FAQ)} />
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          ...breadcrumbNode([
            { name: 'Kismet', url: `${SITE_URL}/` },
            { name: 'Learn', url: CANONICAL },
          ]),
        }}
      />

      <article className="mx-auto max-w-2xl px-4 py-12 font-mono text-sm leading-relaxed text-dim">
        <nav aria-label="Breadcrumb" className="mb-6 text-xs text-muted">
          <Link href="/" className="hover:text-dim">Kismet</Link>
          <span aria-hidden> / </span>
          <span className="text-dim">Learn</span>
        </nav>

        <h1 className="mb-4 text-xl text-ink">Onchain art, minting, and collecting on Kismet</h1>

        {/* Front-loaded direct answer — the paragraph AI engines lift as a
            summary, so it leads with the definition in one self-contained block. */}
        <p className="mb-8 text-base text-dim">
          Kismet is an onchain art platform and marketplace on Base where artists
          mint digital artworks as tokens, create collections, and set their
          price, and collectors discover, collect, and trade that art from a
          crypto wallet. This guide explains how minting, collecting, and trading
          onchain art work on Kismet.
        </p>

        {SECTIONS.map((section) => (
          <section key={section.id} id={section.id} className="mb-8">
            <h2 className="mb-3 text-base text-ink">{section.heading}</h2>
            <div className="space-y-3">{section.body}</div>
          </section>
        ))}

        <section id="faq" className="mb-8">
          <h2 className="mb-4 text-base text-ink">Frequently asked questions</h2>
          <div className="space-y-6">
            {FAQ.map((item) => (
              <div key={item.question}>
                <h3 className="mb-1 text-ink">{item.question}</h3>
                <p>{item.answer}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="border-t border-line pt-6 text-xs text-muted">
          <p>
            Ready to start?{' '}
            <Link href="/mint" className="text-ink underline underline-offset-4">Mint a moment</Link>,{' '}
            explore the{' '}
            <Link href="/" className="text-ink underline underline-offset-4">latest onchain art</Link>, or{' '}
            <Link href="/agent" className="text-ink underline underline-offset-4">connect an AI assistant</Link>.
          </p>
        </section>
      </article>
    </>
  )
}
