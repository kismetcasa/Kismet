import type { Address, Hex, VerifyTypedDataParameters } from 'viem'
import type { StoredSpendPermission } from './serverExecutor'

/** The SpendPermissionManager singleton (coinbase/spend-permissions README;
 *  the @base-org/account SDK's `spendPermissionManagerAddress`). */
export const SPEND_PERMISSION_MANAGER: Address = '0xf85210B21cC50302F477BA56686d2019dC9b67Ad'

// SpendPermissionManager.SPEND_PERMISSION_TYPEHASH, and its EIP-712 domain
// (`_domainNameAndVersion`: "Spend Permission Manager" / "1").
const SPEND_PERMISSION_TYPES = {
  SpendPermission: [
    { name: 'account', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'allowance', type: 'uint160' },
    { name: 'period', type: 'uint48' },
    { name: 'start', type: 'uint48' },
    { name: 'end', type: 'uint48' },
    { name: 'salt', type: 'uint256' },
    { name: 'extraData', type: 'bytes' },
  ],
} as const

/** A grant at or past its `end` (exclusive — SpendPermissionManager.getCurrentPeriod
 *  reverts AfterSpendPermissionEnd from then on) is inert. The SDK's
 *  getPermissionStatus THROWS for one (that revert fails its multicall), so
 *  every path asks this before asking the SDK. */
export function isGrantEnded(p: StoredSpendPermission, nowSec = Math.floor(Date.now() / 1000)): boolean {
  return p.permission.end <= nowSec
}

/**
 * The arguments for a `verifyTypedData` of the stored grant against its owner
 * — the wallet's word, not the client's. viem's public-client action is
 * ERC-1271 / ERC-6492 aware, so deployed and counterfactual Base Accounts
 * both verify.
 */
export function permissionTypedData(owner: Address, p: StoredSpendPermission): VerifyTypedDataParameters {
  const d = p.permission
  return {
    address: owner,
    domain: { name: 'Spend Permission Manager', version: '1', chainId: p.chainId, verifyingContract: SPEND_PERMISSION_MANAGER },
    types: SPEND_PERMISSION_TYPES,
    primaryType: 'SpendPermission',
    message: {
      account: d.account as Address,
      spender: d.spender as Address,
      token: d.token as Address,
      allowance: BigInt(d.allowance),
      period: d.period,
      start: d.start,
      end: d.end,
      salt: BigInt(d.salt),
      extraData: (d.extraData || '0x') as Hex,
    },
    signature: p.signature as Hex,
  }
}
