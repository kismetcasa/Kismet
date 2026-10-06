/**
 * The seed commitments this browser was shown on machine pages, kept so the
 * verify page can hold a revealed seed to the commitment the player saw
 * before they played — not only to the one the server reports afterwards.
 *
 * The first one seen for a day is kept: a page later showing a different
 * commitment for the same day is exactly what this is here to catch. Bounded,
 * and best-effort — storage can be off or full, and then there is simply no
 * record to compare with.
 */

const KEY = 'kismet:xp:commitments'
const MAX = 300

function read(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

export function rememberCommitments(machineId: string, seen: { epoch: string; commitment: string }[]): void {
  try {
    const all = read()
    let changed = false
    for (const { epoch, commitment } of seen) {
      const k = `${machineId}:${epoch}`
      if (all[k] || !/^[0-9a-f]{64}$/i.test(commitment)) continue
      all[k] = commitment.toLowerCase()
      changed = true
    }
    if (!changed) return
    const keys = Object.keys(all)
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX))) delete all[k]
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    // No storage: nothing to compare with later, which the verify page says.
  }
}

/** The commitment this browser was first shown for a machine's day, if any. */
export function seenCommitment(machineId: string, epoch: string): string | null {
  return read()[`${machineId}:${epoch}`] ?? null
}
