/**
 * Provision a Mautic instance from a brand's declarations.
 *
 * Mautic's contact fields and segments are configuration, and configuration that only exists
 * because somebody clicked it cannot be rebuilt, reviewed in a diff, or told apart from drift.
 * Everything a brand needs Mautic to HAVE is declared in its own repo and applied by this.
 *
 * Idempotent: existing objects are matched by alias or name and reconciled. Run it after a fresh
 * install, and again whenever the declarations change. `checkOnly` reports drift and changes
 * nothing.
 *
 * WHAT to create lives in the brand's declarations; this file is only HOW.
 */

import { httpBase } from './docker.mjs';
import { renderEmail } from './html.mjs';
import { checkTokens, resolveTokens } from './tokens.mjs';

/**
 * Compares only what the declarations say. Mautic echoes back extra keys (`display`, nulls it
 * fills in), so a deep-equal on the raw objects would report drift on every run.
 */
function sameFilters(live, wanted) {
  // Mautic echoes scalars back with its own types — a tag id sent as 1 comes back as "1" — so
  // values are compared as strings. Without this every run reports drift and re-PATCHes.
  const scalar = (v) => (Array.isArray(v) ? v.map(String) : v == null ? null : String(v));
  const norm = (arr) =>
    JSON.stringify(
      (arr || []).map((f, i) => ({
        // `glue` is part of the MEANING, not decoration: an `and` edited to `or` in the UI turns
        // `tag AND confirmed = 1` into "tagged, or confirmed by any route", and the segment then
        // holds people it must not — exactly the drift this compare exists to catch, reported
        // clean if it is left out. The LEADING filter's glue joins nothing, and Mautic may echo it
        // as null; normalizing it is what keeps this from re-PATCHing forever.
        glue: i === 0 ? 'and' : String(f.glue || 'and'),
        field: f.field,
        operator: f.operator,
        type: f.type,
        filter: scalar(f.properties?.filter ?? f.filter ?? null),
      }))
    );
  return norm(live) === norm(wanted);
}

/** @param {string} base @param {string} auth */
function client(base, auth) {
  return async function api(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* Mautic answers HTML when the API is disabled — the status is the verdict either way. */
    }
    if (!res.ok) {
      throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
    }
    return json;
  };
}

/**
 * @param {object} ctx
 * @param {Record<string, string|undefined>} ctx.env
 * @param {import('./index.mjs').Declarations} ctx.declarations
 * @param {boolean} [ctx.checkOnly]
 * @param {boolean} [ctx.noRecreate]      refuse a field type change instead of delete-and-recreate
 * @param {string} [ctx.resyncHint]      how to backfill a recreated field, printed after one
 * @param {string} [ctx.webhookBaseUrl]  how MAUTIC reaches the webhook receiver
 * @param {(msg: string) => void} [ctx.log]
 * @returns {Promise<number>} drift count (applied unless checkOnly)
 */
export async function provision(ctx) {
  const { env, declarations: D, checkOnly: CHECK_ONLY = false, noRecreate = false, log = console.log } = ctx;
  const BASE = httpBase(env);
  const USER = env.MAUTIC_API_USERNAME || 'admin';
  const PASS = env.MAUTIC_API_PASSWORD || env.MAUTIC_ADMIN_PASSWORD || '';
  if (!PASS) {
    throw new Error('No Mautic password. Set MAUTIC_API_PASSWORD (or MAUTIC_ADMIN_PASSWORD).');
  }
  const api = client(BASE, `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`);
  const FIELDS = D.fields || [];
  const SUBSCRIBER_TAG = D.subscriberTag;
  // A function (JS brands: tag id in, segments out) or a plain array (CUE/JSON brands), where a
  // `tags` filter names TAGS and the ids are looked up here.
  const SEGMENTS = typeof D.segments === 'function' ? D.segments : null;
  const SEGMENT_LIST = Array.isArray(D.segments) ? D.segments : [];
  const PAGES = D.pages || [];
  const EMAILS = D.emails || [];
  const EMAIL_TRANSLATIONS = D.emailTranslations || {};
  const GLOBALS = D.globals || {};
  const CAMPAIGNS = D.campaigns || [];
  const WEBHOOKS = D.webhooks || [];
  const CATEGORIES = D.categories || [];
  const TAGS = D.tags || [];
  const STAGES = D.stages || [];
  const FORMS = D.forms || [];
  const ASSETS = D.assets || [];
  const EMAIL_DEFAULTS = D.emailDefaults || {};
  const RESYNC = ctx.resyncHint || 'backfill the field values';

async function createField(f) {
  await api('POST', '/api/fields/contact/new', {
    label: f.label,
    alias: f.alias,
    type: f.type,
    group: 'core',
    isPublished: true,
    ...(f.properties ? { properties: f.properties } : {}),
  });
}

/**
 * Fields, matched by alias AND by type.
 *
 * The type is not cosmetic. Mautic's segment filters are typed: a relative date comparison
 * (`lt`, `-30 days`) is REFUSED with a 400 against a text field, so a recency or an expiry
 * declared as text can only ever be matched exactly — which answers no question anybody asks.
 * A field of the wrong type is therefore worse than a missing one: it stores values, looks
 * healthy in the UI, and silently cannot support the segment it exists for.
 *
 * Mautic will not change a field's type in place, so correcting one means DELETE and recreate,
 * which discards the stored values. That is survivable only because they are derivable:
 * the brand's resync (`resyncHint`) recomputes them afterwards. Nothing here is a
 * source of truth, which is exactly what makes this safe — and why it must never be pointed at
 * a field the CRM alone knows.
 */
async function ensureFields() {
  const existing = await api('GET', '/api/fields/contact?limit=500');
  const live = new Map(Object.values(existing?.fields || {}).map((f) => [f.alias, f]));

  const missing = FIELDS.filter((f) => !live.has(f.alias));
  const wrongType = FIELDS.filter((f) => live.has(f.alias) && live.get(f.alias).type !== f.type);

  // Unattended runs (CI) must not empty a field; a recreate is a decision for a human run.
  if (noRecreate && !CHECK_ONLY && wrongType.length) {
    throw new Error(
      `--no-recreate: ${wrongType.map((f) => `${f.alias} (${live.get(f.alias).type} -> ${f.type})`).join(', ')} ` +
        `would be deleted and recreated, emptying stored values. Run without --no-recreate to do it.`
    );
  }

  for (const f of missing) {
    if (CHECK_ONLY) {
      log(`DRIFT field missing: ${f.alias}`);
      continue;
    }
    await createField(f);
    log(`+ field ${f.alias} (${f.type})`);
  }

  for (const f of wrongType) {
    const was = live.get(f.alias);
    if (CHECK_ONLY) {
      log(`DRIFT field type: ${f.alias} is ${was.type}, declared ${f.type}`);
      continue;
    }
    // A FIXED field is one of Mautic's own (email, country, firstname). Recreating it detaches
    // whatever internally depends on it, and the declaration is the thing that is wrong — a core
    // field's type is not ours to choose. Refuse and say so; a silent recreate here is damage
    // that looks like a successful provision.
    if (was.isFixed) {
      throw new Error(
        `field ${f.alias} is a Mautic core field of type ${was.type}, but is declared as ` +
          `${f.type}. Declare the core type instead of recreating it.`
      );
    }
    await api('DELETE', `/api/fields/contact/${was.id}/delete`);
    await createField(f);
    log(
      `~ field ${f.alias} recreated as ${f.type} (was ${was.type}) — ${RESYNC}`
    );
  }

  // Verify every field written this run actually landed under the DECLARED alias — CREATES as
  // well as recreates, which is the case that got through when this guard covered only the
  // latter.
  //
  // Mautic keeps the `leads` column of a deleted field and hands the replacement a numeric
  // suffix: ask for `timezone`, get `timezone1`, with a 200 at every step. Nothing downstream
  // can tell. The provisioner reports success, `identifyUser` writes a key no field answers to,
  // and Mautic accepts unknown keys silently — so the trait is simply absent, everywhere, with
  // no error anywhere to explain it. Re-read the field list rather than trusting the create
  // response, which echoes the alias that was ASKED for.
  const written = missing.concat(wrongType);
  if (written.length && !CHECK_ONLY) {
    const after = await api('GET', '/api/fields/contact?limit=500');
    const aliases = new Set(Object.values(after?.fields || {}).map((f) => f.alias));
    const lost = written.filter((f) => !aliases.has(f.alias)).map((f) => f.alias);
    if (lost.length) {
      throw new Error(
        `field(s) did not come back under their declared alias: ${lost.join(', ')}. ` +
          `Mautic suffixes an alias whose leads column still exists, and the API will not ` +
          `re-issue the original. Drop the leftover column and the orphaned lead_fields row ` +
          `directly in the database, then re-run.`
      );
    }
  }

  const drift = missing.length + wrongType.length;
  if (!drift) log(`= fields ok (${FIELDS.length})`);
  else if (wrongType.length && !CHECK_ONLY) {
    // Said once, loudly, at the end of the field pass: a recreated field is EMPTY until the
    // backfill runs, and a segment read in that window reports the wrong people with no error.
    log(
      `\n  ! ${wrongType.length} field(s) were recreated and are now blank. ${RESYNC} before trusting any segment that uses them.`
    );
  }
  return drift;
}

/**
 * Categories, matched by alias. Title and colour are reconciled; a category is never deleted —
 * emails, forms and campaigns point at it, and Mautic nulls those references rather than refusing.
 */
async function ensureCategories() {
  if (!CATEGORIES.length) return { ids: {}, drift: 0 };
  const existing = await api('GET', '/api/categories?limit=500');
  const live = new Map(Object.values(existing?.categories || {}).map((c) => [c.alias, c]));
  /** @type {Record<string, number>} */
  const ids = {};
  let drift = 0;
  for (const c of CATEGORIES) {
    const payload = { title: c.title, alias: c.alias, bundle: c.bundle, color: c.color, isPublished: c.isPublished !== false };
    const found = live.get(c.alias);
    if (found) {
      ids[c.alias] = found.id;
      const same = found.title === c.title && String(found.color || '').replace('#', '') === String(c.color || '').replace('#', '') && found.bundle === c.bundle;
      if (same) {
        log(`= category ${c.alias}`);
        continue;
      }
      drift++;
      if (CHECK_ONLY) {
        log(`DRIFT category ${c.alias} differs`);
        continue;
      }
      await api('PATCH', `/api/categories/${found.id}/edit`, payload);
      log(`~ category ${c.alias} updated`);
      continue;
    }
    drift++;
    if (CHECK_ONLY) {
      log(`DRIFT category missing: ${c.alias}`);
      continue;
    }
    const res = await api('POST', '/api/categories/new', payload);
    ids[c.alias] = res?.category?.id;
    log(`+ category ${c.alias} (${ids[c.alias]})`);
  }
  return { ids, drift };
}

/** Tags beyond the subscriber tag. Created if absent; a tag has nothing else to reconcile. */
async function ensureTags() {
  if (!TAGS.length) return 0;
  const existing = await api('GET', '/api/tags?limit=500');
  const live = new Set(Object.values(existing?.tags || {}).map((t) => t.tag));
  let drift = 0;
  for (const t of TAGS) {
    if (live.has(t.tag)) {
      log(`= tag ${t.tag}`);
      continue;
    }
    drift++;
    if (CHECK_ONLY) {
      log(`DRIFT tag missing: ${t.tag}`);
      continue;
    }
    await api('POST', '/api/tags/new', { tag: t.tag });
    log(`+ tag ${t.tag}`);
  }
  return drift;
}

/** Stages, matched by name; weight and description reconciled. */
async function ensureStages() {
  if (!STAGES.length) return { ids: {}, drift: 0 };
  const existing = await api('GET', '/api/stages?limit=500');
  const live = new Map(Object.values(existing?.stages || {}).map((st) => [st.name, st]));
  /** @type {Record<string, number>} */
  const ids = {};
  let drift = 0;
  for (const st of STAGES) {
    const payload = { name: st.name, weight: st.weight, description: st.description || '', isPublished: st.isPublished !== false };
    const found = live.get(st.name);
    if (found) {
      ids[st.name] = found.id;
      if (Number(found.weight) === Number(st.weight) && (found.description || '') === (st.description || '')) {
        log(`= stage ${st.name}`);
        continue;
      }
      drift++;
      if (CHECK_ONLY) {
        log(`DRIFT stage ${st.name} differs`);
        continue;
      }
      await api('PATCH', `/api/stages/${found.id}/edit`, payload);
      log(`~ stage ${st.name} updated`);
      continue;
    }
    drift++;
    if (CHECK_ONLY) {
      log(`DRIFT stage missing: ${st.name}`);
      continue;
    }
    const res = await api('POST', '/api/stages/new', payload);
    ids[st.name] = res?.stage?.id;
    log(`+ stage ${st.name} (${ids[st.name]})`);
  }
  return { ids, drift };
}

/**
 * Forms, matched by alias. CREATED with their fields; an EXISTING form's fields are never rewritten.
 *
 * Mautic stores submissions in a per-form results table whose columns ARE the field aliases, and an
 * edit that sends `fields` replaces them — a renamed or re-created field loses its column and the
 * answers in it. So a field difference on a live form is reported, never applied: change it in the
 * UI deliberately, or create a new form. Everything else about the form (name, redirect, category)
 * is reconciled.
 */
async function ensureForms(categoryIds) {
  if (!FORMS.length) return { ids: {}, drift: 0 };
  const existing = await api('GET', '/api/forms?limit=500');
  const live = new Map(Object.values(existing?.forms || {}).map((f) => [f.alias, f]));
  /** @type {Record<string, number>} */
  const ids = {};
  let drift = 0;
  for (const form of FORMS) {
    const category = form.category == null ? undefined : needId('category', categoryIds, form.category, `form ${form.alias}`);
    const { fields, actions, ...rest } = form;
    const base = { ...rest, ...(category !== undefined ? { category } : {}) };
    const found = live.get(form.alias);
    if (!found) {
      drift++;
      if (CHECK_ONLY) {
        log(`DRIFT form missing: ${form.alias}`);
        continue;
      }
      const res = await api('POST', '/api/forms/new', { ...base, fields: fields || [], actions: actions || [] });
      ids[form.alias] = res?.form?.id;
      log(`+ form ${form.alias} (${ids[form.alias]})`);
      continue;
    }
    ids[form.alias] = found.id;
    const liveFields = Object.values(found.fields || {}).map((f) => `${f.alias}:${f.type}`).sort().join(',');
    const wantFields = (fields || []).map((f) => `${f.alias}:${f.type}`).sort().join(',');
    if (liveFields !== wantFields) {
      drift++;
      log(`${CHECK_ONLY ? 'DRIFT' : '!'} form ${form.alias} fields differ (live ${liveFields || 'none'} vs declared ${wantFields || 'none'}) — NOT applied; see ensureForms`);
    }
    if (!CHECK_ONLY) await api('PATCH', `/api/forms/${found.id}/edit`, base);
    log(`= form ${form.alias}`);
  }
  return { ids, drift };
}

/**
 * Assets are LOOKED UP by title, never created — files are uploaded in the UI. A missing asset is
 * drift, and an `{asset:name}` token pointing at it stops the run in the token check.
 */
async function lookupAssets() {
  if (!ASSETS.length) return { ids: {}, drift: 0 };
  const existing = await api('GET', '/api/assets?limit=500');
  const live = new Map(Object.values(existing?.assets || {}).map((a) => [a.title, a]));
  /** @type {Record<string, number>} */
  const ids = {};
  let drift = 0;
  for (const a of ASSETS) {
    const found = live.get(a.title);
    if (found) {
      ids[a.name] = found.id;
      log(`= asset ${a.name}`);
    } else {
      drift++;
      log(`DRIFT asset missing (upload it in Mautic): ${a.title}`);
    }
  }
  return { ids, drift };
}

/** A symbolic reference that must resolve, or the run stops — Mautic would accept a 0 silently. */
function needId(kind, map, name, where) {
  const id = map[name];
  if (id != null) return id;
  // Under --check nothing is created, so a DECLARED category that is not live yet has no id — it is
  // already reported as drift above. Only a name nobody declared is an error in both modes.
  const declared = kind === 'category' ? CATEGORIES.some((c) => c.alias === name) : false;
  if (CHECK_ONLY && declared) return 0;
  throw new Error(`${where}: no ${kind} "${name}"`);
}

/**
 * Segments declared as data name tags in `tags` filters; Mautic wants ids. Under --check a tag that
 * is declared but not live yet resolves to 0 (already reported); an undeclared one is an error.
 */
async function resolveTagFilters(segments) {
  const usesTags = segments.some((sg) => (sg.filters || []).some((f) => f.type === 'tags'));
  if (!usesTags) return segments;
  const existing = await api('GET', '/api/tags?limit=500');
  const ids = Object.fromEntries(Object.values(existing?.tags || {}).map((t) => [t.tag, t.id]));
  const declared = new Set([SUBSCRIBER_TAG, ...TAGS.map((t) => t.tag)].filter(Boolean));
  return segments.map((sg) => ({
    ...sg,
    filters: (sg.filters || []).map((f) => {
      if (f.type !== 'tags' || !f.properties) return f;
      const names = [].concat(f.properties.filter ?? []);
      const resolved = names.map((n) => {
        if (typeof n === 'number' || /^\d+$/.test(String(n))) return n;
        if (ids[n] != null) return ids[n];
        if (CHECK_ONLY && declared.has(n)) return 0;
        throw new Error(`segment ${sg.alias}: no tag "${n}"`);
      });
      return { ...f, properties: { ...f.properties, filter: resolved } };
    }),
  }));
}

/** The tag every subscriber of this brand carries. Returns its id, creating it if absent. */
async function ensureTag() {
  // No subscriber tag is a supported shape: segments then get `null` and filter on fields alone.
  if (!SUBSCRIBER_TAG) return undefined;
  const existing = await api('GET', '/api/tags?limit=500');
  const found = Object.values(existing?.tags || {}).find((t) => t.tag === SUBSCRIBER_TAG);
  if (found) {
    log(`= tag ${SUBSCRIBER_TAG} (${found.id})`);
    return found.id;
  }
  if (CHECK_ONLY) {
    log(`DRIFT tag missing: ${SUBSCRIBER_TAG}`);
    return null;
  }
  const created = await api('POST', '/api/tags/new', { tag: SUBSCRIBER_TAG });
  log(`+ tag ${SUBSCRIBER_TAG} (${created.tag.id})`);
  return created.tag.id;
}

async function ensureSegments(tagId) {
  let wanted;
  if (SEGMENTS) {
    // Without the tag id there is nothing to filter on; the drift report already named it.
    if (tagId === null) return CHECK_ONLY ? SEGMENTS(0).length : 0;
    wanted = SEGMENTS(tagId);
  } else {
    wanted = await resolveTagFilters(SEGMENT_LIST);
  }
  const existing = await api('GET', '/api/segments?limit=500');
  const byAlias = new Map(Object.values(existing?.lists || {}).map((s) => [s.alias, s]));

  let drift = 0;
  for (const s of wanted) {
    const live = byAlias.get(s.alias);

    if (!live) {
      drift++;
      if (CHECK_ONLY) {
        log(`DRIFT segment missing: ${s.alias}`);
        continue;
      }
      await api('POST', '/api/segments/new', {
        name: s.name,
        alias: s.alias,
        description: s.description,
        isPublished: s.isPublished !== false,
        ...(s.isGlobal !== undefined ? { isGlobal: s.isGlobal } : {}),
        ...(s.projects ? { projects: s.projects } : {}),
        filters: s.filters || [],
      });
      log(`+ segment ${s.alias}`);
      continue;
    }

    // Existing segments are RECONCILED, not skipped. A filter corrected in this file is
    // worthless if it only reaches instances that never had the wrong one — and a segment whose
    // filters have drifted fails silently, by quietly holding the wrong people.
    if (!sameFilters(live.filters, s.filters || [])) {
      drift++;
      if (CHECK_ONLY) {
        log(`DRIFT segment filters: ${s.alias}`);
        continue;
      }
      await api('PATCH', `/api/segments/${live.id}/edit`, { filters: s.filters || [] });
      log(`~ segment ${s.alias} filters updated`);
      continue;
    }
    log(`= segment ${s.alias}`);
  }
  return drift;
}

/**
 * Landing pages. Created and updated by title; NEVER deleted.
 *
 * A page a delivered email links to outlives the campaign that sent it — mail sitting in an inbox
 * for a year still points here. A 404 at the end of a confirmation link is the one broken link
 * that actually costs a subscriber.
 */
async function ensurePages() {
  const existing = await api('GET', '/api/pages?limit=500');
  const live = new Map(Object.values(existing?.pages || {}).map((p) => [p.alias, p]));
  const ids = {};
  let drift = 0;

  for (const page of PAGES) {
    const found = live.get(page.alias);
    const payload = {
      title: page.title,
      alias: page.alias,
      customHtml: page.body,
      isPublished: page.isPublished !== false,
    };
    if (found) {
      ids[page.alias] = found.id;
      if (!CHECK_ONLY) await api('PATCH', `/api/pages/${found.id}/edit`, payload);
      log(`= page ${page.alias}`);
      continue;
    }
    drift++;
    if (CHECK_ONLY) {
      log(`DRIFT page missing: ${page.alias}`);
      continue;
    }
    const res = await api('POST', '/api/pages/new', payload);
    ids[page.alias] = res?.page?.id;
    log(`+ page ${page.alias} (${ids[page.alias]})`);
  }
  return { ids, drift };
}

/**
 * Emails. The declared PLAIN TEXT body is rendered here — Mautic stores the HTML, and this is the
 * only place it is produced.
 *
 * Always re-sent on an existing email rather than compared: the rendered HTML is derived from the
 * copy, the wrapper and the token values all at once, so "has it changed" is three questions and
 * the answer to any of them means the stored HTML is stale. An email whose body silently lags the
 * declaration is worse than a redundant PATCH.
 */
async function ensureEmails(pageIds, assetIds, categoryIds) {
  const existing = await api('GET', '/api/emails?limit=500');
  const live = new Map(Object.values(existing?.emails || {}).map((e) => [e.name, e]));
  const ids = {};
  let drift = 0;

  for (const email of EMAILS) {
    const { html, plainText } = renderEmail({ ...email, language: email.language || EMAIL_DEFAULTS.language }, {
      globals: GLOBALS,
      pageIds,
      assetIds,
      brandName: GLOBALS.brand_name,
      brandUrl: GLOBALS.brand_url,
      footerLabels: D.footerLabels,
      styles: D.emailStyles,
    });
    const payload = {
      name: email.name,
      // Subjects carry tokens too (`{global:trening_neve}`); rendered as plain text, never HTML.
      subject: resolveTokens(email.subject, { globals: GLOBALS, assetIds, pageIds, plain: true }),
      preheaderText: email.preview || '',
      customHtml: html,
      plainText,
      emailType: email.emailType || EMAIL_DEFAULTS.emailType || 'template',
      language: email.language || EMAIL_DEFAULTS.language || 'en',
      isPublished: email.isPublished !== false,
      ...(email.category ? { category: needId('category', categoryIds, email.category, `email ${email.name}`) } : {}),
      ...(email.projects ? { projects: email.projects } : {}),
      ...(email.fromName || EMAIL_DEFAULTS.fromName ? { fromName: email.fromName || EMAIL_DEFAULTS.fromName } : {}),
      ...(email.fromAddress || EMAIL_DEFAULTS.fromAddress ? { fromAddress: email.fromAddress || EMAIL_DEFAULTS.fromAddress } : {}),
      ...(email.replyToAddress || EMAIL_DEFAULTS.replyToAddress ? { replyToAddress: email.replyToAddress || EMAIL_DEFAULTS.replyToAddress } : {}),
    };

    const found = live.get(email.name);
    if (found) {
      ids[email.name] = found.id;
      if (!CHECK_ONLY) await api('PATCH', `/api/emails/${found.id}/edit`, payload);
      log(`= email ${email.name}`);
    } else {
      drift++;
      if (CHECK_ONLY) {
        log(`DRIFT email missing: ${email.name}`);
        continue;
      }
      const res = await api('POST', '/api/emails/new', payload);
      ids[email.name] = res?.email?.id;
      log(`+ email ${email.name} (${ids[email.name]})`);
    }

    // Translations, as CHILDREN of the email just written. Mautic models a translated email as a
    // separate email carrying `translationParent` plus its own `language`, and picks between them
    // by the contact's `preferred_locale`. The parent must exist first, which is why this runs
    // here rather than in a pass of its own.
    const translations = EMAIL_TRANSLATIONS[email.name] || {};
    for (const [lang, copy] of Object.entries(translations)) {
      const childName = `${email.name}-${lang}`;
      const rendered = renderEmail(
        { ...email, ...copy, language: lang },
        {
          globals: GLOBALS,
          pageIds,
          assetIds,
          brandName: GLOBALS.brand_name,
          brandUrl: GLOBALS.brand_url,
          footerLabels: D.footerLabels,
      styles: D.emailStyles,
        }
      );
      const childPayload = {
        ...payload,
        name: childName,
        subject: resolveTokens(copy.subject, { globals: GLOBALS, assetIds, pageIds, plain: true }),
        preheaderText: copy.preview || '',
        customHtml: rendered.html,
        plainText: rendered.plainText,
        language: lang,
        // NOT `translationParent`, whatever the API hands back on a read. Mautic's email form
        // maps `templateTranslationParent` / `segmentTranslationParent` onto it depending on the
        // email type, and a payload using the read name is ACCEPTED, answered 200, and silently
        // ignored — leaving twelve unrelated emails that look provisioned and a campaign that
        // sends the base language to everybody.
        [email.emailType === 'list' ? 'segmentTranslationParent' : 'templateTranslationParent']:
          ids[email.name],
      };
      const liveChild = live.get(childName);
      if (liveChild) {
        if (!CHECK_ONLY) await api('PATCH', `/api/emails/${liveChild.id}/edit`, childPayload);
        log(`  = ${childName}`);
        continue;
      }
      drift++;
      if (CHECK_ONLY) {
        log(`DRIFT translation missing: ${childName}`);
        continue;
      }
      const res = await api('POST', '/api/emails/new', childPayload);
      log(`  + ${childName} (${res?.email?.id})`);
    }
  }
  return { ids, drift };
}

/**
 * Turn the symbolic references in a campaign into the ids Mautic wants.
 *
 * The declarations name things; Mautic addresses them by id, and every id differs between
 * instances. Resolving here — rather than storing ids in the declarations — is what makes the same
 * file apply to a fresh instance, and what keeps a campaign diff readable.
 *
 * An unresolved name THROWS. Mautic would accept the campaign with a null reference and simply
 * never fire that step: a double-opt-in that sends nothing, reporting no error anywhere.
 */
function resolveCampaign(campaign, lookups, eventIds = {}) {
  const need = (kind, name) => {
    const id = lookups[kind]?.[name];
    if (id == null) {
      throw new Error(`campaign ${campaign.name}: no ${kind} named "${name}"`);
    }
    return id;
  };

  const events = campaign.events.map((e) => {
    const props = { ...e.properties };
    if (e.type === 'email.send') props.email = need('emails', props.email);
    if (e.type === 'page.pagehit') props.pages = (props.pages || []).map((n) => need('pages', n));
    if (e.type === 'lead.changelist') {
      props.addToLists = (props.addToLists || []).map((n) => need('segments', n));
      props.removeFromLists = (props.removeFromLists || []).map((n) => need('segments', n));
    }
    if (e.type === 'stage.change') props.stage = need('stages', props.stage);
    if (e.type === 'form.submit') props.forms = (props.forms || []).map((n) => need('forms', n));
    // An event that already exists is sent under its LIVE numeric id, and its parent/children
    // with it. A declared id (`send_confirm`) makes Mautic delete the old row and insert a new one,
    // and every contact's progress is logged against the OLD id — so each provision would orphan
    // the scheduled steps of everyone mid-campaign. Verified on Mautic 7: numeric ids update in place.
    const id = (x) => (x == null ? x : (eventIds[x] ?? x));
    return {
      ...e,
      id: id(e.id),
      parent: id(e.parent),
      children: (e.children || []).map(id),
      // The API expects the key on interval/immediate events too, as null.
      triggerDate: e.triggerDate ?? null,
      properties: props,
    };
  });

  const canvasSettings =
    campaign.canvasSettings === undefined
      ? undefined
      : JSON.parse(JSON.stringify(campaign.canvasSettings), (key, value) =>
          (key === 'id' || key === 'sourceId' || key === 'targetId') && eventIds[value] != null
            ? eventIds[value]
            : value
        );

  return {
    name: campaign.name,
    description: campaign.description,
    isPublished: campaign.isPublished !== false,
    lists: (campaign.lists || []).map((n) => ({ id: need('segments', n) })),
    forms: (campaign.forms || []).map((n) => ({ id: need('forms', n) })),
    events,
    canvasSettings,
    ...(campaign.category ? { category: need('categories', campaign.category) } : {}),
    ...(campaign.projects ? { projects: campaign.projects } : {}),
  };
}

/**
 * Declared event id → live numeric id, matched by event NAME within the campaign.
 *
 * Names are the only stable key: Mautic never stores the declared id. So a duplicate name inside
 * one campaign is refused — two events sharing one would silently swap their contact history.
 */
function matchEvents(campaign, liveEvents) {
  const names = new Set();
  for (const e of campaign.events) {
    if (names.has(e.name)) {
      throw new Error(`campaign ${campaign.name}: two events are named "${e.name}"; event names must be unique`);
    }
    names.add(e.name);
  }
  const byName = new Map(liveEvents.map((e) => [e.name, e]));
  /** @type {Record<string, string>} */
  const ids = {};
  for (const e of campaign.events) {
    const live = byName.get(e.name);
    if (live) ids[e.id] = String(live.id);
  }
  const removed = liveEvents.filter((e) => !names.has(e.name)).map((e) => e.name);
  const added = campaign.events.filter((e) => !byName.has(e.name)).map((e) => e.name);
  return { ids, removed, added };
}

/** Campaigns, matched by name. Events matched by name inside each — see matchEvents. */
async function ensureCampaigns(lookups) {
  const existing = await api('GET', '/api/campaigns?limit=500');
  const live = new Map(Object.values(existing?.campaigns || {}).map((c) => [c.name, c]));
  let drift = 0;

  for (const campaign of CAMPAIGNS) {
    const found = live.get(campaign.name);
    if (!found) {
      drift++;
      if (CHECK_ONLY) {
        log(`DRIFT campaign missing: ${campaign.name}`);
        continue;
      }
      const res = await api('POST', '/api/campaigns/new', resolveCampaign(campaign, lookups));
      log(`+ campaign ${campaign.name} (${res?.campaign?.id})`);
      continue;
    }

    // The list endpoint may omit events; the single read is the one that carries them.
    const detail = await api('GET', `/api/campaigns/${found.id}`);
    const liveEvents = Object.values(detail?.campaign?.events || found.events || {});
    const { ids, removed, added } = matchEvents(campaign, liveEvents);
    if (removed.length || added.length) {
      drift++;
      // A REMOVED event is the dangerous half: contacts waiting on it lose that step for good.
      if (removed.length) {
        log(`${CHECK_ONLY ? 'DRIFT' : '!'} campaign ${campaign.name}: removes event(s) ${removed.map((n) => `"${n}"`).join(', ')} — contacts scheduled on them lose that step`);
      }
      if (added.length) {
        log(`${CHECK_ONLY ? 'DRIFT' : '~'} campaign ${campaign.name}: adds event(s) ${added.map((n) => `"${n}"`).join(', ')}`);
      }
    }
    if (CHECK_ONLY) {
      if (!removed.length && !added.length) log(`= campaign ${campaign.name}`);
      continue;
    }
    // PUT, NEVER PATCH. Mautic's PATCH MERGES the events array — it appends what you send to what
    // is already there, so each re-provision grows the campaign by one full copy of itself (three
    // events became fifteen over five runs, and a subscriber got the confirmation email five
    // times). PUT replaces the list, which is safe only because existing events keep their ids.
    await api('PUT', `/api/campaigns/${found.id}/edit`, resolveCampaign(campaign, lookups, ids));
    log(`~ campaign ${campaign.name} updated`);
  }
  return drift;
}

/**
 * Webhooks. Matched by name; skipped entirely when the shared secret is unset.
 *
 * The secret lives in the URL because Mautic sends no custom headers, so the URL IS the
 * credential — never log it, and rotate it like a password. `webhookBaseUrl` is how MAUTIC
 * reaches the receiver, which across a compose network is the SERVICE name, not the loopback
 * address a browser uses.
 */
async function ensureWebhooks() {
  const token = env.MAUTIC_WEBHOOK_TOKEN || '';
  const base = (ctx.webhookBaseUrl || '').replace(/\/+$/, '');
  if (!token || WEBHOOKS.length === 0) {
    // Not an error, and deliberately not a drift item: running without the inbound direction is a
    // supported state, and creating a webhook whose every call is refused would have Mautic
    // disable it on its own — leaving a webhook that exists, is switched off, and reports nothing.
    if (WEBHOOKS.length) log('~ webhooks skipped (MAUTIC_WEBHOOK_TOKEN unset)');
    return 0;
  }
  if (!base) throw new Error('webhooks declared but no webhookBaseUrl in the brand config');

  const existing = await api('GET', '/api/hooks?limit=200');
  const live = new Map(Object.values(existing?.hooks || {}).map((h) => [h.name, h]));
  let drift = 0;

  for (const hook of WEBHOOKS) {
    const payload = {
      name: hook.name,
      description: hook.description,
      webhookUrl: `${base}${hook.path}?token=${encodeURIComponent(token)}`,
      isPublished: hook.isPublished !== false,
      triggers: hook.triggers,
    };
    const found = live.get(hook.name);
    if (found) {
      // A DEACTIVATED webhook is drift, not a preference. Mautic switches one off by itself after
      // 100 consecutive failures — which is the correct behaviour and completely silent: the
      // inbound direction stops, every unsubscribe after that point is lost, and the only trace is
      // a line in Mautic's own log. Report it, and re-publish on apply.
      if (!found.isPublished) {
        drift++;
        if (CHECK_ONLY) {
          log(
            `DRIFT webhook ${hook.name} is DEACTIVATED — Mautic disables one after 100 failures; check its URL is reachable`
          );
          continue;
        }
        log(`~ webhook ${hook.name} was deactivated — re-publishing`);
      }
      // The URL carries the secret, so an existing webhook is always rewritten rather than
      // compared: a rotated token has to reach Mautic, and comparing would mean reading the
      // secret back out and printing it on a mismatch.
      if (!CHECK_ONLY) await api('PUT', `/api/hooks/${found.id}/edit`, payload);
      if (found.isPublished) log(`= webhook ${hook.name}`);
      continue;
    }
    drift++;
    if (CHECK_ONLY) {
      log(`DRIFT webhook missing: ${hook.name}`);
      continue;
    }
    const res = await api('POST', '/api/hooks/new', payload);
    log(`+ webhook ${hook.name} (${res?.hook?.id})`);
  }
  return drift;
}

  // ---------------------------------------------------------------------------- run
  log(`Mautic: ${BASE} as ${USER}${CHECK_ONLY ? ' (check only)' : ''}`);

  // Before anything is written. An unresolved token is not an error in Mautic — it renders as the
  // literal string `{global:signoff}` in the body, and the first person to see it is a subscriber
  // reading mail that cannot be recalled.
  // Translations are checked alongside the originals: a translated body that drops
  // `{page:confirm-subscription}` is a confirmation email with no confirm link, and one that
  // invents a token ships it to the reader as literal text.
  const translated = Object.entries(EMAIL_TRANSLATIONS).flatMap(([name, langs]) =>
    Object.entries(langs).map(([lang, copy]) => ({ ...copy, name: `${name} (${lang})` }))
  );
  const tokenProblems = checkTokens(EMAILS.concat(translated), {
    globals: GLOBALS,
    pages: PAGES.map((p) => p.alias),
    assets: ASSETS.map((a) => a.name),
    forms: FORMS.map((f) => f.alias),
  });
  if (tokenProblems.length) {
    throw new Error(`unresolved tokens:\n  ${tokenProblems.join('\n  ')}`);
  }

  // Order matters throughout: a segment cannot filter on a field or a tag that does not exist,
  // an email cannot link to a page that does not exist, and a campaign cannot reference either.
  const fieldDrift = await ensureFields();
  const categories = await ensureCategories();
  const tagDrift = await ensureTags();
  const stages = await ensureStages();
  const tagId = await ensureTag();
  const segmentDrift = await ensureSegments(tagId);
  const forms = await ensureForms(categories.ids);
  const assets = await lookupAssets();

  const pages = await ensurePages();
  const emails = await ensureEmails(pages.ids, assets.ids, categories.ids);

  // `lists`, not `segments` — Mautic's segment endpoint is /api/segments but its response wrapper
  // kept the older name. Reading the wrong key yields an empty map and every campaign reference
  // fails to resolve, which reads like a missing segment rather than a wrong key.
  const segments = await api('GET', '/api/segments?limit=500');
  const segmentIds = Object.fromEntries(
    Object.values(segments?.lists || {}).map((s) => [s.alias, s.id])
  );

  const campaignDrift = await ensureCampaigns({
    emails: emails.ids,
    pages: pages.ids,
    segments: segmentIds,
    forms: forms.ids,
    stages: stages.ids,
    categories: categories.ids,
  });

  const webhookDrift = await ensureWebhooks();

  const drift =
    fieldDrift +
    categories.drift +
    tagDrift +
    stages.drift +
    forms.drift +
    assets.drift +
    (tagId === null ? 1 : 0) +
    segmentDrift +
    pages.drift +
    emails.drift +
    campaignDrift +
    webhookDrift;

  if (CHECK_ONLY && drift) log(`\n${drift} item(s) missing — run without --check to apply.`);
  else log('done');
  return drift;
}
