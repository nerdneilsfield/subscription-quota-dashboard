# Deployment Guide

[English](deployment.md) | [简体中文](deployment.zh-CN.md)

This guide deploys the image published by GitHub Actions to:

```text
ghcr.io/nerdneilsfield/subscription-quota-dashboard
```

The image is multi-architecture (`linux/amd64` and `linux/arm64`). The image
contains the compiled React client and Bun/Hono server; provider credentials
and SQLite data are supplied at runtime.

## 1. Prepare runtime secrets

Create a deployment-only env file. Do not commit it:

```bash
cp .env.example .env.production
chmod 600 .env.production
```

Set at least:

```env
SELF_DASHBOARD_VIEW_KEY=replace-with-a-random-128-bit-value
SESSION_SECRET=replace-with-a-random-256-bit-value
PUBLIC_ORIGIN=https://quota.example.com
```

Generate secrets with:

```bash
openssl rand -hex 16   # view key material
openssl rand -hex 32   # session secret material
```

Add only the provider credentials referenced by your
`config/dashboard.config.ts`. Keep provider secrets in environment variables,
not in the config file.

`SESSION_SECRET` must remain stable across restarts. Changing it invalidates
all existing profile sessions.

## 2. Pull and run the GHCR image

Create a release tag to publish an image:

```bash
git tag v1.2.3
git push origin v1.2.3
```

Automatic publishing intentionally runs only for `v*.*.*` tags. Ordinary
`master` pushes do not publish images; manual workflow dispatch remains
available when an explicit build is needed.

Public packages can be pulled without login. For a private package, create a
GitHub token with `read:packages` and log in:

```bash
printf '%s' "$GHCR_READ_TOKEN" \
  | docker login ghcr.io -u nerdneilsfield --password-stdin
```

Run a released image (pin the version in production):

```bash
export IMAGE=ghcr.io/nerdneilsfield/subscription-quota-dashboard:v1.2.3

docker pull "$IMAGE"
docker volume create subscription-quota-data
docker run --detach \
  --name subscription-quota-dashboard \
  --restart unless-stopped \
  --publish 127.0.0.1:3000:3000 \
  --env-file "$PWD/.env.production" \
  --volume subscription-quota-data:/app/data \
  "$IMAGE"
```

Check health and logs:

```bash
curl --fail http://127.0.0.1:3000/health
docker logs --follow subscription-quota-dashboard
```

Expected health response:

```json
{"ok":true}
```

Do not publish port `3000` directly to the public network. Put an HTTPS
reverse proxy in front of the loopback binding.

## 3. Reverse proxy requirements

Configure the public URL in `.env.production`:

```env
PUBLIC_ORIGIN=https://quota.example.com
```

The proxy must:

- terminate TLS;
- forward requests to `127.0.0.1:3000`;
- preserve the `Host` header;
- allow `/`, `/api/*`, and `/health`;
- pass browser cookies through unchanged.

`PUBLIC_ORIGIN` is used by production Origin checks. If it does not exactly
match the browser-facing origin, login and refresh requests are rejected.

## 4. Use a custom config file

The image default is `/app/config/dashboard.config.ts`. To change profiles or
subscriptions without rebuilding the image, mount a reviewed config file:

```bash
docker run --detach \
  --name subscription-quota-dashboard \
  --restart unless-stopped \
  --publish 127.0.0.1:3000:3000 \
  --env-file "$PWD/.env.production" \
  --volume subscription-quota-data:/app/data \
  --volume "$PWD/config/dashboard.config.ts:/app/config/dashboard.config.ts:ro" \
  ghcr.io/nerdneilsfield/subscription-quota-dashboard:latest
```

The server loads config once at startup. After editing a mounted config file,
restart the container. After editing an env file, recreate the container:

```bash
docker stop subscription-quota-dashboard
docker rm subscription-quota-dashboard
# Re-run the docker run command above.
```

`docker restart` does not reload environment variables from the original
`--env-file`; those values are fixed when the container is created.

See [multi-profile.md](./multi-profile.md) for profile configuration.

## 5. Upgrade and rollback

The workflow runs only for version tags such as `v1.2.3`. Each release updates
`latest`, the original `v1.2.3` tag, normalized semantic-version tags, and a
commit SHA tag. No `master` push publishes an image; manual dispatch is still
available.

Upgrade while keeping SQLite data:

```bash
docker pull ghcr.io/nerdneilsfield/subscription-quota-dashboard:latest
docker stop subscription-quota-dashboard
docker rm subscription-quota-dashboard
# Re-run the docker run command from section 2.
```

For reproducible deployment, pin a commit image instead of `latest`:

```text
ghcr.io/nerdneilsfield/subscription-quota-dashboard:sha-<commit>
```

The named volume `subscription-quota-data` must be reused during upgrades.
Removing it deletes quota history and refresh state.

## 6. Backup SQLite data

Stop the container before copying the database:

```bash
docker stop subscription-quota-dashboard
docker run --rm \
  --volume subscription-quota-data:/data:ro \
  --volume "$PWD/backups:/backup" \
  alpine:3.22 \
  tar -czf /backup/dashboard-$(date +%Y%m%d-%H%M%S).tar.gz -C /data dashboard.db
docker start subscription-quota-dashboard
```

Keep backups protected like the deployment secrets. The database contains
quota history and operational metadata.

## 7. Apple Container local validation

The repository's validated Apple Container path builds locally from the same
Dockerfile:

```bash
container system start
container build --progress plain \
  -t subscription-quota-dashboard:latest .
container volume create subscription-quota-data
container run --name subscription-quota-dashboard --detach \
  --publish 127.0.0.1:3000:3000 \
  --env-file .env.production \
  --volume subscription-quota-data:/app/data \
  subscription-quota-dashboard:latest
curl --fail http://127.0.0.1:3000/health
```

Use the Docker/OCI flow above for GHCR pulls unless your installed Apple
Container version supports the required registry login and pull commands.

## 8. Troubleshooting checklist

- `401` on login: check the profile view key and `PUBLIC_ORIGIN`.
- `403` on login or refresh: browser origin does not match `PUBLIC_ORIGIN`.
- `SQLiteError: unable to open database file`: use the named `/app/data`
  volume and the supplied entrypoint; it fixes mounted-volume ownership.
- Provider unavailable: inspect `docker logs` and verify the matching env var.
- Config validation failure: check duplicate IDs and referenced provider or
  subscription IDs.
