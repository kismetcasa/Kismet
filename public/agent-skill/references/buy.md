# Buy (fulfill a listing)

Buy a moment from a secondary-market Seaport listing — **a single approval, no
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
GET BASE/api/agent/prepare-buy?listingId=the-id-from-discover&account=0x…
```

`calls` is:
- **ETH** → one `fulfillOrder` call with `value = price`.
- **USDC** → `[approve, fulfillOrder]` when allowance is short, else just
  `[fulfillOrder]`.

A `409` means the listing is no longer active (filled/cancelled/expired); a `400`
means you're the seller.

## 2. Execute

Show `summary` (e.g. *"Buy “Title” from 0x71Dc…7244 for 0.01 ETH"*). Then:

```
send_calls({ chain: "base", calls })
```

One approval. Wait for the confirmed **txHash**.

## 3. Record (no signature)

Fill the `txHash` placeholder in `record.bodyTemplate` and:

```
PATCH BASE/api/listings/{id}    ({ "status": "filled", "txHash": "0x…" })
```

That's it — no buyer signature. The backend re-decodes the Seaport
`OrderFulfilled` event from your txHash (matched to this listing's order) and
derives the buyer from it, so a bogus PATCH can't fake a sale. If the PATCH lags,
the purchase still happened on-chain; just report that recording lagged.
