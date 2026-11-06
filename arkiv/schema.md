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
| Typical size | < 2 KB | < 1 KB |

Both are written with one `executeBatch`: create the entity (with a predicted
key) and transfer it to its user, atomically — see
[`lib/arkiv/client.ts`](../lib/arkiv/client.ts).

## `kismet.drop.v1`

| Field | Type | Indexed | Holds |
|---|---|---|---|
| `artist` | `addr` | **yes** | The artist who opened the drop |
| `closesAt` | `u64` | **yes** | Unix seconds when claims close |
| `maxClaims` | `u64` | no | Claim cap (1–200; one airdrop delivers them all) |
| `title` | `str` | no | ≤ 100 characters and ≤ 128 bytes (Arkiv's `str` cap) |
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
| `collector` | `addr` | **yes** | The wallet that signed the claim |
| `claimedAt` | `u64` | no | Unix seconds |
| `intentNonce` | `str` | no | The nonce the collector signed |
| `intentExpiresAt` | `u64` | no | The signature's expiry |
| `intentSignature` | `bytes` | no | The collector's EIP-712 `ClaimDrop` signature |

## Who can edit what

- **Nobody can change an attribute** — both types are `readonly`, Kismet
  included. A drop's terms (artwork, close time, cap) are fixed the moment it
  is opened, so they can't move after people have claimed.
- **The owner can transfer or delete their own entity.** A collector who holds
  an EOA can hand their claim to another wallet before the drop settles; the
  airdrop follows the claim's current owner.
- **Anyone can extend a drop** (`permissionlessExtension`), so a collector or
  Kismet's keeper can keep one alive past its default expiry without being
  able to alter it. Claims are not extendable by others.

## Why these expiry times

A drop and its claims are only needed until the drop **settles**: the artist
mints the artwork on Base and airdrops a copy to every claim. The 7-day grace
after `closesAt` is the artist's time to do that. After it, both expire — the
permanent record is the NFT on Base. The longest window (30 days) plus the
grace stays well inside Arkiv's ~182-day maximum lifetime (checked in
`verify-drops.ts`).

## The queries the app runs

All are pinned to `$creator = <Kismet writer>`, so an entity someone else
writes with the same tag never reaches a feed, a count or an airdrop list.
(Rendered by the SDK from [`lib/arkiv/drops.ts`](../lib/arkiv/drops.ts).)

```text
# Open drops, soonest-closing first            (/drops, GET /api/drops)
arkiv.schema = str('kismet.drop.v1') AND closesAt > u64(<now>) AND $creator = addr(<writer>) ORDER BY closesAt:u64 ASC

# Drops waiting to settle, newest first          (/drops "Closed — being delivered")
arkiv.schema = str('kismet.drop.v1') AND closesAt <= u64(<now>) AND $creator = addr(<writer>) ORDER BY closesAt:u64 DESC

# One artist's open drops                        (GET /api/drops?artist=0x…)
arkiv.schema = str('kismet.drop.v1') AND closesAt > u64(<now>) AND artist = addr(<artist>) AND $creator = addr(<writer>) ORDER BY closesAt:u64 ASC

# Claims on a drop, keyset-paged                 (drop page, airdrop prefill)
arkiv.schema = str('kismet.claim.v1') AND drop = key(<drop>) AND $key > key(<last>) AND $creator = addr(<writer>) ORDER BY $key:key ASC

# Claim count / has this wallet claimed          (drop page, feed cards)
arkiv.schema = str('kismet.claim.v1') AND drop = key(<drop>) AND $creator = addr(<writer>)
arkiv.schema = str('kismet.claim.v1') AND drop = key(<drop>) AND collector = addr(<wallet>) AND $creator = addr(<writer>)

# Claims a wallet owns now                        (ownedBy)
arkiv.schema = str('kismet.claim.v1') AND $owner = addr(<wallet>) AND $creator = addr(<writer>) ORDER BY claimedAt:u64 DESC
```
