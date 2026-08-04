# subscription-quota-dashboard

Unified read-only dashboard for live subscription quotas.
Bun + Hono server, React + Vite frontend, SQLite storage, signed session-cookie auth.

## Requirements

- [Bun](https://bun.sh/) runtime for local development.
- Provider credentials for whichever live sources are enabled in
  `config/dashboard.config.ts`.

## Quick start

```bash
# 1. Install dependencies.
bun install

# 2. Copy the environment template and fill in real values.
cp .env.example .env
#   - POE_API_KEY             your Poe API key
#   - SELF_DASHBOARD_VIEW_KEY random 128-bit view key used to log in
#   - SESSION_SECRET          random 256-bit secret used to sign session cookies
#   - PORT                    HTTP port (default 3000)

# --- Development (with hot reload) ---
# The app runs as TWO processes in dev: the Hono API server and the Vite dev
# server (which serves the React UI with HMR and proxies /api + /health to the
# API). Run each in its own terminal:
bun run dev          # terminal 1 — Hono API on http://127.0.0.1:3000
bun run client:dev   # terminal 2 — Vite UI  on http://127.0.0.1:5173
#   -> open http://127.0.0.1:5173/d/self?range=24h

# --- Production ---
bun run build
NODE_ENV=production bun run start
#   -> open http://127.0.0.1:3000/d/self?range=24h
#   (the built server serves the compiled client from dist/client, so a single
#    process on :3000 handles both UI and API)
```

## Container deployment

The production image uses pinned `oven/bun:1.3.14-alpine` build and runtime
stages. It runs as the non-root `bun` user, listens on `0.0.0.0:3000`, serves
the compiled SPA and API from one process, writes JSON logs, and stores SQLite
state under `/app/data`. Credentials are supplied only at runtime; `.env` files
are excluded from the build context.

Create a deployment environment file from `.env.example`. At minimum, set:

```env
SELF_DASHBOARD_VIEW_KEY=replace-with-a-random-128-bit-value
SESSION_SECRET=replace-with-a-random-256-bit-value
PUBLIC_ORIGIN=https://dashboard.example.com
```

Add credentials for each enabled provider. Do not commit this file. When using
an env-file with a container runtime, keep values as literal `KEY=value` lines;
do not use shell `export` statements.

### Apple Container (validated)

Apple's official `container` runtime is the primary local deployment path and
has been verified on Apple Silicon with a native `linux/arm64` image:

```bash
container system start
container build --progress plain \
  -t subscription-quota-dashboard:latest .

container volume create subscription-quota-data
container run --name subscription-quota-dashboard --detach \
  --publish 127.0.0.1:3000:3000 \
  --env-file .env.container \
  --volume subscription-quota-data:/app/data \
  subscription-quota-dashboard:latest

curl --fail http://127.0.0.1:3000/health
container logs subscription-quota-dashboard
```

Expected health response:

```json
{"ok":true}
```

Stop and remove the deployment with:

```bash
container stop subscription-quota-dashboard
container delete subscription-quota-dashboard
```

### Docker or Lima fallback

The same Dockerfile remains OCI/Docker compatible:

```bash
docker build -t subscription-quota-dashboard:latest .
docker volume create subscription-quota-data
docker run --detach \
  --name subscription-quota-dashboard \
  --restart unless-stopped \
  --publish 127.0.0.1:3000:3000 \
  --env-file .env.container \
  --volume subscription-quota-data:/app/data \
  subscription-quota-dashboard:latest
```

If Apple Container is unavailable, start a Lima Docker VM and run the same
Docker commands inside it. The image contains a `/health` health check and
declares port `3000` plus the `/app/data` volume.

## Environment variables

| Variable                    | Purpose                                                                 |
| --------------------------- | ----------------------------------------------------------------------- |
| `POE_API_KEY`               | API key for the Poe provider (`config/dashboard.config.ts` references it via `apiKeyEnv`). |
| `SELF_DASHBOARD_VIEW_KEY`   | 128-bit random string used as the login view key for the `self` profile. |
| `SESSION_SECRET`            | 256-bit random secret used to sign session cookies. Required.            |
| `PORT`                      | Server port. Defaults to `3000`.                                         |
| `HOST`                      | Listen address. Defaults to `127.0.0.1`; image defaults to `0.0.0.0`.    |
| `PUBLIC_ORIGIN`             | Browser-facing HTTP(S) origin; required behind an HTTPS reverse proxy.   |
| `CONFIG_PATH`               | Dashboard config path; image defaults to `/app/config/dashboard.config.ts`. |
| `DASHBOARD_DB`              | SQLite path; image defaults to `/app/data/dashboard.db`.                 |
| `LOG_LEVEL`                 | `debug`, `info`, `warn`, `error`, or `silent`; defaults to `debug` in development and `info` in production. |
| `LOG_FORMAT`                | `pretty` for readable local logs or `json` for structured production ingestion. |

> **There is no `viewKey` in any URL.** Authentication is done via a signed
> session cookie issued after the one-time login flow. Never put `viewKey` or
> `apiKey` values in URLs or query strings.

See `.env.example` for the exact template.

## Configuration

Profiles, subscriptions, metrics, and providers are declared in:

```
config/dashboard.config.ts
```

The small header slogan above the profile name is optional and configurable:

```ts
const config: DashboardConfigInput = {
  branding: { slogan: "SQD / 配额运营" },
  // providers, subscriptions, profiles ...
}
```

Omit `branding.slogan` to use the built-in localized Chinese/English slogan.
The large profile title, such as `Personal`, remains controlled by
`profiles[].name`.

Provider API keys are referenced by environment-variable name (`apiKeyEnv`),
**not** by literal value. The only exception is the manual provider, which has
no secret. If you ever add a provider with a direct `apiKey` string (instead of
`apiKeyEnv`), treat that config file as personal-local and **never commit it**.

## Guides

- [Deployment guide](docs/deployment.md) — GHCR, Docker, Apple Container,
  reverse proxy, upgrades, rollback, backups, and troubleshooting.
- [Multi-profile guide](docs/multi-profile.md) — separate profile URLs,
  keys, subscription visibility, session behavior, and rotation.

GitHub Actions publishes multi-architecture images to
`ghcr.io/nerdneilsfield/subscription-quota-dashboard` on semantic-version tags
only, such as `v1.2.3`; ordinary `master` pushes do not publish images.

## Data storage

Metrics snapshots and refresh state are persisted to SQLite at:

```
data/dashboard.db
```

The `data/` directory and `.env` are gitignored. Delete `data/dashboard.db` to
reset all stored history (config-driven manual values are unaffected).

## Frontend routes

| Route                     | Behavior                                            |
| ------------------------- | --------------------------------------------------- |
| `/d/:profileId?range=X`   | Dashboard for the given profile.                    |
| anything else             | 404 Not Found.                                       |

`range` is one of `1h`, `24h`, `7d`, `30d` (defaults to `24h`). An invalid
`range` or `profileId` renders the 404 view. There is **no frontend
auto-polling** — data is fetched on mount, on manual refresh, and on a
visibility-change refetch when the tab becomes visible again.

## Authentication & sessions

- Each profile has its own **profile-scoped session cookie name** (derived from
  `profile.id`), so multiple profiles can be logged in from the same browser
  without collision.
- Session cookies are signed with `SESSION_SECRET` and carry `HttpOnly`,
  `SameSite`, and (in production) `Secure` attributes; expiry is 7 days.
- Auth accepts either the session cookie or a one-time login with the profile's
  `viewKey`. No `viewKey` is ever written into a URL.

## Security notes

The dashboard ships with baseline protections intended for personal / trusted
deployment:

- Signed, HttpOnly session cookies with profile-scoped names.
- `Cache-Control: no-store` on all data responses.
- `Referrer-Policy: no-referrer`.
- Origin checks + restricted dev-only CORS for the Vite dev server.
- Request-body and header log redaction (authorization / cookie / apikey /
  viewkey / password).
- Rate limiting on login and refresh endpoints (HTTP 429 when exceeded).

**This is not hardened for arbitrary public-internet exposure.** Before exposing
the dashboard publicly, put it behind a reverse proxy with HTTPS, strong
authentication at the proxy layer, and network-level rate limiting. The app
assumes a small number of trusted viewers.

## Favicon

No favicon is included in this MVP; browsers will get the default 404 for
`/favicon.ico`, which is harmless.

## Development commands

| Command                       | Purpose                                                |
| ----------------------------- | ------------------------------------------------------ |
| `bun install`             | Install dependencies.                                  |
| `bun run dev`             | Bun `--watch` server (Hono API + config reload).       |
| `bun run client:dev`      | Vite dev server with HMR (separate terminal).          |
| `bun run build`           | Build client (`vite build`) and server bundle.         |
| `bun run start`           | Run the built server (production).                     |
| `bun run typecheck`       | `tsc --noEmit`.                                        |
| `bun test`                | Run the full test suite.                               |

## Logging

The server emits structured lifecycle logs for HTTP requests, authentication,
profile refreshes, provider calls, CLIProxy account discovery/querying, cache
writes, and failures. Every HTTP request receives an `X-Request-Id`; the same ID
appears on all refresh logs caused by that request.

Development defaults to detailed readable output:

```env
LOG_LEVEL=debug
LOG_FORMAT=pretty
```

Production defaults to newline-delimited JSON at `info` level. Set
`LOG_LEVEL=debug` temporarily when diagnosing provider calls. Authorization,
cookies, API keys, tokens, passwords, view keys, and session secrets are
recursively replaced with `[REDACTED]`; response bodies and credentials are not
logged.

## OpenCode Go

OpenCode Go uses the authenticated SolidStart `lite.subscription.get` server
function because OpenCode does not currently expose a documented personal quota
API. Configure the workspace ID and the value of the `auth` cookie (the
`Fe26...` token only):

```env
OPENCODE_WORKSPACE_ID=wrk_...
OPENCODE_AUTH_COOKIE=Fe26...
```

The adapter extracts the real 5-hour, weekly, and monthly percentages and reset
times from the server-function stream without `eval`. It bypasses the workspace
page's unrelated `user.time_seen` database write, which can fail independently
with HTTP 500. It retries transient `429`/`5xx` failures and reports an explicit
authentication error when the session expires. Treat this cookie like a
password; keep it only in `.env` and replace it after logging out of OpenCode.

## Xiaomi MiMo Token Plan

MiMo Token Plan quota is read from the authenticated Subscription Management
API. Copy the `Cookie` request-header value from the browser request to
`/api/v1/tokenPlan/usage` into `.env`:

```env
MIMO_SESSION_COOKIE='api-platform_ph=...; api-platform_serviceToken=...; ...'
```

The adapter displays the real plan Credits usage, remaining progress, plan tier,
expiry/reset, automatic-renewal state, MiMo Claw entitlement, and compensation
Credits when present. Session cookies are redacted from logs and must never be
committed.
