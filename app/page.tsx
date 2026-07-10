import { DiscoverPage } from '@/components/DiscoverPage'
import { isMobileUA } from '@/lib/serverDevice'
import { JsonLd } from '@/components/JsonLd'
import { homeJsonLd } from '@/lib/structuredData'

// Server component. Detects mobile via request UA on the server and
// bakes the decision into the SSR HTML (and the prop the client
// hydrates with) so there's never a frame on desktop where the
// mobile tree exists. See lib/serverDevice.ts for the detection.
export default async function Page() {
  const isMobile = await isMobileUA()
  return (
    <>
      {/* Organization + WebSite structured data, server-rendered into the
          initial HTML so crawlers see the brand entity on first fetch. */}
      <JsonLd data={homeJsonLd()} />
      <DiscoverPage isMobile={isMobile} />
    </>
  )
}
