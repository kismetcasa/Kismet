import { AdminDashboard } from '@/components/AdminDashboard'

export const metadata = {
  title: 'admin — Kismet',
  description: 'Admin-only utilities.',
  robots: { index: false, follow: false },
}

// Admin-only landing page. The route itself is unauthenticated — the
// dashboard component gates content client-side by comparing the
// connected wallet against /api/admin/me. We don't redirect / 404 at
// the route level since that would require a server-side notion of
// "who is the admin", and the existing pattern (see /permissions) is
// to gate inside the client component.
export default function AdminPage() {
  return (
    <div className="max-w-2xl mx-auto px-4 py-12">
      <AdminDashboard />
    </div>
  )
}
