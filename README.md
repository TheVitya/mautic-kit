# mautic-kit

Install and configure a self-hosted Mautic: the steps that need the container's console. Zero
dependencies, plain ESM, Node ≥ 20. It also carries the CUE schema brands write their declarations
against.

**Everything over Mautic's REST API moved to growth-kit** (`TheVitya/growth-kit`): `crm validate|plan|apply`
reconciles fields, categories, tags, stages, segments, forms, pages, emails, campaigns and webhooks
from the declarations JSON this schema exports, and `sends plan|apply` replaces the personal-send
scripts. mautic-kit **v0.4.2 is the last release with `provision`, `validate`, the email renderer and
the reusable `provision.yml` workflow**; a brand pinned to it keeps working until it moves.

Used by:
- `TheVitya/banklens` (Dinarko): install and configure; setup through growth-kit's `crm`
- `TheVitya/okos-automatizalas`: still on v0.3.x provisioning, moving to growth-kit

Targets **Mautic 7** (verified against `mautic/mautic:7.0.0-apache`).

## Steps

| Step | What | How |
|---|---|---|
| `install` | schema, admin user, `local.php` — **DESTRUCTIVE with `--force`**; refuses an instance that answers or can't be reached | console in the container |
| `configure` | `local.php` parameters with no REST API (API on, mailer DSN, site_url) — drift-checked | console in the container |

`--check` on `configure` reports drift and changes nothing (exit 1 on drift). After both, the
instance has an API: run `growth-kit crm apply`.

## Brand config

```js
// mautic.config.mjs
import { baseParameters } from 'mautic-kit';

/** @type {import('mautic-kit').BrandConfig} */
export default {
  envFile: '../../.env',                 // relative to this file
  composeFiles: ['docker-compose.yml'],  // or set MAUTIC_CONTAINER + MAUTIC_CRON_CONTAINER
  parameters: (env) => ({ ...baseParameters(env), mailer_dsn: env.MAUTIC_MAILER_DSN }),
};
```

Run it with `npx mautic-kit configure --config ./mautic.config.mjs [--check]`, or import `run()`.

## Authoring in CUE

`cue/schema` checks a brand's declarations at `cue vet` time: every cross-reference (email, segment,
form, stage and tag names in campaigns, event trees, category bundles, unique event ids and names),
with errors that name the campaign and event. A brand links it into its module and exports the JSON
growth-kit's `crm` reads as it is:

```sh
ln -sfn node_modules/mautic-kit/cue/schema cue/cue.mod/pkg/github.com/thevitya/mautic-kit/schema  # a DIRECTORY link
cue vet -c ./cue && cue export ./cue -e declarations > data/declarations.json
```

In JSON declarations `segments` is an array and `tags` filters name tags (growth-kit resolves them
to ids). A `list` (broadcast) email names its segments in `lists` (aliases); `cue vet` refuses one
without, as Mautic does.

## Environment

`MAUTIC_PROVISION_URL` (how *this machine* reaches Mautic; growth-kit calls it `MAUTIC_URL`) ·
`MAUTIC_API_USERNAME` / `MAUTIC_API_PASSWORD` (the API user install creates) · `MAUTIC_SITE_URL` (what Mautic writes into mail) · `MAUTIC_DB_*` (install) ·
`MAUTIC_CONTAINER` + `MAUTIC_CRON_CONTAINER` (both or neither) · `MAUTIC_EXEC=local` (inside the
image) · `MAUTIC_DOCKER=podman` · `MAUTIC_EXEC_USER` (default `www-data`; `33:33` where podman cannot resolve the name) · `MAUTIC_SSH=user@host` (run console steps on a server's containers
from a laptop; `MAUTIC_DOCKER` may then carry flags, e.g. `podman --url unix:///run/podman/podman.sock`).

## Known traps

- Mautic 7 has **no `mautic:emails:send`** console command; cron jobs calling it fail every run.

## Tests

`npm test`: the CUE schema tests (needs `cue` on PATH, skipped otherwise).
