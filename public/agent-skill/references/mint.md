# Mint (create a new moment)

Create a **new** moment on Kismet on behalf of the user (the artist). This is the
one verb that is **not** a wallet payment: the user signs an EIP-712 `MintIntent`
(no funds, no gas — Kismet sponsors the on-chain mint) and Kismet executes it.

Two things make mint different from collect/buy/list:

- **It requires a Kismet Pass.** Only eligible artists can mint. A `403` from
  prepare means the wallet doesn't hold the required Pass — relay that and stop.
- **Prepare uploads the media.** For collect/buy/list, prepare is a pure read.
  Here, prepare ingests the media you pass and hosts it (plus the metadata) on
  Arweave, then returns the intent to sign. So pass the media **to prepare**, not
  to the record step.

App defaults apply unless you override them: **free**, **ETH**, **open edition**,
and the artist keeps one copy. If the user gives no collection, Kismet
auto-creates one named after the moment (exactly like the app's default mint).

## 1. Prepare

```
POST BASE/api/agent/prepare-mint
{
  "account": "0xYourBaseAccount",   // the artist; must hold a Kismet Pass
  "name": "My Moment",              // required — the title
  "description": "…",               // optional
  "media": "data:image/png;base64,…",  // image/video: a data: URI (the bytes) or an ar://|ipfs:// URI
  "mediaType": "image",             // "image" | "video" | "text" (optional; inferred from the media)
  "price": "0",                     // human decimal string; "0" = free (default)
  "currency": "eth",                // "eth" | "usdc" (default eth)
  "editions": 100,                  // optional; omit for an open edition
  "collection": "0x…",              // optional; omit to auto-create a new collection
  "artistMint": true                // optional; keep a copy for the artist (default true)
}
```

For a **writing moment**, omit `media` and pass the text instead:

```jsonc
{
  "account": "0x…", "name": "My Note", "text": "the full writing body…"
}
```

For a **video**, you may pass an optional `poster` (a `data:` or `ar://|ipfs://`
image) — Kismet can't extract a poster frame server-side the way the app does, so
feeds show a placeholder without one.

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
- `summary` — e.g. `Mint "My Moment" — free, open edition (new collection)`.

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
POST BASE/api/mint         (media moment — record.bodyTemplate with signature filled)
POST BASE/api/write        (writing moment)
```

Kismet re-verifies the signature against the exact body, re-runs the Pass gate
and quota, then submits the sponsored mint on-chain. A non-2xx response means it
rejected the mint (expired signature, missing Pass, or — for an **existing**
collection — that collection hasn't authorized Kismet yet) — relay the error.
The signature is single-use and expires in ~5 minutes, so sign and record
promptly.
