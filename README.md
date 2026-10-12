# ShortLink API

A URL shortener with click analytics, built with **Node.js + Express + TypeScript**.

## Features

- `POST /api/links` creates a short link, with optional **custom codes**. Posting the same URL again returns the existing link.
- `GET /:code` redirects (302) and records the click with its referrer host
- `GET /api/links/:code/stats` returns total clicks, a **7-day chart series**, last click time, and **top referrers**
- `GET /api/links` lists recent links; `GET /api/health` for uptime checks

## Security and reliability

- **Open-redirect and SSRF guard:** only public `http(s)` URLs are accepted; credentials, `localhost`, `.local`, and private/link-local IPv4 ranges (including the `169.254.169.254` cloud metadata address) are rejected
- **Rate limiting:** sliding window, 20 creations per minute per IP, with a `Retry-After` header
- **Random codes** from Node's `crypto.randomInt` (62^7 combinations), with collision retry and reserved words blocked
- Request body limited to 10 KB; malformed JSON returns a clean 400
- **Atomic writes** (temp file + rename) so a crash can't corrupt saved data; a corrupt file is ignored instead of crashing the server

## Run it

```bash
npm install
npm run dev          # http://localhost:3000
npm test
```

```bash
curl -X POST localhost:3000/api/links -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/some/long/path","customCode":"docs"}'

curl -i localhost:3000/docs
curl localhost:3000/api/links/docs/stats
```

Environment variables: `PORT` (3000), `DATA_FILE` (`data/links.json`), `BASE_URL` (used to build `shortUrl`), `TRUST_PROXY=1` (set when behind a load balancer so rate limits use the real client IP).

## Design

The request logic lives in `src/router.ts` as a pure function `handle(ctx, deps)`, independent of Express. `src/server.ts` is a ~30-line adapter. That means the entire API surface (status codes, validation, rate limiting, redirects, analytics) is covered by 14 fast tests with no HTTP server. Time and randomness are injected, so tests are deterministic.

## Limitations and next steps

Storage is a JSON file, which suits a single instance. For multiple instances, swap `LinkStore` for PostgreSQL or Redis (the class is the only thing that touches storage) and move rate limiting to Redis. Other ideas: link expiry, API keys, QR codes, and bot filtering in click analytics.
