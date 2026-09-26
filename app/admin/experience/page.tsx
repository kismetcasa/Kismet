import type { Metadata } from 'next'
import { ExperienceReviewQueue } from '@/components/ExperienceReviewQueue'

export const metadata: Metadata = {
  title: 'experience — admin',
  robots: { index: false, follow: false },
}

export const dynamic = 'force-dynamic'

export default function AdminExperiencePage() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <header className="mb-6">
        <h1 className="text-lg font-mono tracking-wider text-ink">experience</h1>
        <p className="text-[11px] font-mono text-muted mt-1">
          Capsule machines awaiting review, and every machine already running.
        </p>
      </header>
      <ExperienceReviewQueue />
    </div>
  )
}
