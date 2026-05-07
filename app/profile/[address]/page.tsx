import { notFound } from 'next/navigation'
import { isAddress } from '@/lib/address'
import { ProfileView } from '@/components/ProfileView'

interface Props {
  params: Promise<{ address: string }>
}

export default async function ProfilePage({ params }: Props) {
  const { address } = await params
  if (!isAddress(address)) notFound()

  return <ProfileView address={address} />
}
