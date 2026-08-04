# Multi-profile Guide

Profiles provide separate dashboard views and separate login keys within one
server. The server can share provider accounts and subscriptions, while each
profile chooses which subscriptions it exposes.

## 1. Configuration model

The relationships are:

```text
provider account -> subscription -> profile
```

- `providers`: upstream credentials or manual sources;
- `subscriptions`: named quota definitions bound to one provider;
- `profiles`: URL ID, display name, view key, and visible subscriptions.

The large dashboard title is `profiles[].name`. The small global header slogan
is `branding.slogan`.

## 2. Define separate profiles

Start from `config/dashboard.config.ts` and add one profile per audience:

```ts
import type { DashboardConfigInput } from "../src/shared/domain"

const config: DashboardConfigInput = {
  branding: { slogan: "SQD / 配额运营" },

  providers: [
    // Existing provider declarations.
  ],

  subscriptions: [
    // Existing subscription declarations.
  ],

  profiles: [
    {
      id: "personal",
      name: "Personal",
      viewKey: process.env.PERSONAL_DASHBOARD_VIEW_KEY,
      subscriptionIds: ["poe-api", "mimo-token-plan"],
      dynamicProviderIds: ["cliproxy-main"],
    },
    {
      id: "team",
      name: "Team",
      viewKey: process.env.TEAM_DASHBOARD_VIEW_KEY,
      subscriptionIds: ["poe-api", "doubao-coding-plan"],
    },
  ],
}

export default config
```

Profile IDs should be URL-safe, lowercase, and stable. They become the route
segment and must not contain secrets.

## 3. Add profile-specific keys

Use different environment variables and different random values:

```env
PERSONAL_DASHBOARD_VIEW_KEY=replace-with-a-random-personal-key
TEAM_DASHBOARD_VIEW_KEY=replace-with-a-random-team-key
SESSION_SECRET=replace-with-a-random-256-bit-secret
```

Do not put view keys in URLs, config literals, Git history, screenshots, or
chat messages. The config should reference `process.env`, not the actual key.

Each profile gets a separate session cookie derived from its ID, so one browser
can hold sessions for multiple profiles without cookie-name collisions. The
shared `SESSION_SECRET` signs every profile cookie.

## 4. Profile URLs

After deployment, open each profile directly:

```text
https://quota.example.com/d/personal?range=24h
https://quota.example.com/d/team?range=24h
```

The supported ranges are `1h`, `24h`, `7d`, and `30d`. The default is `24h`.
The first visit asks for that profile's view key. A profile session lasts seven
days and is HttpOnly.

## 5. Sharing versus isolating data

Subscriptions are reusable. Listing the same subscription ID in two profiles
shows the same projected source in both views. To isolate data:

1. declare separate provider account IDs when credentials differ;
2. declare separate subscription IDs bound to those providers;
3. include only the intended subscription IDs in each profile.

Provider credentials are server-side. A profile never receives raw API keys or
cookies; it receives only the UI-ready dashboard payload for its selected
subscriptions.

Dynamic CLIProxy accounts are opt-in per profile through
`dynamicProviderIds`. Only CLIProxy providers support dynamic discovery.

## 6. Key rotation

To rotate one profile's access:

1. generate a new value for that profile's env variable;
2. restart the server/container;
3. verify the profile URL with the new key;
4. revoke the old value from deployment secrets.

Changing a profile's `viewKey` invalidates that profile's existing sessions.
Changing `SESSION_SECRET` invalidates sessions for every profile.

## 7. Validation and deployment workflow

Config is loaded once at server startup. After changing profiles, restart the
container and check:

```bash
curl --fail http://127.0.0.1:3000/health
docker logs --tail 100 subscription-quota-dashboard
```

The loader rejects duplicate profile IDs, missing view keys, unknown
subscription references, duplicate dynamic provider IDs, and dynamic provider
IDs that do not reference CLIProxy providers.

For a container deployment, mount the reviewed config read-only at
`/app/config/dashboard.config.ts` or build a new image. Never mount the env
file into a public web path.

## 8. Security checklist

- Use a unique, high-entropy key per profile.
- Keep `SESSION_SECRET` stable and private.
- Keep `.env.production` mode `0600`.
- Expose only HTTPS through a reverse proxy.
- Set `PUBLIC_ORIGIN` to the exact browser-facing origin.
- Do not put `viewKey` in query parameters; the server rejects it there.
- Treat provider cookies and API keys as passwords.
