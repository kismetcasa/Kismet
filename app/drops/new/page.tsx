import { notFound } from 'next/navigation'
import { DropForm } from '@/components/DropForm'
import { isDropsEnabled } from '@/lib/dropsStore'

// DROPS_ENABLED is read per request: a page prerendered at build time would
// freeze whatever the build environment said.
export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'open a claim drop — Kismet',
  robots: { index: false },
}

export default function NewDropPage() {
  if (!isDropsEnabled()) notFound()
  return (
    <div className="max-w-lg mx-auto px-4 py-12">
      <DropForm />
    </div>
  )
}
