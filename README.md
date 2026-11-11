# inprocess-client
marketplace for artists and collectors built on inprocess

## Claim drops — Arkiv + Swarm (ETHGlobal Mumbai)

Free, time-boxed drops. An artist opens a drop; collectors claim it with one
signature (**no gas, no fee, no ETH**); when the window closes, the artist
delivers it from the drop page — one free signature mints the edition on
Base, one transaction airdrops it to every claim — and once Base confirms the
airdrop, the delivery is recorded on Arkiv. The drop, its claims and its
settlement are **Arkiv** entities; the artwork is on **Swarm** until the drop
is minted.

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

- `lib/drops.ts` — rules, EIP-712 `OpenDrop` / `ClaimDrop` intents, the delivery's recipient list, notice copy
- `lib/arkiv/` — schemas, the serialized batch writer (with its funds check), every query
- `lib/swarm.ts` — Bee upload / read / batch status
- `lib/dropsStore.ts` — claim reservation (per wallet and per Farcaster account), upload marker, delivery progress and lock (Redis), short caches of Arkiv reads
- `lib/dropSettlement.ts` — is a drop delivered? Answered from Base
- `lib/dropNotices.ts` — the artist's reminders
- `app/api/drops/**` — open, claim, list, media, your claims, and delivery (prepare → mint → verified record)
- `app/drops/**`, `components/Drop*.tsx`, `hooks/useDropIntents.ts` — the pages, the Deliver panel, the share card
- Small hooks into existing code: `verifyTypedIntent` in `lib/intentAuth.ts`
  (the existing `verifyIntent` now delegates to it, unchanged in behavior),
  `getFarcasterFid` in `lib/session.ts`, quota kinds in `lib/userQuota.ts`,
  a `drop_status` notification type (`lib/notifications.ts`, its bell row,
  push copy and settings label), the reminder tick in `lib/backgroundTasks.ts`,
  the "Drop" link in `components/MintTabs.tsx` (via `app/mint/page.tsx`), and
  the build-secret and route-SEO guards in `scripts/`
- `scripts/verify-drops.ts` (in `npm run check`), `scripts/drops-smoke.ts`,
  `scripts/e2e/drops-*.ts`, `arkiv/*.md`

### Wallets that wrote our entities

- Arkiv writer (`$creator` of every drop, claim and settlement): TODO(team):
  the address of `ARKIV_WRITER_PRIVATE_KEY`, printed by `npm run drops:smoke`.

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

Check the configuration without writing anything, then Arkiv and Swarm end
to end, then run the app and open `/drops`:

```bash
npm run drops:smoke -- --check
```

```bash
npm run drops:smoke
```

```bash
npm run dev
```

Opening a drop requires a Kismet Pass when the Pass gate is on. Production
turns the feature on with the same `DROPS_ENABLED=1` (runtime environment);
Kismet's existing platform pause stops uploads, opens and claims at once.
Operating it: [OPS_RUNBOOK.md §7](OPS_RUNBOOK.md#7-claim-drops-arkiv--swarm).

The end-to-end checks — the whole flow through the real routes, the live
services without a funded key, and the pages in Chromium — are in
[scripts/e2e/README.md](scripts/e2e/README.md#claim-drops).

### How we used AI

Built with Claude Code (Anthropic): the design discussion, the code, the
tests and these docs were drafted with it and reviewed by the team.
TODO(team): add anything else, per ETHGlobal's rules.

### License

MIT — see [LICENSE](LICENSE).
