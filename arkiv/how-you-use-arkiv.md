# How Kismet uses Arkiv

**Claim drops.** An artist opens a time-boxed, free-to-claim drop.
Collectors claim it with one signature: no gas, no fee, no ETH. When the
window closes, the artist delivers it from the drop page: one free signature
mints the edition on Base, one transaction airdrops it to every claim, and
once Base confirms that airdrop Kismet records the delivery on Arkiv.

Arkiv holds exactly the part of that which is shared, public and temporary:
**the open drop, the pending claims, and the record that each was
delivered**. Entity shapes: [schema.md](schema.md).

## Do our filters, edit rights and expiry fit the product?

| Product need | Arkiv mechanism | Why it fits |
|---|---|---|
| "What can I claim right now, what's closing soonest?" | Indexed `closesAt`, `closesAt > now ORDER BY closesAt ASC` | That *is* the drops feed: one query, no index of our own |
| "What's waiting to be delivered?" | The same column, `closesAt <= now ORDER BY closesAt DESC` | Closed drops stay listed until their records expire |
| "Who claimed this drop, and how many?" | Indexed `drop` key on claims, `count()` | The drop page's counter and the airdrop list |
| "Is this real, or a look-alike?" | `$creator` = Kismet's writer | Only claims Kismet admitted (signature, cap, blocklist) count |
| "The terms can't change under me" | `readonly` flag | Nobody, Kismet included, can edit a drop's cap, close time or artwork |
| "Deliver to whoever holds the claim" | `$owner`, set by the hand-off | The airdrop list is each claim's current owner |
| "What have I claimed, and has it arrived?" | `$owner` again (`ownedBy`) | "Your claims" on `/drops`, each open, waiting or delivered |
| "Was it delivered, and as what?" | `kismet.settlement.v1`, indexed `drop` | "Delivered ✓" with the Base token, written only after Base confirms the airdrop |
| "Don't let a drop lapse undelivered" | `closesAt BETWEEN …` | The artist is notified when a drop closes with claims, and again two days before it expires |
| "The drop is over, clean up" | Expiry = `closesAt` + 7-day delivery grace | Drops, claims and settlements disappear after that; the NFT on Base is the permanent record |

**Who can edit each entity:** no one can change attributes (`readonly`). The
artist owns their drop, and each collector owns their claim and can transfer
or delete it. Anyone can extend a drop. Kismet's writer creates everything
(so it is `$creator`) but owns nothing after the hand-off.

**When it expires:** a drop exists while it is useful (open, then 7 days to
deliver it) and no longer. Arkiv bills for lifetime, and a claim is a promise
to deliver: once it's delivered as an NFT on Base, the promise has no reason
to live on.

## Does each Arkiv feature change something users see?

| Arkiv feature | What the user sees |
|---|---|
| Indexed attributes + `ORDER BY` | The `/drops` feed: "Open now", soonest-closing first, then "Closed" |
| `count()` | "37 / 100 claimed" on every feed card |
| Ownership hand-off (`changeOwnership` in the same batch) | The drop page's "On Arkiv" panel lists each claim → its owner, and the delivery airdrops to exactly those owners |
| `ownedBy` | "Your claims" on `/drops`, with where each one stands |
| `$creator` filter | Counts, recipient lists and "delivered" badges can't be padded or faked with look-alike entities |
| `readonly` | "Read-only, owned by the artist" on the drop page: the terms you claimed under are the terms you get, and a settlement can't be edited after the fact |
| Expiration | "Claims closed" → the artist's Deliver panel → the drop leaves the feed by itself; the drop page shows when its record expires |
| `permissionlessExtension` | Lets a drop outlive a slow delivery without anyone being able to edit it |
| `executeBatch` | A burst of claims lands in a few transactions, each claim created **and** handed to its collector atomically |
| Public, queryable entities | The delivery reads its recipient list straight from Arkiv, and any other app can read the same feed, or check a drop's settlement against Base |

## What we validated, and how

End to end on 2026-11-07, without a funded key
([`scripts/e2e/README.md`](../scripts/e2e/README.md#claim-drops)):

- **The whole flow through the real route handlers** (`drops-flow.ts`, 60
  checks): upload, open, claim (per wallet and per Farcaster account, under
  the cap, refused when closed), close, deliver (prepare, mint through the
  relay, airdrop, verified record, resume after an interrupted delivery),
  "your claims", reminders — on a real Redis, with Arkiv held in memory.
- **The live services** (`drops-live.ts`, 21 checks): every Arkiv query the
  app runs, every Arkiv write simulated on Rabdi by the SDK and stopped just
  before sending (drop 190,797 gas, claim 173,158, settlement 168,424 with
  65-byte signatures), the funds guard on a real balance, and the settlement
  checks on real Base receipts.
- **The pages in Chromium** (`drops-ui.ts`, 26 checks): claiming, the feed
  and "your claims", the window closing on screen, and the four-step delivery
  with real signatures.

Earlier, against Rabdi on 2026-11-06, with a throwaway unfunded key:

- **Every read query the app runs** returned without error from the live
  node (chain 7794095, 2-second blocks per `getBlockTiming`).
- **The write design, simulated with `eth_call`** (no funds needed): a drop
  and a claim, each created with a predicted key and handed off in the same
  batch, run cleanly.
- **Three negative controls revert:**
  - handing off a key the batch didn't create gives `EntityNotFound(bytes32)`;
  - creating without the predicted salt gives `EntityNotFound(bytes32)`;
  - handing off to the writer itself gives `TransferToSelf(bytes32)`.
- **Batch size:** with 1 KB (smart-wallet) signatures, 1 claim + hand-off
  estimates at 271,151 gas and 16 claims at 3,858,802 gas, under a quarter of
  the 2^24 per-transaction cap. That is why the writer batches up to 16, and
  why the funds guard budgets 271,151 per claim.

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
| Drop + claims + settlement | [`app/api/drops/[key]/route.ts`](../app/api/drops/[key]/route.ts) |
| Delivery: prepare, mint, verified record | [`app/api/drops/[key]/settle`](../app/api/drops/[key]/settle) · [`lib/dropSettlement.ts`](../lib/dropSettlement.ts) · [`components/DropSettle.tsx`](../components/DropSettle.tsx) |
| Your claims | [`app/api/drops/claims/route.ts`](../app/api/drops/claims/route.ts) |
| Reminders | [`lib/dropNotices.ts`](../lib/dropNotices.ts) |
| Pages | [`app/drops`](../app/drops) · [`components/DropsFeed.tsx`](../components/DropsFeed.tsx) · [`components/DropView.tsx`](../components/DropView.tsx) · [`components/DropForm.tsx`](../components/DropForm.tsx) |
