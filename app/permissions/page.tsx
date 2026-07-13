import { PermissionsDashboard } from '@/components/PermissionsDashboard'

export const metadata = {
  title: 'permissions — Kismet',
  description:
    'View permission status for every collection you have deployed and authorize legacy collections that need a one-time grant before they can mint via Kismet.',
  // Per-wallet dashboard: renders empty without a connected wallet, so there's
  // nothing worth indexing. `follow` stays on so crawlers still traverse any
  // collection links a rendered instance exposes. Also disallowed in robots.ts.
  robots: { index: false },
}

// Permission-management page. Lets a creator see at a glance which of
// their collections are mint-ready (smart wallet has ADMIN) vs need a
// one-time retroactive Authorize click. Closes the discoverability
// gap that left users hitting AUTHORIZE_REQUIRED on the first mint
// into a legacy collection without prior warning.
//
// Server-component shell — actual UX is client-side because it depends
// on the connected wallet's tracked collections + on-chain perms reads.
export default function PermissionsPage() {
  return (
    <div className="max-w-2xl mx-auto px-4 py-12">
      <PermissionsDashboard />
    </div>
  )
}
