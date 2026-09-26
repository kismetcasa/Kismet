import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/apiResponse'
import { ADMIN_ADDRESS } from '@/lib/config'
import { refuseUnlessCron } from '@/lib/cronAuth'
import { acquireLock } from '@/lib/redisLock'
import { experienceOperator, sendOperatorCall } from '@/lib/experience/delivery'
import { listMachines } from '@/lib/experience/store'
import { isReveal } from '@/lib/experience/types'
import {
  payoutAddresses,
  payoutWouldSucceed,
  planPayouts,
  readRewardBalances,
  withdrawForCall,
} from '@/lib/referralPayouts'

export const dynamic = 'force-dynamic'

/**
 * Daily: push escrowed referral rewards to their owners, so nobody claims.
 *
 * Checks Kismet's own referral address and every reveal machine's curator
 * (Kismet's own machines route to Kismet's address, so its admin wallet is
 * not a curator here), and for each balance worth paying, simulates and then
 * broadcasts ProtocolRewards.withdrawFor from the sponsored delivery account.
 * Broadcast only — a payout still in flight is found again, and paid, by the
 * next run; withdrawFor always sends the owner's whole balance to the owner,
 * so a repeat can never pay anyone else. One run at a time.
 */
export async function GET(req: NextRequest) {
  const refused = refuseUnlessCron(req)
  if (refused) return refused

  const lock = await acquireLock('kismetart:referral-payouts', 600).catch(() => ({ acquired: false, release: async () => {} }))
  if (!lock.acquired) return NextResponse.json({ skipped: 'a run is already in progress' })
  try {
    const operator = await experienceOperator()
    if (!operator) return errorResponse(503, 'The sponsoring account is unavailable')

    const curators = (await listMachines()).filter(isReveal).map((m) => m.creator).filter((c) => c !== ADMIN_ADDRESS)
    const addresses = payoutAddresses(curators)
    const balances = await readRewardBalances(addresses)
    const paid: { address: string; amount: string; userOpHash: string }[] = []
    const skipped: { address: string; reason: string }[] = []
    for (const p of planPayouts(balances)) {
      if (!(await payoutWouldSucceed(p.address, operator))) {
        skipped.push({ address: p.address, reason: 'withdrawal would revert' })
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
    }
    if (paid.length || skipped.length) console.log('[referral-payouts]', { paid, skipped })
    return NextResponse.json({ checked: addresses.length, read: balances.length, paid, skipped })
  } finally {
    await lock.release()
  }
}
