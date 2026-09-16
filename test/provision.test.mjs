// The engine against an in-memory fake of Mautic's REST API — no Mautic, no network.
//
// The fake is deliberately dumb: it stores what it is sent and echoes it back under Mautic's
// response wrappers (`lists` for segments, not `segments`). What it pins is the engine's side of
// the contract — which verb reaches which endpoint, and that a second run on the same state is
// a no-op in --check. Whether real Mautic accepts the payloads is the brand's e2e conformance job.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { dockerArgv, shellQuote } from '../src/docker.mjs';
import { provision } from '../src/provision.mjs';
import { escapePercent } from '../src/configure.mjs';

function fakeMautic() {
  const store = { fields: [], tags: [], lists: [], pages: [], emails: [], campaigns: [], hooks: [], categories: [], stages: [], forms: [], assets: [] };
  const calls = [];
  let nextId = 1;
  let nextEventId = 1000;
  const wrap = { fields: 'fields', tags: 'tags', segments: 'lists', pages: 'pages', emails: 'emails', campaigns: 'campaigns', hooks: 'hooks', categories: 'categories', stages: 'stages', forms: 'forms', assets: 'assets' };
  const single = { fields: 'field', tags: 'tag', segments: 'list', pages: 'page', emails: 'email', campaigns: 'campaign', hooks: 'hook', categories: 'category', stages: 'stage', forms: 'form', assets: 'asset' };

  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const json = body ? JSON.parse(body) : undefined;
    const url = new URL(req.url, 'http://x');
    calls.push(`${req.method} ${url.pathname}`);
    // /api/fields/contact[...] is the one resource with an extra path segment.
    const parts = url.pathname.replace('/api/fields/contact', '/api/fields').split('/').filter(Boolean);
    const kind = parts[1];
    const key = wrap[kind];
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (!key) return send(404, { error: 'unknown' });
    const list = store[key];

    if (req.method === 'GET' && parts.length === 2) {
      return send(200, { [key]: Object.fromEntries(list.map((o) => [o.id, o])) });
    }
    // Like Mautic: an event whose id is not an existing numeric id becomes a NEW row.
    const assignEventIds = (obj) => {
      if (kind !== 'campaigns' || !obj.events) return obj;
      const map = {};
      for (const e of obj.events) map[e.id] = /^\d+$/.test(String(e.id)) ? Number(e.id) : nextEventId++;
      obj.events = obj.events.map((e) => ({
        ...e,
        id: map[e.id],
        parent: e.parent == null ? null : (map[e.parent] ?? e.parent),
        children: (e.children || []).map((c) => map[c] ?? c),
      }));
      return obj;
    };
    if (req.method === 'POST' && parts[2] === 'new') {
      const obj = assignEventIds({ id: nextId++, ...json });
      list.push(obj);
      return send(201, { [single[kind]]: obj });
    }
    const id = Number(parts[2]);
    const idx = list.findIndex((o) => o.id === id);
    if (idx < 0) return send(404, { error: 'missing' });
    if (req.method === 'GET' && parts.length === 3) return send(200, { [single[kind]]: list[idx] });
    if (parts[3] === 'delete') {
      list.splice(idx, 1);
      return send(200, {});
    }
    if (parts[3] === 'edit') {
      list[idx] = assignEventIds(req.method === 'PUT' ? { id, ...json } : { ...list[idx], ...json });
      return send(200, { [single[kind]]: list[idx] });
    }
    return send(405, {});
  });

  return new Promise((resolveServer) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
      resolveServer({ store, calls, url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

const DECLARATIONS = {
  fields: [{ alias: 'confirmed', label: 'Confirmed', type: 'boolean', properties: { yes: 'Yes', no: 'No' } }],
  subscriberTag: 'newsletter',
  segments: (tagId) => [
    {
      alias: 'mailable',
      name: 'Mailable',
      description: 'tagged and confirmed',
      filters: [
        { glue: 'and', field: 'tags', object: 'lead', type: 'tags', operator: 'in', properties: { filter: [tagId] } },
        { glue: 'and', field: 'confirmed', object: 'lead', type: 'boolean', operator: '=', properties: { filter: 1 } },
      ],
    },
  ],
  pages: [{ alias: 'thanks', title: 'Thanks', body: '<html></html>' }],
  globals: { brand_name: 'Brand', brand_url: 'https://brand.test', site: 'https://brand.test' },
  emails: [{ name: 'welcome', subject: 'Hi', body: 'Hello\n\n{global:site|Visit} {page:thanks||thanks}' }],
  campaigns: [
    {
      name: 'Welcome',
      isPublished: false,
      lists: ['mailable'],
      forms: [],
      events: [
        {
          id: 'new1', name: 'Send', type: 'email.send', eventType: 'action', order: 1,
          triggerMode: 'immediate', triggerInterval: 0, triggerIntervalUnit: null,
          parent: null, children: [], decisionPath: null,
          properties: { email: 'welcome', email_type: 'marketing' },
        },
      ],
    },
  ],
  footerLabels: { unsubscribe: 'Leiratkozás', webview: 'Megtekintés böngészőben' },
};

const quiet = () => {};

test('provision creates everything, then --check on the same state reports no drift', async () => {
  const m = await fakeMautic();
  try {
    const env = { MAUTIC_PROVISION_URL: m.url, MAUTIC_API_PASSWORD: 'pw' };
    const first = await provision({ env, declarations: DECLARATIONS, log: quiet });
    assert.equal(first, 5, 'field + tag + segment + page + email + campaign, tag not counted as drift on apply');
    assert.equal(m.store.lists.length, 1);
    assert.equal(m.store.campaigns.length, 1);

    const again = await provision({ env, declarations: DECLARATIONS, checkOnly: true, log: quiet });
    assert.equal(again, 0);
  } finally {
    m.close();
  }
});

test('campaigns are updated with PUT, never PATCH (PATCH appends events)', async () => {
  const m = await fakeMautic();
  try {
    const env = { MAUTIC_PROVISION_URL: m.url, MAUTIC_API_PASSWORD: 'pw' };
    await provision({ env, declarations: DECLARATIONS, log: quiet });
    m.calls.length = 0;
    await provision({ env, declarations: DECLARATIONS, log: quiet });
    const campaignEdits = m.calls.filter((c) => c.includes('/api/campaigns/') && c.endsWith('/edit'));
    assert.deepEqual(campaignEdits.map((c) => c.split(' ')[0]), ['PUT']);
    assert.equal(m.store.campaigns[0].events.length, 1);
  } finally {
    m.close();
  }
});

test('campaign references resolve to ids; an unknown email name throws', async () => {
  const m = await fakeMautic();
  try {
    const env = { MAUTIC_PROVISION_URL: m.url, MAUTIC_API_PASSWORD: 'pw' };
    await provision({ env, declarations: DECLARATIONS, log: quiet });
    const emailId = m.store.emails[0].id;
    assert.equal(m.store.campaigns[0].events[0].properties.email, emailId);

    const broken = {
      ...DECLARATIONS,
      campaigns: [{ ...DECLARATIONS.campaigns[0], name: 'Broken', events: [{ ...DECLARATIONS.campaigns[0].events[0], properties: { email: 'nope', email_type: 'marketing' } }] }],
    };
    await assert.rejects(provision({ env, declarations: broken, log: quiet }), /no emails named "nope"/);
  } finally {
    m.close();
  }
});

test('email footer uses the brand footer labels', async () => {
  const m = await fakeMautic();
  try {
    const env = { MAUTIC_PROVISION_URL: m.url, MAUTIC_API_PASSWORD: 'pw' };
    await provision({ env, declarations: DECLARATIONS, log: quiet });
    assert.match(m.store.emails[0].customHtml, /Leiratkozás/);
    assert.match(m.store.emails[0].customHtml, /\{pagelink=\d+\}/);
  } finally {
    m.close();
  }
});

test('segment filters drift is detected and PATCHed', async () => {
  const m = await fakeMautic();
  try {
    const env = { MAUTIC_PROVISION_URL: m.url, MAUTIC_API_PASSWORD: 'pw' };
    await provision({ env, declarations: DECLARATIONS, log: quiet });
    m.store.lists[0].filters[1].glue = 'or';
    assert.equal(await provision({ env, declarations: DECLARATIONS, checkOnly: true, log: quiet }), 1);
    await provision({ env, declarations: DECLARATIONS, log: quiet });
    assert.equal(await provision({ env, declarations: DECLARATIONS, checkOnly: true, log: quiet }), 0);
  } finally {
    m.close();
  }
});

test('unresolved tokens stop provision before anything is written', async () => {
  const m = await fakeMautic();
  try {
    const env = { MAUTIC_PROVISION_URL: m.url, MAUTIC_API_PASSWORD: 'pw' };
    const bad = { ...DECLARATIONS, emails: [{ name: 'x', subject: 's', body: '{global:missing}' }] };
    await assert.rejects(provision({ env, declarations: bad, log: quiet }), /unresolved tokens/);
    assert.equal(m.calls.length, 0);
  } finally {
    m.close();
  }
});

test('dockerArgv: containers, compose files, podman-free defaults, and the both-or-neither guard', () => {
  assert.deepEqual(
    dockerArgv({ env: {}, composeFiles: ['a.yml', 'b.yml'] }, 'mautic', ['php', '-v']),
    ['compose', '-f', 'a.yml', '-f', 'b.yml', 'exec', '-T', '-u', 'www-data', 'mautic', 'php', '-v']
  );
  assert.deepEqual(
    dockerArgv({ env: { MAUTIC_CONTAINER: 'web', MAUTIC_CRON_CONTAINER: 'cron' } }, 'mautic_cron', ['x']),
    ['exec', '-u', 'www-data', 'cron', 'x']
  );
  assert.throws(() => dockerArgv({ env: { MAUTIC_CONTAINER: 'web' } }, 'mautic', []), /BOTH/);
  assert.throws(() => dockerArgv({ env: {} }, 'mautic', []), /No way to reach/);
});

test('campaign updates keep live event ids, so contacts mid-campaign keep their progress', async () => {
  const m = await fakeMautic();
  try {
    const env = { MAUTIC_PROVISION_URL: m.url, MAUTIC_API_PASSWORD: 'pw' };
    const twoStep = {
      ...DECLARATIONS,
      campaigns: [
        {
          ...DECLARATIONS.campaigns[0],
          events: [
            { ...DECLARATIONS.campaigns[0].events[0], id: 'send', children: ['wait'] },
            { ...DECLARATIONS.campaigns[0].events[0], id: 'wait', name: 'Send again', parent: 'send', triggerMode: 'interval', triggerInterval: 1, triggerIntervalUnit: 'd' },
          ],
          canvasSettings: { nodes: [{ id: 'send' }, { id: 'wait' }], connections: [{ sourceId: 'send', targetId: 'wait' }] },
        },
      ],
    };
    await provision({ env, declarations: twoStep, log: quiet });
    const before = m.store.campaigns[0].events.map((e) => e.id);
    await provision({ env, declarations: twoStep, log: quiet });
    const after = m.store.campaigns[0].events;
    assert.deepEqual(after.map((e) => e.id), before);
    assert.equal(after[1].parent, before[0]);
    assert.deepEqual(m.store.campaigns[0].canvasSettings.connections[0], { sourceId: String(before[0]), targetId: String(before[1]) });
  } finally {
    m.close();
  }
});

test('removing a campaign event is drift in --check and names the event', async () => {
  const m = await fakeMautic();
  try {
    const env = { MAUTIC_PROVISION_URL: m.url, MAUTIC_API_PASSWORD: 'pw' };
    await provision({ env, declarations: DECLARATIONS, log: quiet });
    const lines = [];
    const renamed = {
      ...DECLARATIONS,
      campaigns: [{ ...DECLARATIONS.campaigns[0], events: [{ ...DECLARATIONS.campaigns[0].events[0], name: 'Send v2' }] }],
    };
    const drift = await provision({ env, declarations: renamed, checkOnly: true, log: (l) => lines.push(l) });
    assert.equal(drift, 1);
    assert.ok(lines.some((l) => l.includes('removes event(s) "Send"')));
  } finally {
    m.close();
  }
});

test('duplicate event names inside one campaign are refused', async () => {
  const m = await fakeMautic();
  try {
    const env = { MAUTIC_PROVISION_URL: m.url, MAUTIC_API_PASSWORD: 'pw' };
    await provision({ env, declarations: DECLARATIONS, log: quiet });
    const dup = {
      ...DECLARATIONS,
      campaigns: [{ ...DECLARATIONS.campaigns[0], events: [DECLARATIONS.campaigns[0].events[0], { ...DECLARATIONS.campaigns[0].events[0], id: 'new2' }] }],
    };
    await assert.rejects(provision({ env, declarations: dup, log: quiet }), /event names must be unique/);
  } finally {
    m.close();
  }
});

// The okos-automatizalas shape: categories, stages, a form, a looked-up asset, projects, sender.
const OKOS = {
  categories: [
    { alias: 'seq', title: 'Sequence', bundle: 'email', color: '4e79a7' },
    { alias: 'camp', title: 'Campaign', bundle: 'campaign', color: 'e15759' },
    { alias: 'optin', title: 'Opt-in', bundle: 'form', color: '76b7b2' },
  ],
  tags: [{ tag: 'training-subscriber' }],
  stages: [{ name: 'Training Active', weight: 2, description: 'S1' }],
  segments: () => [{ alias: 'active', name: 'Active', description: '', projects: [1], isGlobal: true }],
  forms: [
    {
      name: 'OptIn', alias: 'optin', formType: 'campaign', category: 'optin',
      fields: [{ label: 'Email', alias: 'email', type: 'email', order: 1 }],
    },
  ],
  assets: [{ name: 'day_0_pdf', title: '0-nap.pdf' }],
  globals: { brand_name: 'Okos', brand_url: 'https://okos.test', trening: 'AI Tréning' },
  emailDefaults: { language: 'hu', fromName: 'Viktor', fromAddress: 'viktor@okos.test' },
  emails: [{ name: 'S1-1', subject: 'Üdv a {global:trening}-ben', body: 'Letöltés: {asset:day_0_pdf|PDF}', category: 'seq', projects: [1] }],
  campaigns: [
    {
      name: 'C-OPTIN', isPublished: true, category: 'camp', projects: [1], lists: [], forms: ['optin'],
      events: [
        { id: 'new_submit', name: 'Submitted', type: 'form.submit', eventType: 'decision', order: 1, triggerMode: null, triggerInterval: 0, triggerIntervalUnit: null, parent: null, children: ['new_stage'], decisionPath: null, properties: { forms: ['optin'] } },
        { id: 'new_stage', name: 'Stage', type: 'stage.change', eventType: 'action', order: 2, triggerMode: 'immediate', triggerInterval: 0, triggerIntervalUnit: null, parent: 'new_submit', children: [], decisionPath: 'yes', properties: { stage: 'Training Active' } },
      ],
    },
  ],
};

test('okos shape: categories, stages, forms, assets and sender resolve end to end', async () => {
  const m = await fakeMautic();
  m.store.assets.push({ id: 77, title: '0-nap.pdf' });
  try {
    const env = { MAUTIC_PROVISION_URL: m.url, MAUTIC_API_PASSWORD: 'pw' };
    await provision({ env, declarations: OKOS, log: quiet });
    const email = m.store.emails[0];
    assert.equal(email.subject, 'Üdv a AI Tréning-ben');
    assert.equal(email.category, m.store.categories.find((c) => c.alias === 'seq').id);
    assert.equal(email.fromAddress, 'viktor@okos.test');
    assert.equal(email.language, 'hu');
    assert.match(email.customHtml, /\{assetlink=77\}/);
    const camp = m.store.campaigns[0];
    assert.equal(camp.category, m.store.categories.find((c) => c.alias === 'camp').id);
    assert.deepEqual(camp.forms, [{ id: m.store.forms[0].id }]);
    assert.deepEqual(camp.events[0].properties.forms, [m.store.forms[0].id]);
    assert.equal(camp.events[1].properties.stage, m.store.stages[0].id);
    assert.deepEqual(m.store.lists[0].projects, [1]);
    assert.equal(await provision({ env, declarations: OKOS, checkOnly: true, log: quiet }), 0);
  } finally {
    m.close();
  }
});

test('an existing form keeps its fields: a field change is drift, never a rewrite', async () => {
  const m = await fakeMautic();
  m.store.assets.push({ id: 77, title: '0-nap.pdf' });
  try {
    const env = { MAUTIC_PROVISION_URL: m.url, MAUTIC_API_PASSWORD: 'pw' };
    await provision({ env, declarations: OKOS, log: quiet });
    const changed = { ...OKOS, forms: [{ ...OKOS.forms[0], fields: [{ label: 'Name', alias: 'name', type: 'text', order: 1 }] }] };
    const lines = [];
    await provision({ env, declarations: changed, log: (l) => lines.push(l) });
    assert.deepEqual(m.store.forms[0].fields.map((f) => f.alias), ['email']);
    assert.ok(lines.some((l) => l.includes('fields differ') && l.includes('NOT applied')));
  } finally {
    m.close();
  }
});

test('a missing asset is drift, and a missing category stops the run', async () => {
  const m = await fakeMautic();
  try {
    const env = { MAUTIC_PROVISION_URL: m.url, MAUTIC_API_PASSWORD: 'pw' };
    const noAsset = { ...OKOS, emails: [{ ...OKOS.emails[0], body: 'no asset token' }] };
    assert.ok((await provision({ env, declarations: noAsset, checkOnly: true, log: quiet })) > 0);
    const badCat = { ...noAsset, emails: [{ ...noAsset.emails[0], category: 'nope' }] };
    await assert.rejects(provision({ env, declarations: badCat, log: quiet }), /no category "nope"/);
  } finally {
    m.close();
  }
});

test('shellQuote survives the php -r code configure sends', async () => {
  const { execFileSync } = await import('node:child_process');
  const words = ['php', '-r', `include '/x/local.php'; echo json_encode($parameters); $a = "b";`, 'it\'s', 'plain'];
  const out = execFileSync('bash', ['-c', `printf '%s\\n' ${words.map(shellQuote).join(' ')}`], { encoding: 'utf8' });
  assert.deepEqual(out.trimEnd().split('\n'), words);
});

test('escapePercent doubles % the way Mautic stores DSNs in local.php', () => {
  assert.equal(escapePercent('smtp://viktor%40example.com:p%25w@mail:587'), 'smtp://viktor%%40example.com:p%%25w@mail:587');
  assert.equal(escapePercent('sync://'), 'sync://');
  assert.equal(escapePercent(1), 1);
  assert.deepEqual(escapePercent(['a%b']), ['a%%b']);
});
