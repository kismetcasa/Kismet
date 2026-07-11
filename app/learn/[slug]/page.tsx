import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { JsonLd } from '@/components/JsonLd'
import { articleJsonLd, faqJsonLd } from '@/lib/structuredData'
import { buildFarcasterEmbed } from '@/lib/farcasterEmbed'
import { SITE_URL } from '@/lib/siteUrl'
import { GUIDES, getGuide } from '../guides'

interface Props {
  params: Promise<{ slug: string }>
}

// Prerender every guide as static HTML at build time — the whole set is known
// from the data module, and static pages give crawlers the fastest, most
// reliable content.
export function generateStaticParams() {
  return GUIDES.map((g) => ({ slug: g.slug }))
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  const guide = getGuide(slug)
  if (!guide) return { title: 'Learn — Kismet' }
  const url = `${SITE_URL}/learn/${guide.slug}`
  return {
    title: guide.metaTitle,
    description: guide.description,
    alternates: { canonical: url },
    openGraph: {
      title: guide.metaTitle,
      description: guide.description,
      url,
      type: 'article',
    },
    // Page-scoped Farcaster embed — otherwise the layout's homepage embed
    // inherits and a cast's button opens the app at the homepage instead of
    // this guide. Image is this guide's opengraph-image route.
    other: buildFarcasterEmbed({
      imageUrl: `${url}/opengraph-image`,
      buttonTitle: 'Read on Kismet',
      action: { url },
    }),
  }
}

export default async function GuidePage({ params }: Props) {
  const { slug } = await params
  const guide = getGuide(slug)
  if (!guide) notFound()

  const url = `${SITE_URL}/learn/${guide.slug}`
  const breadcrumb = [
    { name: 'Kismet', url: `${SITE_URL}/` },
    { name: 'Learn', url: `${SITE_URL}/learn` },
    { name: guide.title, url },
  ]
  const related = GUIDES.filter((g) => g.slug !== guide.slug)

  return (
    <>
      {/* Article (author/publisher = Kismet, with dates) + FAQPage, both
          server-rendered so crawlers and AI engines read them from the HTML. */}
      <JsonLd
        data={articleJsonLd({
          url,
          headline: guide.title,
          description: guide.description,
          datePublished: guide.published,
          dateModified: guide.updated,
          breadcrumb,
          // The guide's share card — satisfies Article rich-result eligibility
          // (Google wants an image) without a misleading stock/logo image.
          image: `${url}/opengraph-image`,
        })}
      />
      <JsonLd data={faqJsonLd(guide.faqs)} />

      <article className="mx-auto max-w-2xl px-4 py-12 font-mono text-sm leading-relaxed text-dim">
        <nav aria-label="Breadcrumb" className="mb-6 text-xs text-muted">
          <Link href="/" className="hover:text-dim">Kismet</Link>
          <span aria-hidden> / </span>
          <Link href="/learn" className="hover:text-dim">Learn</Link>
          <span aria-hidden> / </span>
          <span className="text-dim">{guide.title}</span>
        </nav>

        <h1 className="mb-4 text-xl text-ink">{guide.title}</h1>

        {/* Front-loaded direct answer. */}
        <p className="mb-8 text-base text-dim">{guide.intro}</p>

        {guide.steps && (
          <section className="mb-8">
            <h2 className="mb-3 text-base text-ink">{guide.steps.heading}</h2>
            <ol className="list-decimal space-y-2 pl-5">
              {guide.steps.items.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ol>
          </section>
        )}

        {guide.sections.map((section) => (
          <section key={section.heading} className="mb-8">
            <h2 className="mb-3 text-base text-ink">{section.heading}</h2>
            <div className="space-y-3">
              {section.paragraphs.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>
          </section>
        ))}

        <section id="faq" className="mb-8">
          <h2 className="mb-4 text-base text-ink">Frequently asked questions</h2>
          <div className="space-y-6">
            {guide.faqs.map((item) => (
              <div key={item.question}>
                <h3 className="mb-1 text-ink">{item.question}</h3>
                <p>{item.answer}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="border-t border-line pt-6 text-xs text-muted">
          <p className="mb-2 text-dim">Keep reading</p>
          <ul className="space-y-1">
            {related.map((g) => (
              <li key={g.slug}>
                <Link href={`/learn/${g.slug}`} className="text-ink underline underline-offset-4">
                  {g.title}
                </Link>
              </li>
            ))}
            <li>
              <Link href="/learn" className="text-ink underline underline-offset-4">
                All guides
              </Link>{' '}
              ·{' '}
              <Link href="/mint" className="text-ink underline underline-offset-4">
                Mint a moment
              </Link>
            </li>
          </ul>
        </section>
      </article>
    </>
  )
}
