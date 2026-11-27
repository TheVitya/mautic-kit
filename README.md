# mautic-kit (superseded)

**No longer used. Do not add brands to it.** v0.5.0 is the last release.

| What it did | Where it lives now |
|---|---|
| `provision`, `validate`, the email renderer, `provision.yml` (removed in v0.5.0) | growth-kit (`TheVitya/growth-kit`): `crm validate\|plan\|apply\|preview`, `sends plan\|apply` |
| `install`, `configure` (container console, `local.php`) | banklens `growth/mautic/lib/` (local dev). On rio, nix `mkMautic` enforces `local.php` on every start |
| CUE schema (`cue/schema`) | vendored into okos-automatizalas `mautic/cue/schema/`; growth-kit's Zod schema (`src/platforms/mautic/declarations.ts`) is the authority |

Former users: `TheVitya/banklens` (Dinarko) and `TheVitya/okos-automatizalas`. Both run Mautic's setup
through growth-kit's `crm`.

Tags stay published so an old pin still resolves. Targeted Mautic 7.
