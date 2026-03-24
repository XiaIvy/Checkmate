# Shopify checkout rates from ShipStation v2

This script exposes a Shopify `CarrierService` callback endpoint that:

1. Receives checkout shipping destination/package data.
2. Calls ShipStation v2 `POST /rates` for live quotes.
3. Returns only these delivery methods (if available): USPS Ground Advantage, USPS Priority Mail, UPS Ground, UPS 2nd Day Air, UPS Next Day Air.
4. De-duplicates by service and keeps the lowest-priced duplicate for UPS services (for multi-account UPS setups).
5. For USPS Priority Mail variants, prefers the `Package` variant over envelope/box variants, then picks the lower price within that preferred group.
6. Does not send delivery date fields to Shopify (no estimated days line).
7. Supports per-method descriptions via env vars (with default `discreption here`).
8. Uses strict UPS matching so `UPS Next Day Air` maps from `UPS Next Day Air` only (not Early/Saver variants).
9. Handles concurrent checkout calls safely with request-keyed cache + in-flight request deduplication.
10. Applies a flat `+10%` rate inflation to all five supported services.
11. Retries ShipStation once when an API call succeeds but returns zero rates.
12. If any cart item includes the `TECH-SUIT` tag, USPS methods are removed and only UPS methods are returned.
13. `TECH-SUIT` detection checks Shopify product-level tags via Admin GraphQL (batched + cached + per-product in-flight deduped + timeout-limited) so overlapping checkouts stay safe and checkout stays fast.
14. Rounds calculated package weight up to the next whole ounce before requesting rates from ShipStation.

## Files

- `shipstation-shopify-rates-server.js`

## Required environment variables

```bash
# ShipStation
SHIPSTATION_API_KEY=...
SHIPSTATION_API_BASE_URL=https://api.shipstation.com/v2
SHIPSTATION_CARRIER_IDS=se-12345,se-67890
SHIPSTATION_RATE_LIMIT_BACKOFF_MS=5000

# Ship-from address (used in ShipStation rate request)
SHIP_FROM_ADDRESS1=123 Warehouse St
SHIP_FROM_CITY=Austin
SHIP_FROM_STATE=TX
SHIP_FROM_POSTAL_CODE=78701
SHIP_FROM_COUNTRY_CODE=US

# Optional
PORT=3000
SERVER_REQUEST_TIMEOUT_MS=15000
SERVER_HEADERS_TIMEOUT_MS=16000
SERVER_KEEP_ALIVE_TIMEOUT_MS=5000
SHUTDOWN_GRACE_PERIOD_MS=10000
SHIPSTATION_TIMEOUT_MS=10000
DEFAULT_PACKAGE_WEIGHT_OZ=4
DEFAULT_CONTACT_PHONE=5555555555
DEFAULT_RATE_DESCRIPTION=discreption here
DESC_USPS_GROUND_ADVANTAGE=Fast + affordable
DESC_USPS_PRIORITY_MAIL=Priority shipping
DESC_UPS_GROUND=Reliable ground
DESC_UPS_2_DAY=2 business days
DESC_UPS_NEXT_DAY=Next business day
RATE_CACHE_TTL_MS=180000
RATE_CACHE_STALE_TTL_MS=3600000
RATE_CACHE_MAX_ENTRIES=1000
RETURN_EMPTY_RATES_ON_ERROR=true
EMPTY_RATES_RETRY_ATTEMPTS=1
EMPTY_RATES_RETRY_DELAY_MS=200
TECH_SUIT_TAG=TECH-SUIT
SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
SHOPIFY_ADMIN_API_TOKEN=replace-with-admin-token
SHOPIFY_CLIENT_ID=...                  # alias: SHOPIFY_API_KEY
SHOPIFY_CLIENT_SECRET=...              # alias: SHOPIFY_API_SECRET
SHOPIFY_ADMIN_API_VERSION=2025-10      # alias: SHOPIFY_API_VERSION
SHOPIFY_PRODUCT_TAG_TIMEOUT_MS=1200
SHOPIFY_PRODUCT_TAG_CACHE_TTL_MS=900000
SHOPIFY_PRODUCT_TAG_BATCH_SIZE=100
PRODUCT_TAG_CACHE_MAX_ENTRIES=5000
SHOPIFY_TOKEN_TIMEOUT_MS=2000
SHOPIFY_TOKEN_EXPIRY_SKEW_MS=60000
MAX_REQUEST_BODY_BYTES=262144
SHIPSTATION_PACKAGE_CODE=package
SHIP_FROM_NAME=Warehouse
SHIP_FROM_COMPANY=My Company
SHIP_FROM_PHONE=+15125551212
SHIP_FROM_ADDRESS2=Suite 10
SHIP_FROM_RESIDENTIAL=no
```

## Run

```bash
npm start
```

## Deploy

This service is deployment-friendly as a single Node process or container.

- Set the same env vars in your cloud host that you use locally, except use your permanent deployed domain for the Shopify carrier-service callback URL instead of `ngrok`.
- Keep `SHOPIFY_STORE_DOMAIN` pointed at the Shopify store domain (for example `your-store.myshopify.com`), not your app domain.
- Point Shopify CarrierService to `https://<your-production-domain>/shopify/carrier/rates`.
- Use `GET /health` for container or load-balancer health checks.
- Run at least two instances in production if your host supports it.

### Docker

```bash
docker build -t shipstation-shopify-rates .
docker run --env-file .env -p 3000:3000 shipstation-shopify-rates
```

## Safe GitHub publishing

Before pushing this project to GitHub:

1. Keep your real credentials only in `.env`, and commit only `.env.example`.
2. Make sure `.env` is listed in `.gitignore` and never copied into screenshots, README examples, or deployment manifests.
3. If any of the current local credentials were ever shared, rotate them before publishing the repo.
4. Put production secrets only in your hosting provider's secret manager or environment-variable settings.
5. If you create the repo after developing locally, run `git status --ignored` once to confirm `.env` is being ignored before your first commit.

## Shopify setup

Create/update a CarrierService in Shopify Admin API and point it to:

`https://<your-domain>/shopify/carrier/rates`

Shopify will POST cart + destination data to this endpoint at checkout.

## Notes

- By default, ShipStation errors return cached rates (if available) or empty rates to avoid checkout hard-fail. Set `RETURN_EMPTY_RATES_ON_ERROR=false` if you want `502` behavior.
- Normal repeat requests can return fresh cached rates immediately, and concurrent duplicate requests share the same in-flight upstream lookup.
- Fresh rate cache entries live for `RATE_CACHE_TTL_MS`. Successful entries can also be reused as stale fallback for up to `RATE_CACHE_STALE_TTL_MS` when ShipStation times out, errors, or returns zero matching rates.
- ShipStation `429` responses trigger a short local cooldown so the service does not amplify rate limiting by immediately fanning out into extra per-carrier retries.
- The server rejects oversized request bodies and includes graceful shutdown plus explicit server timeouts for safer cloud rollouts.
- `total_price` is returned in subunits (cents), per Shopify requirement.
- Product-tag lookup auth supports either a static Admin token (`SHOPIFY_ADMIN_API_TOKEN`) or OAuth client credentials (`SHOPIFY_CLIENT_ID`/`SHOPIFY_CLIENT_SECRET` aliases: `SHOPIFY_API_KEY`/`SHOPIFY_API_SECRET`).
