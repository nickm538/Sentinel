# Sentinel

Sentinel Trap v4 — generate a one-off bait link, send it to a suspected
scammer, and watch enriched click data stream into the admin portal in real
time (IP / ASN / abuse score / AI profile / optional geolocation).

## Run locally

```bash
npm install
cp .env.example .env   # fill in at least DATABASE_URL and ADMIN_PASS
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
| `ALLOWED_ORIGINS` | recommended | Comma-separated CORS / socket.io allow-list, e.g. `https://your-app.up.railway.app`. Only needed if the frontend is served from a different origin than the backend; if unset, cross-origin requests are rejected but same-origin still works. |
| `IPINFO_TOKEN` | optional | [ipinfo.io](https://ipinfo.io) token — country / ASN / org lookup. |
| `ABUSEIPDB_KEY` | optional | [AbuseIPDB](https://www.abuseipdb.com) key — abuse confidence score. |
| `OPENROUTER_KEY` | optional | [OpenRouter](https://openrouter.ai) key — AI scammer profile. |
| `OPENROUTER_MODEL` | optional | Model slug for OpenRouter (see [openrouter.ai/models](https://openrouter.ai/models)). Defaults to `openai/gpt-4o-mini`. |
| `OPENROUTER_REFERER` | optional | Sent as the `HTTP-Referer` header on OpenRouter calls (used for attribution / rate-limit tier). Defaults to the GitHub repo URL. |
| `PORT` | managed | Injected by Railway. Falls back to `3000` locally. |

Missing optional keys just skip that enrichment field — clicks are still
recorded and shown in the portal.

## Research mode

Research-mode signals (high-accuracy browser GPS with `watchPosition`
refinement, WebRTC candidate-IP harvesting which can leak the real IP behind a
VPN/proxy, plus device extras: hardware concurrency, device memory, network
type, battery, platform / vendor, plugins, permissions, storage estimate,
pixel ratio, color depth, etc.) are **always on** — there is no toggle. They
are bundled into the regular `/api/track` payload under `data.research` and
displayed inline in each click entry on the admin portal as well as in the raw
JSON. Reverse-DNS of the client IP is also performed server-side and surfaced
as `data.hostnames`. When `OPENROUTER_KEY` is set, all of these signals are
fed to the AI profiler, which is prompted to produce a hedged probabilistic
profile (approximate location, likely ISP/carrier, device class, VPN/proxy
likelihood from any WebRTC leak vs reported IP, behavioural one-liner).

**Caveat — what is *not* included.** Sentinel does **not** integrate any
third-party people-search / reverse-phone / data-broker API. There is no way
to derive a real name, street address, or phone number from an IP plus a
browser session alone, and wiring up a data broker for that purpose has
serious legal exposure (GDPR, CCPA, anti-doxxing laws) and is intentionally
out of scope. The AI profiler is explicitly instructed not to invent such
identifiers.
