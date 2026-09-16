// The CUE schema (cue/schema) against a fixture brand: valid declarations vet and export to JSON the
// engine provisions as-is; each broken reference is refused by `cue vet` with a message naming it.
// Skipped when the `cue` binary is not installed.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { provision } from '../src/provision.mjs';
import { validate } from '../src/index.mjs';

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

test('valid declarations vet, export, and provision cleanly', { skip: !hasCue }, async () => {
  const dir = brand();
  try {
    assert.equal(vet(dir).status, 0, vet(dir).stderr);
    const json = JSON.parse(execFileSync('cue', ['export', '.', '-e', 'declarations'], { cwd: dir, encoding: 'utf8' }));
    assert.deepEqual(validate(json), []);

    // Minimal fake Mautic, enough for this fixture.
    const store = {};
    let id = 1;
    let eventId = 100;
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const c of req) body += c;
      const parts = new URL(req.url, 'http://x').pathname.split('/').filter(Boolean);
      const kind = parts[1];
      const wrap = kind === 'segments' ? 'lists' : kind;
      const one = { categories: 'category', stages: 'stage', tags: 'tag', segments: 'list', emails: 'email', campaigns: 'campaign' }[kind];
      store[wrap] ||= [];
      const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.method === 'GET' && parts.length === 2) return send({ [wrap]: Object.fromEntries(store[wrap].map((o) => [o.id, o])) });
      if (req.method === 'GET') return send({ [one]: store[wrap].find((o) => o.id === Number(parts[2])) });
      const obj = { id: id++, ...JSON.parse(body || '{}') };
      if (obj.events) obj.events = obj.events.map((e) => ({ ...e, id: /^\d+$/.test(String(e.id)) ? Number(e.id) : eventId++ }));
      if (parts[2] === 'new') store[wrap].push(obj);
      else Object.assign(store[wrap].find((o) => o.id === Number(parts[2])), obj, { id: Number(parts[2]) });
      return send({ [one]: obj });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const env = { MAUTIC_PROVISION_URL: `http://127.0.0.1:${server.address().port}`, MAUTIC_API_PASSWORD: 'pw' };
      await provision({ env, declarations: json, log: () => {} });
      const tagId = store.tags.find((t) => t.tag === 'news').id;
      assert.deepEqual(store.lists[0].filters[0].properties.filter, [tagId], 'tag NAME resolved to id');
      assert.equal(await provision({ env, declarations: json, checkOnly: true, log: () => {} }), 0);
    } finally {
      server.close();
    }
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
