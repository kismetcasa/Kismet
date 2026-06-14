// Oracle for the Phase-2 autonomous collect composition (lib/agent/scout/serverCollect.ts).
//
// The novel rule: the Spend Permission `spend()` calls (which pull the exact cost
// into the spender) MUST run before the (approve +) mint, and EIP-5792 hex values
// must convert to on-chain wei. The mint calldata itself (KISMET_REFERRAL, mintTo)
// is covered by verify-agent-collect-batch; here we verify only the composition.
// Run: node --experimental-strip-types scripts/verify-agent-scout-server.ts

import { decodeAbiParameters, getAddress, parseAbiParameters } from 'viem'
import { composeScoutCollect } from '../lib/agent/scout/serverCollect.ts'
import { buildEthMintCall, buildUsdcMintCall } from '../lib/zoraMint.ts'
import type { AgentCall } from '../lib/agent/types.ts'
import type { SpenderCall } from '../lib/agent/scout/spender.ts'
import { REFERRAL, check, eq, report } from './_agent-verify-helpers.ts'

const SPM = getAddress('0x00000000000000000000000000000000000005b1') // SpendPermissionManager stand-in
const MINTER = getAddress('0x000000000000000000000000000000000000c0de')
const COL = getAddress('0x00000000000000000000000000000000c0011eaa')

// spend() (+ a one-time approveWithSignature) — pull funds into the spender.
const spend1: SpenderCall = { to: SPM, data: '0xa1b2c3', value: 0n }
const spend2: SpenderCall = { to: SPM, data: '0xd4e5f6', value: 0n }
// Mint calls as the shared builder emits them (EIP-5792 hex value).
const approve: AgentCall = { to: MINTER, data: '0x00112233', value: '0x0' }
const mint: AgentCall = { to: COL, data: '0x44556677', value: '0x2386f26fc10000' } // 0.01 ETH

console.log('spend-then-mint ordering + value conversion')
const out = composeScoutCollect([spend1, spend2], [approve, mint])
check('both spend calls precede both mint calls', out.length === 4 && out[0] === spend1 && out[1] === spend2)
check('spend calls preserved by reference (untouched)', out[0] === spend1 && out[1] === spend2)
check('approve hex value 0x0 → 0n', out[2].value === 0n)
check('mint hex value 0x2386f26fc10000 → 10000000000000000n wei', out[3].value === 10_000_000_000_000_000n)
check('mint `to` carried through', out[3].to === COL)

console.log('\nalready-registered permission (single spend call)')
const out2 = composeScoutCollect([spend2], [mint])
check('single spend then mint', out2.length === 2 && out2[0] === spend2)
check('value still converts', out2[1].value === 10_000_000_000_000_000n)

// ── Correct-wallet invariant: the mint goes to the USER, never the spender ──
// The spender is only msg.sender (pays, via spend()); mintTo must be the user.
console.log('\ncorrect-wallet: mintTo = the user (recipient), never the spender')
{
  const USER = getAddress('0x1111111111111111111111111111111111111111')
  const SPENDER = getAddress('0x2222222222222222222222222222222222222222')
  // ETH: mintTo is encoded inside the FixedPrice minterArguments (args[4]).
  const e = buildEthMintCall({ tokenId: 7n, mintTo: USER, quantity: 1n, mintFee: 10n, pricePerToken: 1000n, comment: '' })
  const [ethMintTo] = decodeAbiParameters(parseAbiParameters('address, string'), e.args[4] as `0x${string}`)
  check('ETH mint: mintTo === user', eq(ethMintTo, USER))
  check('ETH mint: mintTo !== spender', !eq(ethMintTo, SPENDER))
  check('ETH mint: rewards recipient is the treasury', eq((e.args[3] as readonly string[])[0], REFERRAL))
  // USDC: ERC20Minter.mint(mintTo, ...) — mintTo is arg 0, mintReferral arg 6.
  const u = buildUsdcMintCall({ collection: COL, tokenId: 9n, mintTo: USER, quantity: 1n, pricePerToken: 5_000_000n, comment: '' })
  check('USDC mint: mintTo (arg0) === user', eq(u.args[0] as string, USER))
  check('USDC mint: mintTo !== spender', !eq(u.args[0] as string, SPENDER))
  check('USDC mint: mintReferral is the treasury', eq(u.args[6] as string, REFERRAL))
}

report('OK — scout server: spend-then-mint composition + correct-wallet verified')
