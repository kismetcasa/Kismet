// Data for the /learn/[slug] guide pages. Plain data (no JSX) so it's a single
// source of truth reused by the guide route, the /learn hub, the sitemap, and
// llms.txt. Each guide targets a distinct intent query with unique, deeper
// content than the hub — front-loaded, declarative prose plus its own FAQs.
//
// `updated`/`published` feed Article datePublished/dateModified. Bump `updated`
// whenever you edit a guide's content — freshness is an AI-ranking signal.

export interface GuideSection {
  heading: string
  paragraphs: string[]
}

export interface Guide {
  slug: string
  // H1 + breadcrumb label.
  title: string
  // Full <title>.
  metaTitle: string
  // Meta description + Article/OG description.
  description: string
  published: string // ISO date
  updated: string // ISO date — bump on edits
  // Front-loaded direct answer (the block AI engines lift as a summary).
  intro: string
  // Optional ordered how-to list, rendered right after the intro.
  steps?: { heading: string; items: string[] }
  sections: GuideSection[]
  faqs: { question: string; answer: string }[]
  // Authoritative external references, rendered as a visible "Sources" list.
  // Citing primary sources is a recognized E-E-A-T / answer-engine signal; every
  // link points at a canonical protocol or spec page, never marketing.
  sources?: { label: string; url: string }[]
}

export const GUIDES: Guide[] = [
  {
    slug: 'how-to-mint-onchain-art',
    title: 'How to mint onchain art',
    metaTitle: 'How to Mint Onchain Art on Base — Step-by-Step Guide | Kismet',
    description:
      'A step-by-step guide to minting onchain art on Kismet: connect a Base wallet, upload your image or video, set a price, and publish your artwork as a token on Base with permanent Arweave storage.',
    published: '2026-07-10',
    updated: '2026-07-16',
    intro:
      'To mint onchain art on Kismet, connect a Base wallet, open Mint, upload your image, video, animation, or text, add a title and description, choose a free or paid mint, and confirm. Kismet stores your file permanently on Arweave and mints it as an ERC-1155 token on Base — an Ethereum Layer 2 — so the artwork and its ownership record live onchain.',
    steps: {
      heading: 'Steps to mint',
      items: [
        'Connect a Base wallet, or create one the first time you sign in.',
        'Open Mint and upload your file — an image, video, animation, or text piece.',
        'Add a title and a description. Both help collectors and search engines understand the work, so write them for a real reader.',
        'Choose whether the moment stands alone or joins one of your collections.',
        'Set the terms: collect for free, or set a price collectors pay to mint.',
        'Confirm the transaction in your wallet. Kismet uploads the file to Arweave and mints the token on Base.',
      ],
    },
    sections: [
      {
        heading: 'What you need before you start',
        paragraphs: [
          'You need two things: a wallet that works on Base, and a file to mint. Base is an Ethereum Layer 2 built by Coinbase, so any Base-compatible wallet works, and Kismet can create a smart wallet for you if you do not have one.',
          'Supported media includes images, video, animation, and text. A strong title and description are worth the extra minute — they are what a collector reads and what a search engine indexes.',
        ],
      },
      {
        heading: 'What happens when you mint',
        paragraphs: [
          'Minting does two things at once. First, your file is uploaded to Arweave, a network designed for permanent storage, so the media persists for the long term rather than depending on one company keeping a server online. Second, a token is created on Base recording the artwork, its creator, and its metadata onchain.',
          'On Kismet the token is an ERC-1155, a widely supported token standard, so the moment is portable and readable by other onchain tools and wallets, not locked inside one app.',
        ],
      },
      {
        heading: 'Standalone moments vs collections',
        paragraphs: [
          'A moment can stand on its own or belong to a collection. A collection groups related work under one contract and one page, which is useful for a series, a drop, or an ongoing body of work.',
          'You can mint a standalone moment first and organize later, or create a collection up front and mint into it. Either way the individual moment remains the canonical home for that artwork.',
        ],
      },
      {
        heading: 'Pricing, costs, and earnings',
        paragraphs: [
          'You decide whether collectors mint your work for free or for a price you set. Minting itself costs only the Base network fee, which is typically a few cents because Base is a low-fee Layer 2.',
          'Creators earn from primary collects at the price they set, and can earn royalties when their work is resold on the secondary market. You keep custody of your wallet throughout — Kismet prepares transactions, but you sign them.',
        ],
      },
    ],
    faqs: [
      {
        question: 'What file types can I mint on Kismet?',
        answer:
          'You can mint images, video, animation, and text on Kismet. The file is uploaded to Arweave for permanent storage and referenced by the onchain token, so collectors always resolve the original media.',
      },
      {
        question: 'Do I need ETH to mint?',
        answer:
          'You need a small amount of ETH on Base to cover the network transaction fee, which is typically a few cents because Base is a low-fee Ethereum Layer 2. Kismet can set up a Base smart wallet if you do not already have one.',
      },
      {
        question: 'Can I mint art for free on Kismet?',
        answer:
          'You choose your terms. You can offer a moment as a free mint that collectors claim at no cost beyond the network fee, or set a price collectors pay to mint. You can also earn royalties when the work resells.',
      },
      {
        question: 'Where is my minted artwork stored?',
        answer:
          "Your artwork's media is stored on Arweave, a network built for permanent storage, and the ownership record lives onchain on Base. Because storage is content-addressed and paid up front, the file remains available long-term rather than depending on a single server.",
      },
      {
        question: 'Can I edit a moment after minting it?',
        answer:
          'The onchain token and its Arweave media are permanent, which is what makes provenance trustworthy. Editable display details such as the title and description can be updated by the creator, but the underlying minted artwork and its record do not change.',
      },
    ],
    sources: [
      { label: 'Base — Ethereum Layer 2 built by Coinbase', url: 'https://www.base.org' },
      { label: 'Arweave — permanent, pay-once data storage', url: 'https://www.arweave.org' },
      { label: 'ERC-1155 Multi-Token Standard (EIP-1155)', url: 'https://eips.ethereum.org/EIPS/eip-1155' },
    ],
  },
  {
    slug: 'what-is-onchain-art',
    title: 'What is onchain art?',
    metaTitle: 'What Is Onchain Art? A Guide to Onchain Art on Base | Kismet',
    description:
      'Onchain art is digital artwork whose ownership and provenance are recorded on a blockchain. Learn what onchain art is, how it differs from traditional digital art, why permanence and Base matter, and how it works on Kismet.',
    published: '2026-07-10',
    updated: '2026-07-16',
    intro:
      'Onchain art is digital artwork whose ownership and provenance are recorded on a blockchain rather than in a private database. Minting the work creates a token that proves who made it and who owns it, with no central intermediary required. On Kismet, artworks are minted on Base and their media is stored permanently on Arweave, so both the piece and its record persist independently of any single company.',
    sections: [
      {
        heading: 'Onchain vs off-chain',
        paragraphs: [
          'The difference is where the record of ownership lives. Off-chain, a platform keeps a private ledger you have to trust; if the company changes its rules or shuts down, your record can vanish. Onchain, the record is written to a public blockchain that anyone can verify and no single party controls.',
          'Onchain art applies that model to creative work: the token that represents the artwork is a public, verifiable entry, not a row in one company’s database.',
        ],
      },
      {
        heading: 'Provenance and ownership',
        paragraphs: [
          'Provenance is the documented history of a work — who created it and who has owned it. Onchain, that history is recorded automatically with every mint and transfer, producing a continuous, tamper-evident chain of custody.',
          'For collectors, that means ownership is verifiable by anyone without trusting a middleman. For artists, it means attribution travels with the work wherever it goes.',
        ],
      },
      {
        heading: 'Why Base',
        paragraphs: [
          'Base is an Ethereum Layer 2 network built by Coinbase. It settles to Ethereum, inheriting its security, while offering much lower fees and faster confirmation. That combination makes minting and collecting affordable enough for everyday creative use rather than only high-value transactions.',
          'Kismet builds on Base so the cost of putting art onchain is measured in cents, not dollars.',
        ],
      },
      {
        heading: 'Permanence and storage',
        paragraphs: [
          'Recording ownership onchain is only half the picture — the media itself has to persist too. Kismet stores artwork on Arweave, a network designed for permanent, pay-once storage, so the file behind a token does not rot or disappear.',
          'Together, an onchain record on Base and permanent media on Arweave mean an onchain artwork can outlive the platform it was minted on.',
        ],
      },
      {
        heading: 'How it differs from a traditional marketplace',
        paragraphs: [
          'On a traditional digital marketplace, the platform is the source of truth: it holds the files, the accounts, and the ownership records. On an onchain platform like Kismet, the blockchain is the source of truth and you hold the assets in your own wallet.',
          'That shifts control to creators and collectors: the work, its provenance, and its ownership are not dependent on the platform continuing to exist.',
        ],
      },
    ],
    faqs: [
      {
        question: 'Is onchain art the same as an NFT?',
        answer:
          'An NFT (non-fungible token) is the token that represents a unique item onchain, and onchain art uses that mechanism. The phrase "onchain art" emphasizes that both the ownership record and, ideally, the media itself live on public infrastructure — on Kismet, on Base with media stored on Arweave.',
      },
      {
        question: 'Who owns onchain art?',
        answer:
          'Whoever holds the token in their wallet owns the onchain artwork, and that ownership is publicly verifiable on the blockchain. Ownership transfers when the token transfers, with each transfer recorded as part of the work’s provenance.',
      },
      {
        question: 'Is onchain art permanent?',
        answer:
          'The ownership record is as permanent as the blockchain it lives on. On Kismet the media is also stored on Arweave, a network designed for permanent storage, so the artwork itself persists rather than relying on a single company’s servers.',
      },
      {
        question: 'Can onchain art be copied?',
        answer:
          'The image file can be copied like any digital file, but the onchain token — the verifiable record of authorship and ownership — cannot. Provenance is what distinguishes the original mint from a copy, and it is recorded publicly onchain.',
      },
    ],
    sources: [
      { label: 'Ethereum — ERC-1155 token standard', url: 'https://ethereum.org/developers/docs/standards/tokens/erc-1155/' },
      { label: 'Base — Ethereum Layer 2 built by Coinbase', url: 'https://www.base.org' },
      { label: 'Arweave — permanent data storage', url: 'https://www.arweave.org' },
    ],
  },
  {
    slug: 'onchain-art-marketplace',
    title: 'How the onchain art marketplace works',
    metaTitle: 'Onchain Art Marketplace: Collect, Buy & Sell Digital Art | Kismet',
    description:
      'How an onchain art marketplace works on Kismet: collect newly minted moments, buy listed pieces on the secondary market in ETH or USDC, list your own work for sale, earn royalties, and keep custody in your own wallet.',
    published: '2026-07-10',
    updated: '2026-07-16',
    intro:
      'An onchain art marketplace is where digital artworks are bought and sold with transactions settled on a blockchain instead of a private ledger. On Kismet you collect newly minted moments, buy existing ones on the secondary market in ETH or USDC, and list work you own for sale — with ownership transferring onchain and custody staying in your own wallet.',
    sections: [
      {
        heading: 'Collecting a primary mint',
        paragraphs: [
          'Collecting a primary mint means acquiring a moment directly from its creator. Depending on the creator’s terms, a primary collect is either free — you claim it for only the network fee — or priced, so you pay the amount the creator set.',
          'You confirm the transaction in your Base wallet and the token transfers to you onchain, adding you to the work’s provenance.',
        ],
      },
      {
        heading: 'Buying on the secondary market',
        paragraphs: [
          'Once a moment has been minted, its owner can list it for sale. Buying a listed piece is a secondary-market purchase, settled onchain in ETH or USDC depending on how the listing is priced.',
          'Because settlement is onchain, the transfer of ownership and the payment happen together and are publicly verifiable — there is no platform holding the asset in escrow off-chain.',
        ],
      },
      {
        heading: 'Listing and selling your work',
        paragraphs: [
          'Any moment you own can be listed for sale at a price you choose. Listing makes the piece available on the market for other collectors to buy, and you can cancel or adjust a listing while you still hold the token.',
          'This applies to work you created and work you collected — the marketplace is the same for primary drops and secondary resales.',
        ],
      },
      {
        heading: 'Royalties for creators',
        paragraphs: [
          'Creators can earn royalties on secondary sales, meaning a share of the resale price returns to the artist each time their work changes hands. That aligns long-term incentives: an artist keeps benefiting as the market for their work grows.',
          'Royalties are handled as part of the onchain sale, so they follow the work rather than depending on a platform to enforce them manually.',
        ],
      },
      {
        heading: 'Custody and wallets',
        paragraphs: [
          'Throughout collecting, buying, and selling, you hold your assets in your own Base wallet. Kismet prepares transactions and surfaces listings, but you sign every action and retain custody.',
          'That is the core difference from a traditional marketplace: the platform is an interface to the blockchain, not the custodian of your art or your funds.',
        ],
      },
    ],
    faqs: [
      {
        question: 'How do I buy art on Kismet?',
        answer:
          'Open a moment and choose Collect. A primary mint is collected for free or at the creator’s price; a listed piece is bought on the secondary market. You confirm in your Base wallet and the token transfers to you onchain.',
      },
      {
        question: 'Do I pay in ETH or USDC?',
        answer:
          'Both are supported. Primary mints and secondary purchases settle in ETH or USDC depending on how the moment or listing is priced, and the amount you pay is shown before you confirm.',
      },
      {
        question: 'How do I sell art I own?',
        answer:
          'List any moment you own for sale at a price you set. It becomes available on the market for other collectors to buy, ownership transfers onchain when it sells, and you can cancel or change the listing while you still hold the token.',
      },
      {
        question: 'What are royalties and who earns them?',
        answer:
          'Royalties are a share of a resale price that returns to the original creator each time a work changes hands on the secondary market. They are handled as part of the onchain sale, so creators keep earning as their work continues to trade.',
      },
      {
        question: 'Do I keep custody of my art?',
        answer:
          'Yes. Your moments and funds stay in your own Base wallet. Kismet prepares transactions and displays listings, but you sign every action yourself, so you retain custody throughout collecting, buying, and selling.',
      },
    ],
    sources: [
      { label: 'Base — Ethereum Layer 2 built by Coinbase', url: 'https://www.base.org' },
      { label: 'ERC-1155 Multi-Token Standard (EIP-1155)', url: 'https://eips.ethereum.org/EIPS/eip-1155' },
      { label: 'Arweave — permanent media storage', url: 'https://www.arweave.org' },
    ],
  },
]

export const GUIDE_SLUGS = GUIDES.map((g) => g.slug)

export function getGuide(slug: string): Guide | undefined {
  return GUIDES.find((g) => g.slug === slug)
}
