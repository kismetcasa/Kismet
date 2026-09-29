import type { Metadata } from 'next'
import { SITE_URL } from '@/lib/siteUrl'
import { RevealStudio } from '@/components/RevealStudio'

export const metadata: Metadata = {
  title: 'reveal studio — Kismet',
  description:
    'Open a reveal machine: curate any Kismet artist’s work; players pull for free and collect the piece they reveal at its own price.',
  alternates: { canonical: `${SITE_URL}/play/create-reveal` },
}

export default function CreateRevealPage() {
  return (
    <div className="px-4 py-8">
      <RevealStudio />
    </div>
  )
}
