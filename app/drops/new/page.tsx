import { notFound } from 'next/navigation'
import { DropForm } from '@/components/DropForm'
import { isDropsEnabled } from '@/lib/dropsStore'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'open a claim drop — Kismet',
  robots: { index: false },
}

export default async function NewDropPage() {
  if (!(await isDropsEnabled())) notFound()
  return (
    <div className="max-w-lg mx-auto px-4 py-12">
      <DropForm />
    </div>
  )
}
