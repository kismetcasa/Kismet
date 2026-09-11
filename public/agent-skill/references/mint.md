# Mint (create a new artwork)

Create a **new** artwork on Kismet on behalf of the user (the artist). This is the
one verb that is **not** a wallet payment: the user signs an EIP-712 `MintIntent`
(no funds, no gas — Kismet sponsors the on-chain mint) and Kismet executes it.

Two things make mint different from collect/buy/list:

- **It requires a Kismet Pass** (while the Pass gate is enabled — it is in
  production). Only eligible artists can mint. A `403` from prepare means the
  account is blocked or holds no Pass — relay that and stop. Minting into an
  **existing** collection can instead return a `403` whose body carries a `code`:
  `NO_ACCOUNT` (no creator account yet — mint once without a collection first) or
  `AUTHORIZE_REQUIRED` (the collection hasn't granted Kismet minter access);
  relay the message, don't retry. `503` = platform paused (don't retry until it
  clears); `429` = rate or daily limit reached.
- **Prepare uploads the media.** For collect/buy/list, prepare is a pure read.
  Here, prepare ingests the media you pass and hosts it (plus the metadata) on
  Arweave, then returns the intent to sign. So pass the media **to prepare**, not
  to the record step.

App defaults apply unless you override them: **free**, **ETH**, **open edition**,
and the artist keeps one copy. If the user gives no collection, Kismet
auto-creates one named after the artwork (exactly like the app's default mint).

## 1. Prepare

```
POST BASE/api/agent/prepare-mint
{
  "account": "0xYourBaseAccount",   // the artist; must hold a Kismet Pass
  "name": "My Artwork",             // required — the title
  "description": "…",               // optional
  "media": "data:image/png;base64,…",  // image (png/jpeg/gif/webp/avif), video (mp4/webm/quicktime) or 3D model (.glb): a data: URI (the bytes, ≤25 MB) or an ar://|ipfs:// URI
  "mediaType": "image",             // "image" | "video" | "model" | "text" (optional; inferred from the bytes — pass it for an ar://|ipfs:// URI)
  "price": "0",                     // human decimal string; "0" = free (default)
  "currency": "eth",                // "eth" | "usdc" (default eth)
  "editions": 100,                  // optional; omit for an open edition
  "collection": "0x…",              // optional; omit to auto-create a new collection
  "collectionName": "…",            // optional; name for the auto-created collection (default: the title). Signed.
  "payoutRecipient": "0x…",         // optional; receives sale proceeds (default: account; ignored with splits). Signed.
  "artistMint": true,               // optional; keep a copy for the artist (default true)
  "enableRaffle": false             // optional; opt the artwork into a Kismet raffle (default false)
}
```

For a **writing artwork**, omit `media` and pass the text instead:

```jsonc
{
  "account": "0x…", "name": "My Note", "text": "the full writing body…"
}
```

For a **video**, you may pass an optional `poster` (a `data:` or `ar://|ipfs://`
image) — Kismet can't extract a poster frame server-side the way the app does, so
feeds show a placeholder without one.

For a **3D model** (`.glb`, glTF 2.0 binary, up to 25 MB), `poster` is
**required**: a still of the model that feeds, share cards and embeds show
(Kismet cannot render a GLB server-side). `background` records the backdrop
the still was shot on so the artwork page's viewer matches it: `"white"`
(default), `"dark"`, or `"transparent"` (white thumbnail, transparent in-app
viewer). Render the poster on that same backdrop. The moment carries the video
metadata shape with the GLB as `animation_url` and `content.mime`
`model/gltf-binary`.

**Limits.** 20 prepares per minute per IP; 500 MB per day of hosted bytes per
account (a writing artwork debits a flat 16 KB); any `data:` media or poster is
capped at 25 MB (larger → the Kismet app); `name` is truncated to 200 and
`description` to 5000 characters, and `text` over 5000 characters is rejected;
`poster` is ignored for an image; `background` is only stored for a 3D model;
`mediaType: "text"` cannot be combined with `media`; and a platform-wide daily
mint capacity can answer `429` even under your own limits.

> **POST-only, and no remote URLs.** Unlike collect/buy/list, mint is not on the
> GET-paste rung: it spends (it hosts the media on Arweave), and a GET that
> spends is passively triggerable cross-site. And it never fetches a remote
> `https://` URL server-side — pass the media as a `data:` URI (fetch it with
> your own tools first if you only have a URL) or reference an already-permanent
> `ar://`/`ipfs://` asset.

The response is the standard envelope, containing:
- `typedData` — the EIP-712 `MintIntent` to sign (this is **not** a transaction).
- `record` — the follow-up call (`POST /api/mint` for media, `POST /api/write`
  for text) with a `<REPLACE_WITH_sign_signature>` placeholder.
- `summary` — e.g. `Mint “My Artwork” (image) — free, open edition, into new
  collection “My Artwork”, payout to you (0x71Dc…7244), 1 copy minted to you.`
  (an explicit `payoutRecipient` shows as name + short address; splits as
  `payout split N ways`; `raffle on` when enabled).

There are no `calls` and no `caps`: minting spends nothing from the wallet.

## 2. Execute

Show the user `summary`, then sign the intent (no send_calls):

```
sign(typedData)            // EIP-712 typed data — returns a signature
```

Wait for the user to approve in their Base Account and capture the **signature**.

## 3. Record

Put the signature into `record.bodyTemplate.intent.signature` and send it:

```
POST BASE/api/mint         (media artwork — record.bodyTemplate with signature filled)
POST BASE/api/write        (writing artwork)
```

Kismet re-verifies the signature against the exact body, re-runs the Pass gate
and quota, then submits the sponsored mint on-chain. A non-2xx response means it
rejected the mint (expired signature, missing Pass, or — for an **existing**
collection — that collection hasn't authorized Kismet yet) — relay the error.
The signature is single-use and expires in ~5 minutes, so sign and record
promptly.
