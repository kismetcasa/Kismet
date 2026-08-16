// Guards the pure core of the Farcaster push broadcast
// (lib/farcasterNotifications.ts): input validation against the Mini App
// notification spec caps, and per-host ≤100-token batching.
//
// THE REGRESSIONS THESE GUARD:
//   - targetUrl host drift. A targetUrl whose host differs from the manifest
//     domain — INCLUDING a subdomain like www. — makes the Farcaster client
//     answer target_url_mismatch and PERMANENTLY invalidate every token in
//     the request. Validation rejecting anything but the exact SITE_URL host
//     is what stands between an admin typo and a mass token wipe.
//   - Batch overflow. The spec caps `tokens` at 100 per request; an oversized
//     batch 400s host-side and loses the whole request. Grouping must chunk
//     at 100 while preserving the token→fid mapping that invalid-token GC
//     depends on.
//
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//        --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
//        scripts/verify-fc-broadcast.ts

import {
  validateBroadcastInput,
  groupTargetsForSend,
  BROADCAST_LIMITS,
  type BroadcastTarget,
} from '../lib/farcasterNotifications.ts'
import { SITE_URL } from '../lib/siteUrl.ts'

let failures = 0
const check = (name: string, cond: boolean): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}`)
    failures++
  }
}

const HOST = new URL(SITE_URL).hostname
const base = { notificationId: 'announce-1', title: 'Hello', body: 'World' }

// ---------------------------------------------------------------- validation
console.log('validateBroadcastInput:')
{
  const v = validateBroadcastInput(base)
  check('minimal input → ok', v.ok)
  check('targetUrl defaults to SITE_URL', v.ok && v.targetUrl === SITE_URL)
}
{
  const v = validateBroadcastInput({ ...base, notificationId: '  spaced-id  ', title: ' t ', body: ' b ' })
  check(
    'fields are trimmed',
    v.ok && v.notificationId === 'spaced-id' && v.title === 't' && v.body === 'b',
  )
}
check('empty notificationId → rejected', !validateBroadcastInput({ ...base, notificationId: '' }).ok)
check(
  'whitespace inside notificationId → rejected',
  !validateBroadcastInput({ ...base, notificationId: 'has space' }).ok,
)
check(
  `notificationId over ${BROADCAST_LIMITS.notificationId} → rejected`,
  !validateBroadcastInput({ ...base, notificationId: 'x'.repeat(BROADCAST_LIMITS.notificationId + 1) }).ok,
)
check(
  `notificationId at ${BROADCAST_LIMITS.notificationId} → ok`,
  validateBroadcastInput({ ...base, notificationId: 'x'.repeat(BROADCAST_LIMITS.notificationId) }).ok,
)
check('empty title → rejected', !validateBroadcastInput({ ...base, title: '  ' }).ok)
check(
  `title over ${BROADCAST_LIMITS.title} (spec cap) → rejected`,
  !validateBroadcastInput({ ...base, title: 'x'.repeat(BROADCAST_LIMITS.title + 1) }).ok,
)
check(
  `title at ${BROADCAST_LIMITS.title} → ok`,
  validateBroadcastInput({ ...base, title: 'x'.repeat(BROADCAST_LIMITS.title) }).ok,
)
check('empty body → rejected', !validateBroadcastInput({ ...base, body: '' }).ok)
check(
  `body over ${BROADCAST_LIMITS.body} (spec cap) → rejected`,
  !validateBroadcastInput({ ...base, body: 'x'.repeat(BROADCAST_LIMITS.body + 1) }).ok,
)
check(
  `body at ${BROADCAST_LIMITS.body} → ok`,
  validateBroadcastInput({ ...base, body: 'x'.repeat(BROADCAST_LIMITS.body) }).ok,
)
check(
  'deep path on the site host → ok',
  validateBroadcastInput({ ...base, targetUrl: `${SITE_URL}/artwork/0xabc/1?ref=push` }).ok,
)
check(
  'http (non-https) targetUrl → rejected',
  !validateBroadcastInput({ ...base, targetUrl: `http://${HOST}/x` }).ok,
)
check(
  'foreign-host targetUrl → rejected',
  !validateBroadcastInput({ ...base, targetUrl: 'https://example.com/x' }).ok,
)
check(
  'SUBDOMAIN of the site host → rejected (token-invalidation guard)',
  !validateBroadcastInput({ ...base, targetUrl: `https://www.${HOST}/x` }).ok,
)
check(
  'unparseable targetUrl → rejected',
  !validateBroadcastInput({ ...base, targetUrl: 'not a url' }).ok,
)
check(
  `targetUrl over ${BROADCAST_LIMITS.targetUrl} (spec cap) → rejected`,
  !validateBroadcastInput({
    ...base,
    targetUrl: `${SITE_URL}/${'x'.repeat(BROADCAST_LIMITS.targetUrl)}`,
  }).ok,
)

// ---------------------------------------------------------------- batching
console.log('groupTargetsForSend:')
const mk = (fid: number, url: string): BroadcastTarget => ({ fid, url, token: `tok-${url}-${fid}` })
{
  check('no targets → no groups', groupTargetsForSend([]).length === 0)
}
{
  const urlA = 'https://api.farcaster.xyz/v1/frame-notifications'
  const targets = Array.from({ length: 250 }, (_, i) => mk(i + 1, urlA))
  const groups = groupTargetsForSend(targets)
  check('single host → single group', groups.length === 1)
  const sizes = groups[0]?.batches.map((b) => b.length) ?? []
  check(
    `250 tokens → batches of [100, 100, 50] (cap ${BROADCAST_LIMITS.tokensPerRequest})`,
    sizes.length === 3 && sizes[0] === 100 && sizes[1] === 100 && sizes[2] === 50,
  )
  const flat = groups[0]?.batches.flat() ?? []
  check(
    'every token keeps its owning fid through batching (GC mapping)',
    flat.length === 250 && flat.every((t) => t.token === `tok-${urlA}-${t.fid}`),
  )
}
{
  const urlA = 'https://api.farcaster.xyz/v1/frame-notifications'
  const urlB = 'https://notifications.example-host.xyz/v1'
  const targets = [mk(1, urlA), mk(2, urlB), mk(3, urlA), mk(1, urlB)]
  const groups = groupTargetsForSend(targets)
  const a = groups.find((g) => g.url === urlA)
  const b = groups.find((g) => g.url === urlB)
  check('two hosts → two groups, nothing merged across hosts', groups.length === 2 && !!a && !!b)
  check(
    'per-host membership is exact',
    (a?.batches.flat().map((t) => t.fid).join(',') ?? '') === '1,3' &&
      (b?.batches.flat().map((t) => t.fid).join(',') ?? '') === '2,1',
  )
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('\nall checks passed')
