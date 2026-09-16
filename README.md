# mautic-kit

Install, configure and provision Mautic from per-brand declarations. Zero dependencies, plain ESM,
Node ≥ 20. The engine is shared; **what** each brand's Mautic holds lives in that brand's repo.

Used by:
- `TheVitya/banklens` (Dinarko) — `tools/mautic/mautic.config.mjs`
- `TheVitya/okos-automatizalas` — planned (CUE → JSON declarations)

## Steps

| Step | What | How |
|---|---|---|
| `install` | schema, admin user, `local.php` — **DESTRUCTIVE with `--force`**; refuses an instance that answers or can't be reached | console in the container |
| `configure` | `local.php` parameters with no REST API (API on, mailer DSN, site_url) — drift-checked | console in the container |
| `provision` | fields, tag, segments, pages, emails (+ translations), campaigns, webhooks — reconciled by alias/name | REST, Basic auth |

`--check` on `configure`/`provision` reports drift and changes nothing (exit 1 on drift).

## Brand config

```js
// mautic.config.mjs
import { baseParameters } from 'mautic-kit';
import * as D from './declarations.mjs';

/** @type {import('mautic-kit').BrandConfig} */
export default {
  envFile: '../../.env',                 // relative to this file
  composeFiles: ['docker-compose.yml'],  // or set MAUTIC_CONTAINER + MAUTIC_CRON_CONTAINER
  declarations: { fields: D.FIELDS, segments: D.SEGMENTS, emails: D.EMAILS, /* … */ },
  parameters: (env) => ({ ...baseParameters(env), mailer_dsn: env.MAUTIC_MAILER_DSN }),
};
```

Run it with `npx mautic-kit provision --config ./mautic.config.mjs [--check]`, or import `run()`.

## Environment

`MAUTIC_PROVISION_URL` (how *this machine* reaches Mautic) · `MAUTIC_API_USERNAME` /
`MAUTIC_API_PASSWORD` · `MAUTIC_SITE_URL` (what Mautic writes into mail) · `MAUTIC_DB_*` (install) ·
`MAUTIC_CONTAINER` + `MAUTIC_CRON_CONTAINER` (both or neither) · `MAUTIC_EXEC=local` (inside the
image) · `MAUTIC_DOCKER=podman` · `MAUTIC_WEBHOOK_TOKEN`.

## Known traps (read before pointing at a live instance)

- **Campaigns are replaced with PUT** (PATCH appends events and duplicates sends). A PUT replaces
  the event list; verify against a copy of the database before provisioning a campaign that has
  contacts mid-flight.
- A field whose type changed is **deleted and recreated** — its values are lost; the brand's
  `resyncHint` says how to backfill.
- Targets **Mautic 5** today; Mautic 7 support is the next milestone.

## Tests

`npm test` — renderer tests and engine tests against an in-memory fake of Mautic's REST API.
