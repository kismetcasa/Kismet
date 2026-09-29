/**
 * A browser-local ledger of capsules this device has paid for.
 *
 * ── The gap this closes ──
 *
 * /api/experience/play needs the capsule's transaction hash, and the server
 * does not learn that hash until the client posts it. There is therefore a
 * window — between the mint confirming in the wallet and the play POST being
 * recorded — where a paid capsule exists on-chain and NOTHING on the server
 * knows about it. If the tab closes in that window the hash is gone, and with
 * it the only handle anyone has on that capsule: the artwork is owed, and
 * unreachable. Recovering it otherwise would mean indexing mint logs per player.
 *
 * So the hash is written here the instant the transaction lands, BEFORE the
 * first open is attempted, and cleared only once every unit has been delivered.
 * On the next visit the machine page offers to finish them.
 *
 * ── Why localStorage is the right home, with a caveat ──
 *
 * It survives reloads and crashes, needs no account, and costs no round trip.
 * It does NOT survive a cleared browser or a different device — which is
 * exactly why it is the SECOND of two records rather than the only one:
 * /api/experience/claims covers everything the server did manage to record, and
 * that is the durable, cross-device half. This one covers the narrow window the
 * server cannot see. Neither is sufficient alone.
 *
 * Every access is wrapped: private-mode Safari and storage-blocked contexts
 * throw on read as well as write, and a capsule ledger must never be the reason
 * a machine page fails to render.
 */

const KEY = 'kismetart:xp:pending'
/** Bound the ledger so an abandoned browser cannot grow it without limit.
 *  Oldest entries fall off first; anything that old is also in the server's
 *  claim list if it was ever recorded at all. */
const MAX_PER_MACHINE = 20

export interface PendingCapsule {
  txHash: string
  units: number
  at: number
}

type Ledger = Record<string, PendingCapsule[]>

function read(): Ledger {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Ledger
  } catch {
    return {}
  }
}

function write(l: Ledger): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(l))
  } catch {
    // Quota or blocked storage. The capsule is still recoverable through the
    // server's claim list the moment the play POST lands, so this is a
    // degradation rather than a loss.
  }
}

export function listPendingCapsules(machineId: string): PendingCapsule[] {
  const rows = read()[machineId]
  if (!Array.isArray(rows)) return []
  return rows.filter(
    (r): r is PendingCapsule =>
      !!r && typeof r.txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(r.txHash),
  )
}

export function rememberCapsule(machineId: string, entry: PendingCapsule): void {
  const ledger = read()
  const existing = listPendingCapsules(machineId).filter((r) => r.txHash !== entry.txHash)
  ledger[machineId] = [entry, ...existing].slice(0, MAX_PER_MACHINE)
  write(ledger)
}

export function clearPendingCapsule(machineId: string, txHash: string): void {
  const ledger = read()
  const remaining = listPendingCapsules(machineId).filter((r) => r.txHash !== txHash)
  if (remaining.length > 0) ledger[machineId] = remaining
  else delete ledger[machineId]
  write(ledger)
}
