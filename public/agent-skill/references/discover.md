# Discover

Find things to act on. Every row includes a `nextAction` with the exact prepare
call to make next, so you can chain discover → prepare → execute.

## Listings to buy (default)

```
GET BASE/api/agent/discover?kind=listings&currency=eth&maxPrice=0.05&limit=10&account=0xYourBaseAccount
```

- `currency` (`eth` | `usdc`) and `maxPrice` (human decimal) filter the feed.
  `maxPrice` is only applied when `currency` is also set.
- `collection` (optional) restricts to one collection.
- `account` (optional) is echoed into each row's `nextAction.suggestedBody`.

Each row: `{ collection, tokenId, name, priceLabel, currency, listingId, seller,
momentUrl, nextAction }`. To buy a row, follow its `nextAction` (→
`references/buy.md`).

## Artworks to collect in a collection

```
GET BASE/api/agent/discover?kind=collect&collection=0x…&excludeCollectedBy=0xYourBaseAccount&limit=10&account=0xYourBaseAccount
```

- `collection` is **required** for `kind=collect`.
- `excludeCollectedBy` drops tokens that address already collected.

Rows don't carry a price (the live sale is resolved by `prepare-collect`). Follow
each row's `nextAction` to collect (→ `references/collect.md`).

## Ranking

This is the free tier (recency/availability). A richer **curated** tier
(taste-matching, cross-source ranking) is planned as an x402-paid upgrade; when
available it will require a small USDC payment per query with a `maxPayment` cap.
