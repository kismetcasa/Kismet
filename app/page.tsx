import { DiscoverPage } from '@/components/DiscoverPage'
import { isMobileUA } from '@/lib/serverDevice'

// Server component. Detects mobile via request UA on the server and
// bakes the decision into the SSR HTML (and the prop the client
// hydrates with) so there's never a frame on desktop where the
// mobile tree exists. See lib/serverDevice.ts for the detection.
export default async function Page() {
  const isMobile = await isMobileUA()
  return <DiscoverPage isMobile={isMobile} />
}
