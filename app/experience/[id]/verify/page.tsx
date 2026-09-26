import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { SITE_URL } from '@/lib/siteUrl'
import { getMachine } from '@/lib/experience/store'
import { ExperienceVerify } from '@/components/ExperienceVerify'

interface Props {
  params: Promise<{ id: string }>
  searchParams: Promise<{ txHash?: string }>
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params
  return {
    title: `verify a play — Kismet`,
    description:
      'Recompute a capsule draw from the seed committed before it happened, and check it against what was delivered.',
    alternates: { canonical: `${SITE_URL}/experience/${id}/verify` },
    // Deliberately noindex: this page is a tool for a specific play, not a
    // destination, and every useful visit arrives with a transaction hash.
    robots: { index: false, follow: true },
  }
}

export const dynamic = 'force-dynamic'

export default async function VerifyPage({ params, searchParams }: Props) {
  const { id } = await params
  const { txHash } = await searchParams
  if (!/^[a-z0-9-]{3,64}$/.test(id)) notFound()
  const machine = await getMachine(id).catch(() => null)
  if (!machine || machine.state === 'draft' || machine.state === 'review') notFound()

  const initial = typeof txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(txHash) ? txHash : ''

  return (
    <div className="px-4 py-8">
      <ExperienceVerify machineId={id} initialTx={initial} />
    </div>
  )
}
