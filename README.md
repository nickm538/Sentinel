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
| `OPENROUTER_MODEL` | optional | Model slug for OpenRouter (see [openrouter.ai/models](https://openrouter.ai/models)). Defaults to `openai/gpt-5.2`. |
| `OPENROUTER_REFERER` | optional | Sent as the `HTTP-Referer` header on OpenRouter calls (used for attribution / rate-limit tier). Defaults to the GitHub repo URL. |
| `TRESTLE_KEY` | optional | [Trestle IQ](https://trestleiq.com) key — reverse-phone lookup (caller_id / phone_intel / cnam). Runs only when the click payload includes a `phone` field; otherwise skipped. |
| `APIFY_TOKEN` | optional | [Apify](https://apify.com) API token. Enables deep/dark-web enrichment via actor resurrect. |
| `APIFY_ACTOR_RUN_ID` | optional | Pre-existing Apify actor run to resurrect on each click. On every `/api/track` hit, Sentinel writes a fresh `INPUT` record (ip, phone, ua, hostnames, webrtcIps, ipinfo, trapId) to that run's default key-value store and POSTs `/resurrect`. Admin-gated endpoints mirror the Apify v2 API: `GET /api/apify-run/:runId`, `GET /api/apify-run/:runId/input`, `GET /api/apify-run/:runId/log`, `POST /api/apify-run/:runId/resurrect`. |
| `BROWSERLEAKS_ENABLED` | optional | Set to `true` to enable the agentic scrape at `GET /api/browserleaks/webrtc`. Requires `npm install playwright && npx playwright install --with-deps chromium`. Note this runs on the Sentinel server, so the IPs it reports are Sentinel's own (useful as a diagnostic / baseline, not for identifying scammers — scammer WebRTC leaks are already harvested client-side with the same STUN list browserleaks uses). |
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

**Reverse-phone and deep-web enrichment.** When `TRESTLE_KEY` is set and the
bait page forwards the scammer-supplied phone number into `/api/track` (as a
`phone` field on the POST body — typically sourced from a `?phone=` query
param on the trap URL), Sentinel calls Trestle's `caller_id`, `phone_intel`,
and `cnam` endpoints in parallel and attaches the results as `data.trestle`.
The same phone + IP + hostnames + WebRTC IPs + ipinfo summary are also pushed
as the `INPUT` record of a pre-configured Apify actor run (see
`APIFY_ACTOR_RUN_ID`), which is then resurrected to fan the signals out to
whatever deep/dark-web sources that actor covers. The Apify run is
fire-and-forget — the run handle lands on the click as `data.apify` and the
admin can fetch results later through the `/api/apify-run/...` proxy
endpoints. The AI profiler is explicitly instructed **not** to invent names
or addresses beyond what these sources actually return, and to hedge all
hypotheses with confidence words.

**WebRTC IP leaks** are harvested directly in the browser on every click via
`RTCPeerConnection` candidate gathering, using the same broad public STUN
list ([browserleaks.com/webrtc](https://browserleaks.com/webrtc) uses
`stun.l.google.com`, `stun.cloudflare.com`, `stun.nextcloud.com`,
`stun.sipgate.net`, etc.). This gives browserleaks-grade leak coverage on
the scammer's own browser, which is the only place it's meaningful —
running browserleaks from the server would only report the server's IPs.
Results appear as `data.research.webrtc` and are highlighted on the admin
portal when any candidate differs from the observed public IP.

If you still want to drive a real headless browser at browserleaks.com for
diagnostics (e.g. to see what the Sentinel host looks like from the outside,
or to sanity-check STUN), set `BROWSERLEAKS_ENABLED=true` and install
Playwright; then `GET /api/browserleaks/webrtc` (admin-gated) launches
headless Chromium, navigates to the page, lets its WebRTC stack gather, and
returns the scraped IP table as JSON.
