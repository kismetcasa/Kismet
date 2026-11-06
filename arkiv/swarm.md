# Swarm in Kismet claim drops

**What existed before the event:** Kismet had no Swarm integration. All
media went to Arweave through ArDrive Turbo, paid by Kismet, for every mint.
Everything on this page was added at ETHGlobal Mumbai.

## What lives where

| | Where | Why |
|---|---|---|
| A drop's artwork while the drop is open and settling | **Swarm** | Rented storage for a known period, which matches a drop's life. |
| The drop, its terms and its claims | **Arkiv** | Public, queryable, owned by the artist and collectors, expiring with the drop. |
| The artwork after the drop is claimed | **Arweave** (existing mint flow) | Minted art has to be permanent, and is only paid for once someone claimed it. |

**The field that holds the Swarm reference:** `swarmRef` on every
`kismet.drop.v1` entity ([schema.md](schema.md)): an unencrypted 32-byte
reference, hex. Encrypted references (64 bytes) are refused on purpose,
because they embed their decryption key and Arkiv entities are public
(`isSwarmRef`, [`lib/drops.ts`](../lib/drops.ts)).

## One entity and the reference it points to

TODO(team): run `npm run drops:smoke -- --keep --image <art.png>` (or open a
drop in the app) and paste its output here:

- Arkiv entity: `0x…` — https://rabdi.explorer.arkiv.network/entity/0x…
- Swarm reference: `…` — https://api.gateway.ethswarm.org/bzz/…/

## Postage batch and node

- **Batch ID:** TODO(team): `SWARM_BATCH_ID`
- **Bought by:** TODO(team): Nook's node wallet address, funded by the
  Swarm/Arkiv gift code at Devcon 8 Mumbai. The gift wallet was
  `0xE6AFB42053C3644843d771a6A80050FA19F4FdB7` (address only).
- **Uploaded through:** TODO(team): Nook vX (Bee vX), local API
  `http://127.0.0.1:1633`.

## Files that upload to Swarm and read from it

| File | Does |
|---|---|
| [`lib/swarm.ts`](../lib/swarm.ts) | `uploadToSwarm` (Bee `POST /bzz`, direct + pinned), `fetchFromSwarm` (our node, then the public gateway), `getStampStatus` |
| [`app/api/drops/media/route.ts`](../app/api/drops/media/route.ts) | Upload endpoint: Pass-gated, type-sniffed, size and quota-capped |
| [`app/api/drops/[key]/media/route.ts`](../app/api/drops/[key]/media/route.ts) | Serves a drop's artwork from Swarm — keyed by the Arkiv drop, so only artwork behind a Kismet drop is ever served |
| [`components/DropForm.tsx`](../components/DropForm.tsx) | The artist's upload |
| [`components/DropView.tsx`](../components/DropView.tsx), [`components/DropsFeed.tsx`](../components/DropsFeed.tsx) | Where users see the artwork |
| [`scripts/drops-smoke.ts`](../scripts/drops-smoke.ts) | End-to-end: upload, read back, write the drop and a claim, query them |

We call the Bee HTTP API directly, checked against Bee's OpenAPI spec
(`openapi/Swarm.yaml`): two endpoints didn't justify adding bee-js. The read
path `/bzz/<ref>/` is the one bee-js and Swarm's docs use. We checked it live
against the public gateway on 2026-11-06: 200, no redirect.

## Run one upload and one read yourself

You need Node ≥ 22.11, a Bee node with a usable batch (Nook works), and a
Rabdi key funded at hub.arkiv.network/faucet.

```bash
npm ci
```

```bash
cat > .env.local <<'ENV'
SWARM_BEE_URL=http://127.0.0.1:1633
SWARM_BATCH_ID=<your batch id>
ARKIV_WRITER_PRIVATE_KEY=<0x… funded on Rabdi>
ARKIV_ACCESS_KEY=<optional>
ENV
```

```bash
npm run drops:smoke -- --image path/to/art.png
```

**What you should see:**

- Your batch's status.
- `uploaded N bytes → <reference>` and a gateway link that opens the image.
- `PASS the file reads back from Swarm byte-for-byte`.
- The drop and claim entity keys with explorer links.
- `drops-smoke: OK`.

Without `--keep`, the entities expire about 20 minutes later.

In the app: `DROPS_ENABLED=1 npm run dev`, open `/drops/new`, pick an
image. The upload goes to Swarm, the drop page streams it back from Swarm.

## Where Swarm is in the demo video

TODO(team): timestamp, e.g. "0:42 — the artist uploads the image (Swarm), the
drop page loads it back from Swarm".

## What got in our way

- **Browser uploads are blocked by default.** The bee-js README notes that
  "from Bee 2.8.3, a node rejects `POST` … requests from a browser page on
  another origin with `403 Forbidden`" unless the origin is in
  `cors-allowed-origins` (default `[]`). We upload server-side anyway, so the
  node's API and the batch are never exposed, but it is the first wall a web
  app hits.
- **Uploads are deferred by default.** Bee's OpenAPI spec:
  `swarm-deferred-upload` — "Default: deferred (true)". A deferred upload can
  sit on the uploading node, which matters when that node is a laptop. We send
  `false`, so the chunks are on the network when the upload returns.
- **A batch lives with its node.** "The `stamperstore` contains postage stamp
  data. If lost, previously purchased postage stamps will become unusable."
  To use the gift batch in production you'd have to move Nook's keys and
  stamperstore to the server, so production buys its own.
- **Sizing a batch.** You pay for the theoretical capacity (2^depth × 4 KB),
  but batches fill before reaching it. Swarm's effective-capacity table gives
  687.62 MB at depth 20 and 7.73 GB at depth 22 (unencrypted, no erasure
  coding). The price "is dynamically determined according to a network
  utilisation signal" (Swarmscan shows it live), so the cost of a month has
  to be read live.
