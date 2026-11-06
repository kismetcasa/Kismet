# Arkiv schema — Kismet claim drops

Two entity types, both on **Rabdi** (Arkiv testnet, chain ID 7794095), both
defined once in [`lib/arkiv/schemas.ts`](../lib/arkiv/schemas.ts) and pinned
by [`scripts/verify-drops.ts`](../scripts/verify-drops.ts) (it fails if the
indexed columns drift from this page).

| | `kismet.drop.v1` | `kismet.claim.v1` |
|---|---|---|
| What it is | A time-boxed, free-to-claim release of one artwork | One wallet's claim on one drop |
| Created by (`$creator`) | Kismet's writer wallet | Kismet's writer wallet |
| Owned by (`$owner`) | The artist (handed off in the same transaction) | The collector (handed off in the same transaction) |
| Flags | `readonly`, `permissionlessExtension` | `readonly` |
| Expires | `closesAt` + 7 days | the drop's `closesAt` + 7 days |
| Indexed | `closesAt` | `drop` |

Both are written with one `executeBatch`: create the entity with a predicted
key and transfer it to its user. The node "applies them in order, and either
all of them apply or none do"
([write transactions](https://docs.arkiv.network/json-rpc/mutating-entities/)).
We simulated this batch against Rabdi with `eth_call` (2026-11-06): a drop and
a claim, each created and handed off, run cleanly. A hand-off of a key the
batch didn't create reverts the whole batch with `EntityNotFound(bytes32)`.

## `kismet.drop.v1`

| Field | Type | Indexed | Holds |
|---|---|---|---|
| `artist` | `addr` | no | The artist who opened the drop |
| `closesAt` | `u64` | **yes** | Unix seconds when claims close |
| `maxClaims` | `u64` | no | Claim cap (1–200; one airdrop delivers them all) |
| `title` | `str` | no | ≤ 100 characters and ≤ 128 bytes ("128 bytes of UTF-8", [limits](https://docs.arkiv.network/reference/limits/)) |
| `description` | `bytes` (optional) | no | UTF-8 text, ≤ 1000 characters |
| `swarmRef` | `str` | no | The artwork on Swarm: an unencrypted 32-byte reference, hex |
| `mime` | `str` | no | `image/png` · `image/jpeg` · `image/gif` · `image/webp` |
| `intentNonce` | `str` | no | The nonce the artist signed |
| `intentExpiresAt` | `u64` | no | The signature's expiry the artist signed |
| `intentSignature` | `bytes` | no | The artist's EIP-712 `OpenDrop` signature (EOA or ERC-1271) |

Plus the schema tag `arkiv.schema = "kismet.drop.v1"` (indexed, added by the SDK).

## `kismet.claim.v1`

| Field | Type | Indexed | Holds |
|---|---|---|---|
| `drop` | `key` | **yes** | The drop entity this claim is for |
| `collector` | `addr` | no | The wallet that signed the claim |
| `claimedAt` | `u64` | no | Unix seconds |
| `intentNonce` | `str` | no | The nonce the collector signed |
| `intentExpiresAt` | `u64` | no | The signature's expiry |
| `intentSignature` | `bytes` | no | The collector's EIP-712 `ClaimDrop` signature |

## Why only two indexed fields

An attribute is "either indexed, so queries can filter on it, or stored only,
which costs less"
([introduction](https://docs.arkiv.network/start-here/introduction/)). The
app filters drops by `closesAt` (open vs closed, soonest first) and claims by
`drop`; nothing filters by `artist` or `collector`, so those are stored only.
`collector` is still kept: anyone re-verifying a claim's signature needs the
address that signed it.

## Who can edit what

- **Nobody can change an attribute.** Both types are `readonly` ("the
  entity's attributes can never be changed"), Kismet included. A drop's
  terms (artwork, close time, cap) are fixed the moment it is opened, so they
  can't move after people have claimed.
- **The owner can transfer or delete their own entity.** "Only the owner can
  change, hand over or delete it." After the hand-off that is the artist or
  the collector, not Kismet. A collector with an EOA can hand their claim to
  another wallet before the drop settles; the airdrop follows the claim's
  current owner.
- **Anyone can extend a drop** (`permissionlessExtension`: "anyone can extend
  the entity, not only its owner"). After the hand-off Kismet no longer owns
  the drop, so this is what still lets Kismet, or a collector, keep it alive
  through a slow settlement. Nobody can edit it this way. Claims are not
  extendable by others.

## Why these expiry times

A drop and its claims are only needed until the drop **settles**: the artist
mints the artwork on Base and airdrops a copy to every claim. The 7-day grace
after `closesAt` is the artist's time to do that. After it, both expire. The
permanent record is the NFT on Base. Arkiv charges for lifetime ("A shorter
lifetime costs less, so start short and extend what you still need",
[expiration](https://docs.arkiv.network/writing/expiration/)), so a record
lives exactly as long as it is useful. The longest window (30 days) plus the
grace stays well inside the 7,884,000-block (~182.5-day) maximum lifetime;
`verify-drops.ts` checks this.

## The queries the app runs

All are pinned to `$creator = <Kismet writer>`: "Filtering by owner or
creator is the only way to be sure an entity came from an account you trust"
([filter](https://docs.arkiv.network/querying/filter/)). Rendered by the SDK
from [`lib/arkiv/drops.ts`](../lib/arkiv/drops.ts), and run against Rabdi on
2026-11-06:

```text
# Open drops, soonest-closing first             (/drops, GET /api/drops)
arkiv.schema = str('kismet.drop.v1') AND closesAt > u64(<now>) AND $creator = addr(<writer>) ORDER BY closesAt:u64 ASC

# Drops waiting to settle, newest first          (/drops "Closed — being delivered")
arkiv.schema = str('kismet.drop.v1') AND closesAt <= u64(<now>) AND $creator = addr(<writer>) ORDER BY closesAt:u64 DESC

# Claims on a drop, keyset-paged                 (drop page, airdrop prefill)
arkiv.schema = str('kismet.claim.v1') AND drop = key(<drop>) AND $key > key(<last>) AND $creator = addr(<writer>) ORDER BY $key:key ASC

# Claim count per drop                            (feed cards)
arkiv.schema = str('kismet.claim.v1') AND drop = key(<drop>) AND $creator = addr(<writer>)
```

Plus `getEntity(<drop>)` for one drop. The claims walk uses
`onMismatch: "throw"`, as the
[pagination docs](https://docs.arkiv.network/querying/paginate/) advise for
paging by key: a skipped row would shorten a page and end the walk early.
