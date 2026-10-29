// lib/creatorCopy: the artist's copy of a limited edition, which the In
// Process relay drops (2026-10, "unholy coast" — an edition of 22, minted
// with "Mint a copy to myself" on, came out with no copy), and the closed
// sale a 1/1 is created with so its single edition isn't a free public mint.
//
// Run: node --experimental-strip-types --import ./scripts/register-ts-alias.mjs scripts/verify-creator-copy.ts

import { canAdminMint, creatorCopyFromWallet, ONE_OF_ONE_SALE, SALE_CLOSED_AT_CREATE } from '../lib/creatorCopy.ts'
import { getSaleWindow, parseRealSaleEnd } from '../lib/inprocess.ts'
import { PERMISSION_BIT_ADMIN, PERMISSION_BIT_MINTER, PERMISSION_BIT_METADATA, PERMISSION_BIT_SALES } from '../lib/permissions.ts'

let failures = 0
const check = (name: string, cond: boolean): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}`)
    failures++
  }
}

// The relay's rule, as In Process ships it (in_process_api
// src/lib/moment/createTokenParam.ts). If they ever change it, this mirror is
// what to update — and the balance read in hooks/useCreatorCopy already stops
// a second copy.
const relayKeepsCopy = (maxSupply: number | undefined, mintToCreatorCount: number) =>
  (maxSupply === undefined ? mintToCreatorCount : 0) > 0

for (const [label, artistMint, maxSupply] of [
  ['open edition, copy wanted', true, undefined],
  ['edition of 22, copy wanted', true, 22],
  ['1/1, copy wanted', true, 1],
  ['open edition, no copy', false, undefined],
  ['edition of 22, no copy', false, 22],
] as const) {
  const relay = relayKeepsCopy(maxSupply, artistMint ? 1 : 0)
  const wallet = creatorCopyFromWallet({ artistMint, maxSupply })
  check(`${label}: exactly one path sends the copy when wanted, none when not`, artistMint ? relay !== wallet : !relay && !wallet)
}

check('adminMint gate: ADMIN on the collection', canAdminMint(PERMISSION_BIT_ADMIN))
check('adminMint gate: MINTER on the collection', canAdminMint(PERMISSION_BIT_MINTER))
check('adminMint gate: ADMIN on the token only', canAdminMint(0n, PERMISSION_BIT_ADMIN))
check('adminMint gate: METADATA|SALES is not enough', !canAdminMint(PERMISSION_BIT_METADATA | PERMISSION_BIT_SALES))
check('adminMint gate: nothing is not enough', !canAdminMint(0n))

// 1/1: closed from creation, priced 0, fixed-price ETH (ERC20Minter refuses 0).
const now = 1_790_000_000
check('1/1 sale is fixed-price ETH at 0', ONE_OF_ONE_SALE.type === 'fixedPrice' && ONE_OF_ONE_SALE.pricePerToken === '0' && !('currency' in ONE_OF_ONE_SALE))
check('1/1 sale has ended on-chain (collect gating reads it closed)', parseRealSaleEnd(ONE_OF_ONE_SALE.saleEnd) === 1 && Number(ONE_OF_ONE_SALE.saleEnd) <= now)
check('1/1 sale shows no "Ended Jan 1, 1970" label', getSaleWindow(ONE_OF_ONE_SALE, now) === null)
check('the marker is the 1/1 sale end', ONE_OF_ONE_SALE.saleEnd === SALE_CLOSED_AT_CREATE)
check('a real ended sale still shows as ended', getSaleWindow({ saleStart: '0', saleEnd: String(now - 60) }, now)?.state === 'ended')
check('an open sale still shows as live', getSaleWindow({ saleStart: '0', saleEnd: '18446744073709551615' }, now)?.state === 'live')

console.log(failures === 0 ? '\nAll creator-copy checks passed.' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
