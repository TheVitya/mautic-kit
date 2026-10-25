# Entry points for humans and agents: `just` lists them.

[private]
default:
    @just --list

# Engine, renderer and CUE schema tests (no Mautic, no network)
check:
    npm test

# Tag and push a release; brands pin it in package.json and their workflow `uses:` ref
release version:
    #!/usr/bin/env bash
    set -euo pipefail
    v="{{ version }}"
    [[ "$v" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "version must look like v1.2.3"; exit 1; }
    grep -q "\"version\": \"${v#v}\"" package.json || { echo "bump package.json to $v first"; exit 1; }
    npm test
    git tag -a "{{ version }}" -m "{{ version }}"
    git push origin HEAD "{{ version }}"

# Secret scan of the whole history (also runs in CI)
secrets:
    gitleaks git . --redact --no-banner

# Lint GitHub Actions workflows (also runs in CI)
lint-actions:
    actionlint
    zizmor --offline .github/
