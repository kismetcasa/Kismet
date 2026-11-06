# Reach

## Who uses Kismet today

Kismet is a live marketplace for artists and collectors on Base
([kismet.art](https://kismet.art)). Most people use it inside **Farcaster and
the Base App** as a Mini App, the rest on the web.

- **Artists** mint artworks for free (Kismet sponsors the mint and the
  Arweave storage), gated by the Kismet Pass — a Patron drop collected on
  Kismet (Patron editions of 19 and 100).
- **Collectors** collect editions (Zora 1155 on Base), resell them on Kismet's
  Seaport market, and get airdrops from artists.

TODO(team): add current numbers from `/api/stats` / the admin dashboard —
Pass-holding artists, artworks minted, collectors per month, share of free
mints.

## Will they use the part on Arkiv?

Claim drops target the moment a collector arrives from a cast and hits
**"you need ETH on Base to collect this free artwork"**. Today a free mint
still costs 0.000111 ETH per edition (≈ $0.30 at the $2,688 ETH of
6 Nov 2026) plus gas. For a new collector that's a bridge-and-buy detour, for
anyone else a fee on something called free. A claim is **one signature**: no
ETH, no gas, no fee. They still get the real ERC-1155 on Base, by airdrop, when the
drop settles.

For artists it is the same Pass, the same mint, one extra airdrop at the end
(a few cents of Base gas for the whole list), and a reason to share: a drop
has a deadline and a live claim counter.

For Kismet it means paying permanent Arweave storage only for artwork people
claimed, instead of for every mint.

## Can they try it today, and will it ship after Mumbai?

- **Today:** the code is in this repo behind a flag. Run it locally (README →
  "Claim drops") with `DROPS_ENABLED=1`, a funded Arkiv writer and a Bee
  node.
- **After Mumbai:** it ships to production behind `kismetart:drops-enabled`
  (`POST /api/admin/drops`), the same flag pattern Kismet used to ship sweep.
  What production needs:
  1. a Bee container next to the app, with its own postage batch (the
     event's gift batch lives on a laptop node);
  2. a funded Arkiv writer key, set runtime-only;
  3. a plan for Arkiv mainnet. Records are short-lived by design (at most
     30 days open + 7 settling), so a migration means draining open drops,
     not moving history.
- **What we'll measure:** claims per drop against free Zora mints of
  comparable artists, the share of claimers who had no ETH on Base, and how
  long artists take to settle.

## Who else can use the data

`kismet.drop.v1` and `kismet.claim.v1` are public. Any Farcaster frame,
wallet or agent can list open drops, show claim counts, or check that an
airdrop matched its claims without going through Kismet. Kismet's own agent
skill ([`public/agent-skill`](../public/agent-skill/SKILL.md)) is the first
consumer we'd point at it.
