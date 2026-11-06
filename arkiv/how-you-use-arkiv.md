# How Kismet uses Arkiv

**Claim drops**: an artist opens a time-boxed, free-to-claim drop; collectors
claim it with one signature (no gas, no fee, no ETH); when the window closes,
the artist mints the artwork once on Base and airdrops a copy to every claim.

Arkiv holds exactly the part of that which is shared, public and temporary:
**the open drop and the pending claims**. Entity shapes: [schema.md](schema.md).

## Does what we filter on, who can edit, and when it expires fit the product?

| Product need | Arkiv mechanism | Why it fits |
|---|---|---|
| "What can I claim right now, what's closing soonest?" | Indexed `closesAt`, `closesAt > now ORDER BY closesAt ASC` | That *is* the drops feed — one query, no index of our own |
| "This artist's drops" | Indexed `artist` | Artist pages and `GET /api/drops?artist=` |
| "Who claimed this drop?" / "how many?" | Indexed `drop` key on claims, `count()` | Drop page counter and the airdrop list |
| "What have I claimed?" | `$owner` (claims are handed to collectors) | A claim shows up wherever its owner is queried |
| "Is this real, or a look-alike?" | `$creator` = Kismet's writer | Only claims Kismet admitted (signature, cap, blocklist) count |
| "The terms can't change under me" | `readonly` flag | Nobody — Kismet included — can edit a drop's cap, close time or artwork |
| "Keep this drop around a bit longer" | `permissionlessExtension` | A collector or Kismet's keeper can extend; neither can edit |
| "The drop is over — clean up" | Expiry = `closesAt` + 7-day settle grace | Drops and claims disappear after settlement; the NFT on Base is the permanent record |

**Who can edit each entity:** no one can change attributes (`readonly`). The
artist owns their drop; each collector owns their claim and can transfer or
delete it. Anyone can extend a drop. Kismet's writer creates everything (so
it is `$creator`) but owns nothing after the hand-off.

**When it expires:** a drop exists while it is useful — open, then 7 days of
settlement — and no longer. We picked this deliberately instead of storing
forever: a claim is a promise to deliver, and once it's delivered (an NFT on
Base) the promise has no reason to live on.

## Does each Arkiv feature change something users see?

| Arkiv feature | What the user sees |
|---|---|
| Indexed attributes + `ORDER BY` | The `/drops` feed ("Open now", soonest-closing first) and "Closed — being delivered" |
| `count()` | "37 / 100 claimed" on every card and drop page, live while open |
| Ownership hand-off (`changeOwnership` in the same batch) | The drop's "On Arkiv" panel lists each claim → its owner; the artist page lists drops the artist owns |
| `$creator` filter | Counts and airdrop lists can't be padded with look-alike entities |
| `readonly` | "Read-only, owned by the artist" on the drop page — the terms you claimed under are the terms you get |
| Expiration | "Claims closed" → settle panel → the drop leaves the feed by itself; the drop page shows the date its record expires |
| `permissionlessExtension` | Lets the drop outlive a slow settlement without anyone being able to edit it |
| `executeBatch` | A burst of claims lands in a few transactions; each claim is created **and** handed to its collector atomically |
| Public, queryable entities | The artist's airdrop tab is prefilled straight from Arkiv (`/mint?tab=airdrop&drop=<key>`), and any other app can read the same feed |

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
| Open / list | [`app/api/drops/route.ts`](../app/api/drops/route.ts) |
| Claim | [`app/api/drops/[key]/claim/route.ts`](../app/api/drops/[key]/claim/route.ts) |
| Drop + claims | [`app/api/drops/[key]/route.ts`](../app/api/drops/[key]/route.ts) |
| Airdrop prefill from Arkiv | [`app/mint/page.tsx`](../app/mint/page.tsx) |
| Pages | [`app/drops`](../app/drops) · [`components/DropsFeed.tsx`](../components/DropsFeed.tsx) · [`components/DropView.tsx`](../components/DropView.tsx) · [`components/DropForm.tsx`](../components/DropForm.tsx) |
