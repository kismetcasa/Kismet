import type { SkipReason } from './engine'

/**
 * Owner-facing wording for the engine's skip reasons (lib/agent/scout/engine
 * SkipReason), for the run history on the profile card. Pure and import-free
 * beyond the type, so the client bundle and the verify scripts can share it.
 */
export const SKIP_REASON_LABEL: Record<SkipReason, string> = {
  paused: 'while paused',
  'permission-inactive': 'budget grant inactive',
  'currency-mismatch': 'priced in a different currency',
  'collection-blocked': 'from a blocked collection',
  'creator-blocked': 'from a blocked artist',
  'collection-not-allowed': 'not from a watched collection',
  'creator-not-allowed': 'not from a watched artist',
  'media-type-not-allowed': 'media type not allowed',
  'already-collected': 'already collected',
  'over-item-price': 'over your per-item cap',
  'period-item-limit': 'past your items-per-period limit',
  'insufficient-budget': 'not enough budget left',
}

/** Owner-facing wording for a run's `reason` (runScoutServer / dropCoordinator
 *  emit operator-facing strings, some carrying raw executor errors); null when
 *  there is none. Unknown text is never shown verbatim. */
const RUN_REASONS: Array<[RegExp, string]> = [
  [/^nothing new from your artists/, 'nothing new from your artists'],
  [/^nothing within your budget/, 'nothing within your budget or policy'],
  [/^permission inactive/, 'budget grant inactive — set it up again'],
  [/^not an active away scout/, 'agent paused'],
  [/^could not verify your collected set/, 'couldn’t check what you already own — will retry'],
  [/^kill switch engaged/, 'collecting is paused platform-wide'],
  [/^agent paused or turned off mid-run/, 'stopped mid-run'],
  [/^collected a new drop/, 'collected a new drop the moment it landed'],
  [/^all \d+ collect\(s\) failed/, 'every collect failed — will retry next run'],
  [/^\d+ of \d+ collect\(s\) failed/, 'some collects failed — will retry next run'],
]

export function describeRunReason(reason?: string | null): string | null {
  if (!reason) return null
  for (const [re, label] of RUN_REASONS) if (re.test(reason)) return label
  return 'run did not complete — will retry next run'
}

/** `2 over your per-item cap, 1 already collected` — largest first; null when nothing was skipped. */
export function describeSkips(skips?: Partial<Record<SkipReason, number>> | null): string | null {
  if (!skips) return null
  const parts = (Object.entries(skips) as [SkipReason, number][])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${n} ${SKIP_REASON_LABEL[reason] ?? reason}`)
  return parts.length > 0 ? parts.join(', ') : null
}
