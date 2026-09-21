# Sirus installation statistics

This Worker accepts a small anonymous heartbeat and exposes rolling active-installation counts. It stores an HMAC-SHA-256 digest of the client-generated installation ID, never the ID itself.

The numbers are estimates. A public endpoint cannot prevent someone from submitting made-up random IDs, and no network endpoint can guarantee that connection metadata is invisible to its infrastructure provider.

## Deploy

From this directory:

```sh
# Create the D1 database and copy its id into wrangler.toml.
npx wrangler d1 create sirus-installations

# Replace YOUR_D1_DATABASE_ID in wrangler.toml, and set the dashboard origin
# in [vars] ALLOWED_ORIGIN when the GitHub Pages URL is known.
npx wrangler d1 execute sirus-installations --remote --file=schema.sql

# Use a long random value. It is not stored in D1.
openssl rand -hex 32 | npx wrangler secret put INSTALLATION_HASH_SECRET

npx wrangler deploy
```

The deployed Worker has:

- `POST /heartbeat` for `{ "installation_id": "<32 lowercase hex chars>", "version": "1.2.1" }`;
- `GET /stats` for `{ "day": 0, "week": 0, "month": 0 }`;
- `OPTIONS` responses for browser CORS preflight; and
- a daily scheduled cleanup that removes records older than 35 days.

Released Sirus builds use the deployed Worker URL by default. Set `SIRUS_HEARTBEAT_URL` to override it, or set it to an empty value to disable heartbeats:

```sh
export SIRUS_HEARTBEAT_URL=https://your-worker.your-subdomain.workers.dev/heartbeat
# Disable the optional heartbeat:
export SIRUS_HEARTBEAT_URL=
```

The client creates one random 128-bit ID in its local Sirus data directory, sends at most one heartbeat per 24 hours, and treats all network errors as non-fatal. It does not send hardware identifiers, account details, IP addresses, URLs, or user-agent data in the payload.

## Dashboard

`../stats-dashboard/index.html` is a dependency-free GitHub Pages dashboard. The repository workflow publishes that directory; set the repository's Pages source to **GitHub Actions** before the first deployment. Open it with the Worker stats URL in the `api` query parameter, for example:

```text
https://your-user.github.io/your-repo/?api=https%3A%2F%2Fyour-worker.your-subdomain.workers.dev
```

The page requests `/stats` from that base URL. It expects the Worker CORS origin to match the GitHub Pages origin, or `*` for a public read-only dashboard.

## Local development

```sh
npx wrangler dev
```

Use a local D1 database with the same schema before sending test requests. Do not put `INSTALLATION_HASH_SECRET` in a committed file; use `wrangler secret put` for deployed environments.

## Cloudflare plan note

This design is intended for a small, read-heavy workload on Cloudflare Workers and D1. Check the current Workers and D1 pricing/limits before launch, because free-tier quotas and enforcement can change. If usage grows beyond those quotas, the API should fail closed or be moved to a paid plan rather than silently changing the collection behavior.
