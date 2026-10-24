# mautic-kit

Install, configure and provision Mautic from per-brand declarations. Zero dependencies, plain ESM,
Node ≥ 20. The engine is shared; **what** each brand's Mautic holds lives in that brand's repo.

Used by:
- `TheVitya/banklens` (Dinarko) — `tools/mautic/declarations.mjs` + `mautic.config.mjs`
- `TheVitya/okos-automatizalas` — CUE (`mautic/cue`) → `data/declarations.json` + `mautic/mautic.config.mjs`

Targets **Mautic 7** (verified against `mautic/mautic:7.0.0-apache`: install, configure, provision,
idempotent re-provision, a real send).

## Steps

| Step | What | How |
|---|---|---|
| `install` | schema, admin user, `local.php` — **DESTRUCTIVE with `--force`**; refuses an instance that answers or can't be reached | console in the container |
| `configure` | `local.php` parameters with no REST API (API on, mailer DSN, site_url) — drift-checked | console in the container |
| `provision` | fields, categories, tags, stages, segments, forms, assets (lookup), pages, emails (+ translations), campaigns, webhooks — reconciled by alias/name | REST, Basic auth |
| `validate` | offline: every `{global|asset|form|page:…}` token resolves | no Mautic |

`--check` on `configure`/`provision` reports drift and changes nothing (exit 1 on drift).
`provision --no-recreate` fails instead of deleting and recreating a field whose type changed (that
empties it); CI applies with it, so a recreate is always a deliberate local run.

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

## Authoring in CUE

`cue/schema` is the CUE twin of `src/types.d.mts`: `schema.#Declarations` checks every
cross-reference at `cue vet` time (email/segment/form/stage/tag names in campaigns, event trees,
category bundles, unique event ids and names) with errors that name the campaign and event.
A brand links it into its module and exports JSON the engine takes as-is:

```sh
ln -sfn node_modules/mautic-kit/cue/schema cue/cue.mod/pkg/github.com/thevitya/mautic-kit/schema  # a DIRECTORY link
cue vet -c ./cue && cue export ./cue -e declarations > data/declarations.json
```

In JSON declarations `segments` is an array and `tags` filters name tags (resolved to ids);
brands also set `emailDefaults` (sender, language), `footerLabels` and `emailStyles`.

## Environment

`MAUTIC_PROVISION_URL` (how *this machine* reaches Mautic) · `MAUTIC_API_USERNAME` /
`MAUTIC_API_PASSWORD` · `MAUTIC_SITE_URL` (what Mautic writes into mail) · `MAUTIC_DB_*` (install) ·
`MAUTIC_CONTAINER` + `MAUTIC_CRON_CONTAINER` (both or neither) · `MAUTIC_EXEC=local` (inside the
image) · `MAUTIC_DOCKER=podman` · `MAUTIC_EXEC_USER` (default `www-data`; `33:33` where podman cannot resolve the name) · `MAUTIC_SSH=user@host` (run console steps on a server's containers
from a laptop; `MAUTIC_DOCKER` may then carry flags, e.g. `podman --url unix:///run/podman/podman.sock`) ·
`MAUTIC_WEBHOOK_TOKEN`.

## CI

`.github/workflows/provision.yml` is reusable: it builds the CUE, validates, runs the brand's tests,
reports drift in the job summary and, with `apply: true`, provisions with `--no-recreate`.

```yaml
jobs:
  mautic:
    uses: TheVitya/mautic-kit/.github/workflows/provision.yml@v0.3.1
    with:
      directory: mautic
      url: https://mautic.example.com
      apply: ${{ github.event_name != 'pull_request' }}
    secrets:
      MAUTIC_API_USERNAME: ${{ secrets.MAUTIC_API_USERNAME }}
      MAUTIC_API_PASSWORD: ${{ secrets.MAUTIC_API_PASSWORD }}
```

## Known traps (read before pointing at a live instance)

- **Campaigns are updated with PUT** (PATCH appends events and duplicates sends). Existing events
  are matched by NAME and sent under their live ids, so contacts mid-campaign keep their progress —
  verified on Mautic 7 (a declared id like `new_send_2` would delete and recreate the row). Renaming
  an event therefore REMOVES the old one; `--check` prints `removes event(s)`.
- **`--check` sees campaign events by name only.** A changed delay, email or condition on an
  existing event is not reported as drift; it lands because every apply PUTs every campaign
  (hence `~ campaign … updated` on each run). Do not read a clean PR report as "campaigns unchanged".
- An existing form's **fields are never rewritten** (the results table is keyed by field alias);
  field differences are reported as drift.
- A field whose type changed is **deleted and recreated** — its values are lost; the brand's
  `resyncHint` says how to backfill.
- Mautic 7 has **no `mautic:emails:send`** console command; cron jobs calling it fail every run.

## Tests

`npm test` — renderer, engine (against an in-memory fake of Mautic's REST API) and CUE schema
tests (needs `cue` on PATH, skipped otherwise).
