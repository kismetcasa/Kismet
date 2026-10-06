import 'server-only'
import { redis } from '@/lib/redis'
import { acquireLock } from '@/lib/redisLock'
import {
  checkPayout,
  payoutAddresses,
  planPayouts,
  readRewardBalances,
  reconcilePayouts,
  recordPayout,
  withdrawForCall,
} from '@/lib/referralPayouts'
import { experienceOperator, readDeliveryOutcome, sendOperatorCall } from './delivery'
import { epochFor } from './fairness'
import { listCurators, listMachines, openEpochSeeds } from './store'
import { isReveal } from './types'

/**
 * The machines' scheduled jobs, one function each for both of their drivers:
 * the cron route (/api/cron/<job>, which vercel.json schedules on Vercel and
 * an external scheduler may call anywhere) and the app itself
 * (lib/backgroundTasks), which on a persistent host runs a job once its last
 * run is older than MACHINE_JOB_INTERVAL_MS — so neither depends on a
 * scheduler being configured. Each run records when it ran, whichever driver
 * ran it, so an external scheduler keeps precedence and the app stands down.
 */
export type MachineJob = 'experience-seeds' | 'referral-payouts'

export const MACHINE_JOB_INTERVAL_MS: Record<MachineJob, number> = {
  // Hourly, not daily: what matters is a run inside every UTC day, which
  // commits the next day's seed before it starts, and a daily interval drifts
  // by up to a tick a run until a day is skipped. A run is one SET NX per
  // machine that already has its seeds.
  'experience-seeds': 60 * 60 * 1000,
  'referral-payouts': 24 * 60 * 60 * 1000,
}

const ranKey = (job: MachineJob) => `kismetart:xp:job:${job}`

/** When `job` last ran; null when it never has. Throws on a Redis failure, so
 *  a caller can tell "unreadable" from "never ran". */
export async function readMachineJobRun(job: MachineJob): Promise<number | null> {
  const at = Number(await redis.get<number | string>(ranKey(job)))
  return Number.isFinite(at) && at > 0 ? at : null
}

async function recordMachineJobRun(job: MachineJob): Promise<void> {
  await redis.set(ranKey(job), Date.now()).catch(() => {})
}

/**
 * Commit the seeds of every machine that can still draw.
 *
 * openEpochSeeds runs on every machine read and commits today's AND tomorrow's
 * seed, so any machine anyone looks at is always committed a full epoch ahead.
 * The one case that leaves open is a machine nobody has loaded for two days:
 * its next play would create the seed at freeze time, after the player's
 * transaction exists. Every draw is sealed by a block made after its freeze
 * (lib/experience/entropy), so even that seed could not be chosen to suit the
 * outcome — but a commitment published a day ahead, whether or not anyone
 * shows up, is still what a player can hold the draw to, and it costs one
 * bounded pass over the machines.
 *
 * Idempotent: every write underneath is SET NX, so running it twice — or
 * racing a read — cannot rotate a seed that already exists.
 */
export async function commitMachineSeeds() {
  try {
    const epoch = epochFor(Date.now())
    // Every machine that can still DRAW, not only the ones on sale. An ended or
    // delisted machine sells nothing, but a stalled claim on it is discharged by
    // a fresh draw through the resume path, and that draw needs a seed that was
    // committed before the resume was requested — the same property this job
    // exists to give live machines. A reveal machine never draws on the server,
    // so it has nothing to commit to.
    const machines = (await listMachines(['live', 'ended', 'delisted'])).filter((m) => !isReveal(m))
    const results = await Promise.all(
      machines.map((m) =>
        openEpochSeeds(m.id, epoch)
          .then(() => ({ id: m.id, ok: true }))
          .catch(() => ({ id: m.id, ok: false })),
      ),
    )
    return {
      epoch,
      machines: results.length,
      committed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).map((r) => r.id),
    }
  } finally {
    await recordMachineJobRun('experience-seeds')
  }
}

export type PayoutRun =
  | { skipped: string }
  | { unavailable: true }
  | {
      settled: Awaited<ReturnType<typeof reconcilePayouts>>
      checked: number
      read: number
      paid: { address: string; amount: string; userOpHash: string }[]
      skipped: { address: string; reason: string }[]
    }

/**
 * Push escrowed referral rewards to their owners, so nobody claims.
 *
 * First settles the previous runs' payouts from the chain's answer (the
 * ledger in lib/referralPayouts). Then checks Kismet's own referral address
 * and every reveal machine's curator (Kismet's own machines name Kismet's
 * address, so its admin wallet is never recorded as a curator), and for each
 * balance worth paying, simulates and then broadcasts ProtocolRewards.withdrawFor
 * from the sponsored delivery account, recording it. Broadcast only — a payout
 * still in flight is found again by the next run; withdrawFor always sends the
 * owner's whole balance to the owner, so a repeat can never pay anyone else.
 * One run at a time.
 */
export async function payReferralRewards(): Promise<PayoutRun> {
  const lock = await acquireLock('kismetart:referral-payouts', 600).catch(() => ({ acquired: false, release: async () => {} }))
  if (!lock.acquired) return { skipped: 'a run is already in progress' }
  try {
    const operator = await experienceOperator()
    if (!operator) {
      console.warn('[referral-payouts] the sponsoring account is unavailable; nothing paid')
      return { unavailable: true }
    }

    const settled = await reconcilePayouts((hash) => readDeliveryOutcome({ userOpHash: hash }))
    const addresses = payoutAddresses(await listCurators())
    const balances = await readRewardBalances(addresses)
    const paid: { address: string; amount: string; userOpHash: string }[] = []
    const skipped: { address: string; reason: string }[] = []
    for (const p of planPayouts(balances)) {
      const check = await checkPayout(p.address, operator)
      if (check !== 'ok') {
        skipped.push({ address: p.address, reason: check === 'reverts' ? 'withdrawal would revert' : 'could not check the withdrawal' })
        continue
      }
      const sent = await sendOperatorCall(withdrawForCall(p.address))
      if (sent.kind !== 'sent') {
        // Sponsorship or the account is down; every later payout would fail
        // the same way, and each attempt is a request against the paymaster.
        skipped.push({ address: p.address, reason: sent.error })
        break
      }
      paid.push({ address: p.address, amount: p.balance.toString(), userOpHash: sent.userOpHash })
      await recordPayout({ address: p.address, amount: p.balance, userOpHash: sent.userOpHash })
    }
    if (paid.length || skipped.length) console.log('[referral-payouts]', { paid, skipped, settled })
    return { settled, checked: addresses.length, read: balances.length, paid, skipped }
  } finally {
    await recordMachineJobRun('referral-payouts')
    await lock.release()
  }
}
