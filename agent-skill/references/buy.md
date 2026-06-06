# Buy (fulfill a listing)

Buy a moment from a secondary-market Seaport listing. Find listings with
`discover` (kind=listings) — each row gives you a `listingId`.

## 1. Prepare

```
POST BASE/api/agent/prepare-buy
{
  "listingId": "the-id-from-discover",
  "account": "0xYourBaseAccount"   // buyer; must not be the seller
}
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

## 3. Record (requires a signature first)

`record.preSign` is present because the backend requires a buyer signature to
flip the order-book listing to "filled" (so nobody else can mark it sold):

1. `GET BASE` + `record.preSign.noncePath` → `{ nonce }`.
2. Build the message from `record.preSign.messageTemplate`, replacing `<nonce>`.
   Sign it as a plain message:

   ```
   sign({ message })          // personal_sign
   ```

3. Fill `record.bodyTemplate` (`<nonce>`, `<signature>`, and the `txHash`
   placeholder) and:

   ```
   PATCH BASE/api/listings/{id}
   ```

   The backend re-decodes the Seaport `OrderFulfilled` event from your txHash, so
   a bogus PATCH can't fake a sale.
