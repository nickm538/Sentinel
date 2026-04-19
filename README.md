# Sentinel

Sentinel Trap v4 — generate a one-off bait link, send it to a suspected
scammer, and watch enriched click data stream into the admin portal in real
time (IP / ASN / abuse score / AI profile / optional geolocation).

## Run locally

```bash
npm install
cp .env.example .env   # fill in at least DATABASE_URL, ADMIN_PASS, ALLOWED_ORIGINS
npm start              # -> http://localhost:3000
```

The admin portal lives at `/` and `/dashboard` (HTTP Basic auth — any
username, password = `ADMIN_PASS`). The public bait URL is
`/check-scammer/:id` and is returned by `POST /api/create-trap`.

## Deploy to Railway

1. Create a new Railway project from this repo.
2. Add the **Postgres** plugin. `DATABASE_URL` is exposed automatically; in
   the app service's Variables, reference it as `${{ Postgres.DATABASE_URL }}`.
3. In the app service's **Variables** tab, set the names below. See
   [`.env.example`](./.env.example) for a copy-pasteable template.

### Environment variables

| Name | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | ✅ | Postgres connection string. On Railway, use `${{ Postgres.DATABASE_URL }}`. |
| `ADMIN_PASS` | ✅ | Password for the admin portal (Basic auth). Server fails closed (503) if unset. |
| `ALLOWED_ORIGINS` | ✅ | Comma-separated CORS / socket.io allow-list, e.g. `https://your-app.up.railway.app`. |
| `IPINFO_TOKEN` | optional | [ipinfo.io](https://ipinfo.io) token — country / ASN / org lookup. |
| `ABUSEIPDB_KEY` | optional | [AbuseIPDB](https://www.abuseipdb.com) key — abuse confidence score. |
| `OPENROUTER_KEY` | optional | [OpenRouter](https://openrouter.ai) key — AI scammer profile. |
| `OPENROUTER_MODEL` | optional | Model slug for OpenRouter. Defaults to `openai/gpt-5-2025-08-07`. |
| `PORT` | managed | Injected by Railway. Falls back to `3000` locally. |

Missing optional keys just skip that enrichment field — clicks are still
recorded and shown in the portal.
