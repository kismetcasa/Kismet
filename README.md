# inprocess-client
marketplace for artists and collectors built on inprocess

## Claim drops — Arkiv + Swarm (ETHGlobal Mumbai)

Free, time-boxed drops. An artist opens a drop; collectors claim it with one
signature (**no gas, no fee, no ETH**); when the window closes, the artist
mints the artwork once on Base and airdrops a copy to every claim. The drop
and its claims are **Arkiv** entities; the artwork is on **Swarm** until the
drop is minted.

| | |
|---|---|
| How it uses Arkiv | [arkiv/how-you-use-arkiv.md](arkiv/how-you-use-arkiv.md) |
| Entities, fields, owners, expiry | [arkiv/schema.md](arkiv/schema.md) |
| Why Arkiv / what stayed off it | [arkiv/why-arkiv.md](arkiv/why-arkiv.md) |
| Reach | [arkiv/reach.md](arkiv/reach.md) |
| Feedback | [arkiv/friction.md](arkiv/friction.md) |
| Swarm | [arkiv/swarm.md](arkiv/swarm.md) |

### What existed before the event, and what we added

Kismet (this repository up to commit `41931f7`, kismetcasa/Kismet#722) was already a live
marketplace: Zora 1155 mints through In Process, Arweave media, a Seaport
market, airdrops, the Kismet Pass gate, all on Upstash Redis. It had no
Arkiv or Swarm code.

Added at ETHGlobal Mumbai (judge only this):

- `lib/drops.ts` — rules, EIP-712 `OpenDrop` / `ClaimDrop` intents, settlement list
- `lib/arkiv/` — schemas, the serialized batch writer, every query
- `lib/swarm.ts` — Bee upload / read / batch status
- `lib/dropsStore.ts` — claim cap and upload marker (Redis), short caches of Arkiv reads
- `app/api/drops/**` — open, claim, list, media
- `app/drops/**`, `components/Drop*.tsx`, `hooks/useDropIntents.ts` — the pages
- Small hooks into existing code: `verifyTypedIntent` in `lib/intentAuth.ts`
  (the existing `verifyIntent` now delegates to it, unchanged in behavior),
  quota kinds in `lib/userQuota.ts`, the airdrop prefill in `app/mint/page.tsx`,
  `components/MintTabs.tsx`, `components/AirdropForm.tsx`, and the
  build-secret and route-SEO guards in `scripts/`
- `scripts/verify-drops.ts` (in `npm run check`), `scripts/drops-smoke.ts`, `arkiv/*.md`

### Wallets that wrote our entities

- Arkiv writer (`$creator` of every drop and claim): TODO(team): the address
  of `ARKIV_WRITER_PRIVATE_KEY`, printed by `npm run drops:smoke`.

### One query to run

Open drops, soonest-closing first:

```text
arkiv.schema = str('kismet.drop.v1') AND closesAt > u64(<unix now>) AND $creator = addr(<writer above>) ORDER BY closesAt:u64 ASC
```

The SDK version is in [arkiv/how-you-use-arkiv.md](arkiv/how-you-use-arkiv.md#one-query-you-can-run).

### Run it

```bash
npm ci
```

Put these in `.env.local` (see `.env.example` → "Claim drops"):

```bash
DROPS_ENABLED=1
ARKIV_WRITER_PRIVATE_KEY=0x…   # Rabdi key funded at hub.arkiv.network/faucet
ARKIV_ACCESS_KEY=…             # optional, hub.arkiv.network/access-keys
SWARM_BEE_URL=http://127.0.0.1:1633
SWARM_BATCH_ID=…
```

Check Arkiv and Swarm end to end, then run the app and open `/drops`:

```bash
npm run drops:smoke
```

```bash
npm run dev
```

Opening a drop requires a Kismet Pass when the Pass gate is on. Production
turns the feature on with the same `DROPS_ENABLED=1` (runtime environment);
Kismet's existing platform pause stops uploads, opens and claims at once.

### How we used AI

Built with Claude Code (Anthropic): the design discussion, the code, the
tests and these docs were drafted with it and reviewed by the team.
TODO(team): add anything else, per ETHGlobal's rules.

### License

MIT — see [LICENSE](LICENSE).
