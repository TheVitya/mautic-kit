// The CUE schema (cue/schema) against a fixture brand: valid declarations vet and export to JSON the
// engine (growth-kit's crm) takes as-is; each broken reference is refused by `cue vet` with a message naming it.
// Skipped when the `cue` binary is not installed.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const hasCue = spawnSync('cue', ['version']).status === 0;
const FIXTURE = fileURLToPath(new URL('./fixtures/brand', import.meta.url));
const SCHEMA = fileURLToPath(new URL('../cue/schema', import.meta.url));

/** A throwaway copy of the fixture brand with the kit schema linked in, as a brand's build does. */
function brand(mutate = (s) => s) {
  const dir = mkdtempSync(join(tmpdir(), 'mautic-kit-cue-'));
  cpSync(FIXTURE, dir, { recursive: true });
  const pkg = join(dir, 'cue.mod/pkg/github.com/thevitya/mautic-kit');
  mkdirSync(pkg, { recursive: true });
  symlinkSync(SCHEMA, join(pkg, 'schema'));
  const file = join(dir, 'declarations.cue');
  writeFileSync(file, mutate(readFileSync(file, 'utf8')));
  return dir;
}

const vet = (dir) => spawnSync('cue', ['vet', '-c', '.'], { cwd: dir, encoding: 'utf8' });

test('valid declarations vet and export, with tag filters left as names for the engine to resolve', { skip: !hasCue }, () => {
  const dir = brand();
  try {
    assert.equal(vet(dir).status, 0, vet(dir).stderr);
    const json = JSON.parse(execFileSync('cue', ['export', '.', '-e', 'declarations'], { cwd: dir, encoding: 'utf8' }));
    assert.ok(json.campaigns.length && json.emails.length, 'campaigns and emails exported');
    const tagFilter = json.segments.flatMap((s) => s.filters).find((f) => f.type === 'tags');
    assert.deepEqual(tagFilter.properties.filter, ['news'], 'tag filters name tags');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const BROKEN = [
  ['email.send names a missing email', (s) => s.replace('email: "welcome", email_type', 'email: "nope", email_type'), /email\.send \\"nope\\"/],
  ['stage.change names a missing stage', (s) => s.replace('stage: "Active"', 'stage: "Gone"'), /stage\.change \\"Gone\\"/],
  ['translation of an undeclared email', (s) => s.replace('welcome: hu', 'nobody: hu'), /translation of unknown email/],
  ['campaign list names a missing segment', (s) => s.replace('lists: ["mailable"]', 'lists: ["missing"]'), /lists/],
  ['event parent outside the campaign', (s) => s.replace('parent: "a"', 'parent: "zzz"'), /parent/],
  ['duplicate event names', (s) => s.replace('name: "Stage"', 'name: "Send"'), /uniqueNames/],
  ['changelist names a missing segment', (s) => s.replace('addToLists: ["mailable"]', 'addToLists: ["nope"]'), /lead\.changelist \\"nope\\"/],
  ['changetags names an undeclared tag', (s) => s.replace('add_tags: ["news"]', 'add_tags: ["ghost"]'), /lead\.changetags \\"ghost\\"/],
  ['tag filter names an undeclared tag', (s) => s.replace('filter: ["news"]', 'filter: ["ghost"]'), /filter/],
  ['email category from the wrong bundle', (s) => s.replace('category: "seq"}', 'category: "camp"}'), /category/],
  ['list email without a segment', (s) => s.replace(', lists: ["mailable"]}]', '}]'), /names no segment/],
  ['list email names a missing segment', (s) => s.replace('emailType: "list", lists: ["mailable"]', 'emailType: "list", lists: ["gone"]'), /lists|gone/],
  ['interval trigger without an interval', (s) => s.replace('triggerInterval: 1, triggerIntervalUnit: "d"', 'triggerInterval: 0, triggerIntervalUnit: null'), /./],
];

for (const [name, mutate, expected] of BROKEN) {
  test(`cue vet refuses: ${name}`, { skip: !hasCue }, () => {
    const dir = brand(mutate);
    try {
      const r = vet(dir);
      assert.notEqual(r.status, 0, 'vet should fail');
      assert.match(r.stderr, expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
