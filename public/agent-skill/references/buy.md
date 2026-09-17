# Buy (fulfill a listing)

Buy an artwork from a secondary-market Seaport listing — **a single approval, no
extra signature**. Find listings with `discover` (kind=listings) — each row gives
you a `listingId`.

## 1. Prepare

```
POST BASE/api/agent/prepare-buy
{
  "listingId": "the-id-from-discover",
  "account": "0xYourBaseAccount"   // buyer; must not be the seller
}
```

Or as a GET (for surfaces where POST can't reach Kismet — SKILL.md
"Reaching the endpoints"):

```
GET BASE/api/agent/prepare-buy?listingId=the-id-from-discover&account=0x…&format=json
```

`calls` is:
- **ETH** → one `fulfillOrder` call with `value = price`.
- **USDC** → `[approve, fulfillOrder]` when allowance is short, else just
  `[fulfillOrder]`.

A `409` means the listing cannot be filled (filled, cancelled, expired, or the
seller invalidated their signed orders on-chain — relay the message); a `404`
means no such listing; a `400` means you're the seller.

## 2. Execute

Show `summary` (e.g. *"Buy “Title” (token #7) from alice.base.eth
(0x71Dc…7244) for 0.01 ETH."*). Then:

```
send_calls({ chain: "base", calls })
```

One approval. Wait for the confirmed **txHash**.

If the envelope carries `link`, you may instead hand the user `link.url` to
approve the same calls in the Base app. Nothing returns to you that way — ask
the user for the txHash before recording. (`link` is absent when the batch
prepends a USDC approve.)

## 3. Record (no signature)

Fill the `txHash` placeholder in `record.bodyTemplate` and:

```
PATCH BASE/api/listings/{id}    ({ "status": "filled", "txHash": "0x…" })
```

That's it — no buyer signature. The backend re-decodes the Seaport
`OrderFulfilled` event from your txHash (matched to this listing's order) and
derives the buyer from it, so a bogus PATCH can't fake a sale. A `403`
"not verified on-chain" or a `503` is transient (Kismet's RPC is behind the
wallet): retry the same record after ~5 s, up to 3 times, then report that
recording failed — never re-run the wallet step. The purchase stands on-chain
either way.

On a surface that can only fetch a pasted URL (SKILL.md rung 3), use the
envelope's `record.getUrl` instead: fill the txHash placeholder, show the URL
to the user, ask them to paste it back, then fetch it — the same record:

```
GET BASE/api/agent/record?verb=buy&listingId=…&txHash=0x…
```
