# How Kismet uses Arkiv

**Claim drops.** An artist opens a time-boxed, free-to-claim drop.
Collectors claim it with one signature: no gas, no fee, no ETH. When the
window closes, the artist mints the artwork once on Base and airdrops a copy
to every claim.

Arkiv holds exactly the part of that which is shared, public and temporary:
**the open drop and the pending claims**. Entity shapes: [schema.md](schema.md).

## Do our filters, edit rights and expiry fit the product?

| Product need | Arkiv mechanism | Why it fits |
|---|---|---|
| "What can I claim right now, what's closing soonest?" | Indexed `closesAt`, `closesAt > now ORDER BY closesAt ASC` | That *is* the drops feed: one query, no index of our own |
| "What's waiting to be delivered?" | The same column, `closesAt <= now ORDER BY closesAt DESC` | Closed drops stay listed until their records expire |
| "Who claimed this drop, and how many?" | Indexed `drop` key on claims, `count()` | The drop page's counter and the airdrop list |
| "Is this real, or a look-alike?" | `$creator` = Kismet's writer | Only claims Kismet admitted (signature, cap, blocklist) count |
| "The terms can't change under me" | `readonly` flag | Nobody, Kismet included, can edit a drop's cap, close time or artwork |
| "Deliver to whoever holds the claim" | `$owner`, set by the hand-off | The airdrop list is each claim's current owner |
| "The drop is over, clean up" | Expiry = `closesAt` + 7-day settle grace | Drops and claims disappear after settlement; the NFT on Base is the permanent record |

**Who can edit each entity:** no one can change attributes (`readonly`). The
artist owns their drop, and each collector owns their claim and can transfer
or delete it. Anyone can extend a drop. Kismet's writer creates everything
(so it is `$creator`) but owns nothing after the hand-off.

**When it expires:** a drop exists while it is useful (open, then 7 days of
settlement) and no longer. Arkiv bills for lifetime, and a claim is a promise
to deliver: once it's delivered as an NFT on Base, the promise has no reason
to live on.

## Does each Arkiv feature change something users see?

| Arkiv feature | What the user sees |
|---|---|
| Indexed attributes + `ORDER BY` | The `/drops` feed: "Open now", soonest-closing first, and "Closed — being delivered" |
| `count()` | "37 / 100 claimed" on every feed card |
| Ownership hand-off (`changeOwnership` in the same batch) | The drop page's "On Arkiv" panel lists each claim → its owner; the airdrop tab is prefilled with those owners |
| `$creator` filter | Counts and airdrop lists can't be padded with look-alike entities |
| `readonly` | "Read-only, owned by the artist" on the drop page: the terms you claimed under are the terms you get |
| Expiration | "Claims closed" → settle panel → the drop leaves the feed by itself; the drop page shows when its record expires |
| `permissionlessExtension` | Lets a drop outlive a slow settlement without anyone being able to edit it |
| `executeBatch` | A burst of claims lands in a few transactions, each claim created **and** handed to its collector atomically |
| Public, queryable entities | The artist's airdrop tab is prefilled straight from Arkiv (`/mint?tab=airdrop&drop=<key>`), and any other app can read the same feed |

## What we validated, and how

Against Rabdi on 2026-11-06, with a throwaway unfunded key:

- **Every read query the app runs** returned without error from the live
  node (chain 7794095, 2-second blocks per `getBlockTiming`).
- **The write design, simulated with `eth_call`** (no funds needed): a drop
  and a claim, each created with a predicted key and handed off in the same
  batch, run cleanly.
- **Three negative controls revert:**
  - handing off a key the batch didn't create gives `EntityNotFound(bytes32)`;
  - creating without the predicted salt gives `EntityNotFound(bytes32)`;
  - handing off to the writer itself gives `TransferToSelf(bytes32)`.
- **Batch size:** 1 claim + hand-off estimates at 271,151 gas; 16 claims with
  1 KB signatures at 3,858,802 gas, under a quarter of the 2^24
  per-transaction cap. That is why the writer batches up to 16.

What still needs a funded writer is the real transaction: `npm run drops:smoke`.

## One query you can run

```text
arkiv.schema = str('kismet.drop.v1') AND closesAt > u64(<unix now>) AND $creator = addr(<writer>) ORDER BY closesAt:u64 ASC
```

With the SDK:

```ts
import { createPublicClient } from '@arkiv-network/sdk'
import { rabdi } from '@arkiv-network/sdk/chains'
import { asc, gt } from '@arkiv-network/sdk/query'
import { u64 } from '@arkiv-network/sdk/schema'
import { http } from 'viem'
import { DropSchema } from './lib/arkiv/schemas'

const client = createPublicClient({ chain: rabdi({ accessKey: '' }), transport: http() })
const open = await client
  .select({ $key: true, title: true, closesAt: true, swarmRef: true })
  .from(DropSchema)
  .where(gt('closesAt', u64(BigInt(Math.floor(Date.now() / 1000)))))
  .createdBy('<writer>') // the address in the README
  .orderBy(asc('closesAt'))
  .limit(24)
  .fetch()
```

## Where it is in the code

| | File |
|---|---|
| Schemas | [`lib/arkiv/schemas.ts`](../lib/arkiv/schemas.ts) |
| Writer (serialized batches, create + hand-off) | [`lib/arkiv/client.ts`](../lib/arkiv/client.ts) |
| Writes and every query | [`lib/arkiv/drops.ts`](../lib/arkiv/drops.ts) |
| Claim cap, upload marker, read caches | [`lib/dropsStore.ts`](../lib/dropsStore.ts) |
| Open / list | [`app/api/drops/route.ts`](../app/api/drops/route.ts) |
| Claim | [`app/api/drops/[key]/claim/route.ts`](../app/api/drops/[key]/claim/route.ts) |
| Drop + claims | [`app/api/drops/[key]/route.ts`](../app/api/drops/[key]/route.ts) |
| Airdrop prefill from Arkiv | [`app/mint/page.tsx`](../app/mint/page.tsx) |
| Pages | [`app/drops`](../app/drops) · [`components/DropsFeed.tsx`](../components/DropsFeed.tsx) · [`components/DropView.tsx`](../components/DropView.tsx) · [`components/DropForm.tsx`](../components/DropForm.tsx) |
