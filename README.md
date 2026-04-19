# Sentinel

## Environment variables

Set these on your host (e.g. Railway → service → **Variables**). Names are case-sensitive.

### Required

| Name | Purpose |
| --- | --- |
| `ADMIN_PASS` | Password for HTTP Basic auth on the admin portal and sensitive APIs (`/`, `/dashboard`, `/api/clicks`, `/api/live-events`, `/api/create-trap`). If unset, these routes fail closed with `503`. |
| `DATABASE_URL` | Postgres connection string. On Railway, add a Postgres plugin and it will be injected automatically. |
| `ALLOWED_ORIGINS` | Comma-separated list of origins allowed by CORS and Socket.IO, e.g. `https://sentinel.up.railway.app,https://example.com`. If unset, cross-origin requests are rejected. |

### Optional (enrichment integrations)

| Name | Purpose |
| --- | --- |
| `ABUSEIPDB_KEY` | AbuseIPDB API key for IP reputation enrichment. |
| `IPINFO_TOKEN` | IPinfo token for geolocation enrichment. |
| `OPENROUTER_KEY` | OpenRouter API key for AI summarization of click events. |
| `OPENROUTER_MODEL` | Overrides the default OpenRouter model (`openai/gpt-4o-mini`). |

### Auto-managed

| Name | Purpose |
| --- | --- |
| `PORT` | Injected by the host; the server listens on it automatically (defaults to `3000` locally). |

Secrets must never be committed to the repo — use the host's variable store. On boot, the server logs which required vars are missing and which optional integrations are enabled, without logging the values themselves.
---
