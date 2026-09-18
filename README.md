# Cloudflare Worker Demo

This is a basic setup for deploying a Cloudflare Worker using Wrangler.

## Local Development

```sh
npm install
npm run start
```

## IMDb Cookie Worker

A Cloudflare Worker that launches a headless browser using Cloudflare Browser Rendering, visits IMDb (`https://www.imdb.com/`), waits for challenge and consent resolution, extracts all cookies, and saves them into Cloudflare Workers KV.

### KV Setup
1. Create a KV namespace:
   ```sh
   npx wrangler kv:namespace create IMDB_COOKIE_KV
   npx wrangler kv:namespace create IMDB_COOKIE_KV --preview
   ```
2. Update `wrangler.imdb-worker.toml` with the returned `id` and `preview_id`.

### Running Locally
Browser rendering runs on Cloudflare infrastructure, so use `--remote`:
```sh
npm run start:imdb
```

### Deployment
```sh
npm run deploy:imdb
```

### API Endpoints & Caching
- `GET https://meta.1proxy.workers.dev/?url=https://www.imdb.com/title/tt2243973`: Fetches target IMDb movie/show metadata formatted as clean REST API JSON.
  - **1-Week KV Cache** (`expirationTtl: 7 days`).
  - **Stale-While-Revalidate**: If cache is older than 24 hours (1 day), returns old cache immediately and revalidates in the background (`ctx.waitUntil`).
  - Returns `X-Cache: HIT` / `X-Cache: STALE-REVALIDATING` / `X-Cache: MISS`.
- `GET https://meta.1proxy.workers.dev/?url=tt2243973&format=raw_json`: Returns raw Next.js `__NEXT_DATA__` JSON.
- `GET https://meta.1proxy.workers.dev/?url=tt2243973&format=html`: Returns raw HTML.
- `GET https://meta.1proxy.workers.dev/`: Returns empty response (200 OK).
- `GET https://meta.1proxy.workers.dev/cookies`: Retrieves cached cookies from Workers KV.
- `GET https://meta.1proxy.workers.dev/headers`: Retrieves cached request headers & user agent.
- `POST /refresh` or `GET /refresh`: Runs headless browser, scrapes fresh cookies from IMDb, and updates KV.
- `GET https://meta.1proxy.workers.dev/health`: Health check and binding status.
### Automated 30-Minute Cookie Refresh
The worker has a Cloudflare Cron Trigger configured:
```toml
[triggers]
crons = ["*/30 * * * *"]
```
Every 30 minutes, Cloudflare automatically executes the `scheduled()` worker handler in the background, launching the browser and updating fresh IMDb cookies into Workers KV. In addition, any request arriving when cookies are >30 minutes old automatically triggers an asynchronous background revalidation.
