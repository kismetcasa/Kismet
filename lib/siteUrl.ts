// Canonical site URL, normalized so callers composing `${SITE_URL}/path`
// never emit double-slashes. Trailing slash on the env var would break
// any URL we feed to a Farcaster host: manifest webhookUrl, embed
// imageUrl, splashImageUrl, push targetUrl — all of those get hostname
// + domain validated, and a `https://kismet.art//foo` style URL fails
// stricter validators and can permanently invalidate notification tokens
// (the targetUrl spec specifically warns about hostname mismatch
// invalidating tokens).
//
// Default to the apex domain so generated metadata always points at
// production even if the env var isn't wired up at build time
// (Next.js prerenders the root layout during `Collecting page data`,
// which can run before env vars are populated in some deployment
// environments).
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ?? 'https://kismet.art'
).replace(/\/$/, '')
