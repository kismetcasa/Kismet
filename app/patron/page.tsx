import { PatronCollection } from '@/components/PatronCollection'
import { PATRON_TITLE, PATRON_TAGLINE } from '@/lib/patron'

export const metadata = {
  title: `${PATRON_TITLE} — Kismet`,
  description: PATRON_TAGLINE,
}

export default function PatronPage() {
  return <PatronCollection />
}
