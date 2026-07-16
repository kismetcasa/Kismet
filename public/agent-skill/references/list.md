# List (offer a moment for sale)

List a moment the user **already holds** for a fixed price (ETH or USDC) via a
Seaport order. No funds move — listing is a signature plus a one-time
marketplace approval.

## 1. Prepare

```
POST BASE/api/agent/prepare-list
{
  "collection": "0x…",        // or pass "url"
  "tokenId": "42",            // or pass "url"
  "account": "0xYourBaseAccount", // seller; must hold the token
  "price": "0.01",            // human decimal string
  "currency": "eth"           // "eth" | "usdc"
}
```

Or as a GET (for surfaces where POST can't reach Kismet — SKILL.md
"Reaching the endpoints"):

```
GET BASE/api/agent/prepare-list?collection=0x…&tokenId=42&account=0x…&price=0.01&currency=eth
```

A `403` means the wallet doesn't hold that token. The response contains:
- `calls` — **only present the first time** you list on this collection: a
  one-time `setApprovalForAll(Seaport, true)`.
- `typedData` — the EIP-712 Seaport order to sign.
- `record` — the `POST /api/listings` body (with a `<signature>` placeholder).

The order fixes a 30-day expiry and pays the collection's EIP-2981 royalty.

## 2. Execute

1. If `calls` is present, run the one-time approval and wait for it:

   ```
   send_calls({ chain: "base", calls })
   ```

2. Sign the order:

   ```
   sign(typedData)            // EIP-712 typed data
   ```

## 3. Record

Put the signature into `record.bodyTemplate.signature` and:

```
POST BASE/api/listings      (record.bodyTemplate with signature filled)
```

`/api/listings` re-validates the order shape, the signature (works with the Base
Account smart wallet), and the full royalty before publishing the listing. A
non-2xx response means it rejected the order — relay the error.
