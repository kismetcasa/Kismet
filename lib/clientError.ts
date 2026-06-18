// Minimal client→server diagnostic reporter.
//
// This app has no error-tracking service wired up (no Sentry/analytics), so a
// mint that fails in the browser leaves NO server-side trace — the failure
// surfaces as a toast and is then discarded, which is exactly why this class
// of bug has had to be diagnosed by reading source rather than reading logs.
//
// reportClientError POSTs a structured event to /api/client-error so the next
// failed attempt records its exact step, file shape, and error where we can
// actually see it. Fire-and-forget by design: it never throws, never blocks
// the UI, and uses `keepalive` so the report still flushes if the page
// navigates immediately after the failure.
export function reportClientError(
  event: string,
  detail: Record<string, unknown> = {},
): void {
  try {
    const body = JSON.stringify({
      event,
      detail,
      url: typeof location !== 'undefined' ? location.href : undefined,
      ua: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    })
    void fetch('/api/client-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {})
  } catch {
    // Diagnostics must never break the flow they're observing.
  }
}
