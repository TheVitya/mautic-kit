// The engine against an in-memory fake of Mautic's REST API — no Mautic, no network.
//
// The fake is deliberately dumb: it stores what it is sent and echoes it back under Mautic's
// response wrappers (`lists` for segments, not `segments`). What it pins is the engine's side of
// the contract — which verb reaches which endpoint, and that a second run on the same state is
// a no-op in --check. Whether real Mautic accepts the payloads is the brand's e2e conformance job.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { dockerArgv } from '../src/docker.mjs';
import { provision } from '../src/provision.mjs';

function fakeMautic() {
  const store = { fields: [], tags: [], lists: [], pages: [], emails: [], campaigns: [], hooks: [] };
  const calls = [];
  let nextId = 1;
  const wrap = { fields: 'fields', tags: 'tags', segments: 'lists', pages: 'pages', emails: 'emails', campaigns: 'campaigns', hooks: 'hooks' };
  const single = { fields: 'field', tags: 'tag', segments: 'list', pages: 'page', emails: 'email', campaigns: 'campaign', hooks: 'hook' };

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
    if (req.method === 'POST' && parts[2] === 'new') {
      const obj = { id: nextId++, ...json };
      list.push(obj);
      return send(201, { [single[kind]]: obj });
    }
    const id = Number(parts[2]);
    const idx = list.findIndex((o) => o.id === id);
    if (idx < 0) return send(404, { error: 'missing' });
    if (parts[3] === 'delete') {
      list.splice(idx, 1);
      return send(200, {});
    }
    if (parts[3] === 'edit') {
      list[idx] = req.method === 'PUT' ? { id, ...json } : { ...list[idx], ...json };
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
    ['exec', '-T', '-u', 'www-data', 'cron', 'x']
  );
  assert.throws(() => dockerArgv({ env: { MAUTIC_CONTAINER: 'web' } }, 'mautic', []), /BOTH/);
  assert.throws(() => dockerArgv({ env: {} }, 'mautic', []), /No way to reach/);
});
