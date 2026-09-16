// Unit tests for the email renderer — `src/html.mjs` + `src/tokens.mjs`.
// Run with `npm test`.
//
// Everything here fails in the same place: a delivered message. There is no staging inbox between
// this code and a subscriber, no error, and no way to recall what went out. So the cases below are
// the ones where the output is WRONG rather than merely ugly — a nested anchor, a token rendered
// as literal text, a missing unsubscribe link.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderEmail, textToHtml, textToPlain, wrapHtml } from '../src/html.mjs';
import { checkTokens, referencedTokens, resolveTokens } from '../src/tokens.mjs';

const BRAND = { brandName: 'Basket index', brandUrl: 'https://example.test' };

// ------------------------------------------------------------------ text → html

test('a blank line separates paragraphs; a single newline is a line break', () => {
  const html = textToHtml('One\ntwo\n\nThree');
  // In email copy a line break is nearly always meant literally — a name, an address, a signoff.
  assert.match(html, /<p style="[^"]*">One<br>\ntwo<\/p>/);
  assert.match(html, /<p style="[^"]*">Three<\/p>/);
});

test('bullets and numbered items become real lists', () => {
  const html = textToHtml('- one\n- two');
  assert.match(html, /<ul style="[^"]*">/);
  assert.equal((html.match(/<li /g) || []).length, 2);
  assert.match(html, /<\/ul>/);

  const ordered = textToHtml('1. first\n2. second');
  assert.match(ordered, /<ol style="[^"]*">/);
  assert.match(ordered, /<\/ol>/);
});

test('a list switching kind closes the first rather than nesting', () => {
  const html = textToHtml('- bullet\n1. numbered');
  // `</ul>` must appear before `<ol` — an unclosed list swallows the rest of the email in most
  // clients, which is a blank message rather than a formatting slip.
  assert.ok(html.indexOf('</ul>') < html.indexOf('<ol'));
});

test('every element carries inline styles', () => {
  // Gmail strips <style> blocks outright. A rule that is not on the element does not exist.
  const html = textToHtml('para\n\n- item');
  assert.ok(!/<p>/.test(html));
  assert.ok(!/<li>/.test(html));
});

test('a bare URL becomes a link', () => {
  assert.match(
    textToHtml('see https://example.test/x now'),
    /<a href="https:\/\/example\.test\/x"/
  );
});

// ------------------------------------------------------------------ tokens

test('a global with a display becomes a button, with || an inline link', () => {
  const globals = { guide: 'https://example.test/guide' };
  assert.match(
    resolveTokens('{global:guide|Read it}', { globals }),
    /<a href="[^"]+" style="display:inline-block/
  );
  assert.match(
    resolveTokens('{global:guide||read it}', { globals }),
    /text-decoration:underline;">read it<\/a>/
  );
  // Bare: the value itself, for a URL used inside a sentence or an attribute.
  assert.equal(resolveTokens('{global:guide}', { globals }), 'https://example.test/guide');
});

test('an asset resolves to assetlink, which Mautic expands at send time', () => {
  const out = resolveTokens('{asset:handbook|Download}', { assetIds: { handbook: 7 } });
  // NOT a hardcoded URL: `{assetlink=N}` is what keeps the download tracked and the file movable.
  assert.match(out, /href="\{assetlink=7\}"/);
});

test("Mautic's own tokens pass through untouched", () => {
  const text = 'Hi {contactfield=firstname|there}, {unsubscribe_url}';
  // Rewriting one of these would put a literal string in a delivered email — Mautic, not this
  // code, resolves them.
  assert.equal(resolveTokens(text, {}), text);
});

test('an unknown reference stays visible instead of vanishing', () => {
  // A link that silently disappears reads as a copy decision. `{global:typo}` in the body does
  // not — and checkTokens below is what stops it being sent at all.
  assert.equal(resolveTokens('{global:typo}', { globals: {} }), '{global:typo}');
});

test('a resolved link is not linkified a second time', () => {
  // THE ordering bug this pipeline is built around. Tokens are masked before bare URLs are
  // converted; without that, the href inside a resolved global becomes a second anchor nested in
  // the first — broken markup in some clients, a dead link in others, invisible until a real
  // message is opened.
  const html = textToHtml(
    resolveTokens('{global:guide|Read}', { globals: { guide: 'https://example.test/g' } })
  );
  assert.equal((html.match(/<a /g) || []).length, 1);
});

// ------------------------------------------------------------------ the plain part

test('the plain part carries the URL a link would have hidden', () => {
  const plain = textToPlain('{global:guide|Read it}', {
    globals: { guide: 'https://example.test/g' },
  });
  // "Read it" alone is useless without the href — in text/plain there is nothing to click.
  assert.equal(plain, 'Read it (https://example.test/g)');
  assert.ok(!plain.includes('<a '));
});

// ------------------------------------------------------------------ the wrapper

test('the wrapper carries an unsubscribe and a webview link', () => {
  const html = wrapHtml('<p>hi</p>', BRAND);
  // A bulk send without a working unsubscribe turns "not for me" into a spam complaint, and
  // enough of those cost the domain its reputation.
  assert.ok(html.includes('{unsubscribe_url}'));
  assert.ok(html.includes('{webview_url}'));
});

test('the preheader is hidden and padded', () => {
  const html = wrapHtml('<p>hi</p>', { ...BRAND, previewText: 'the preview' });
  assert.ok(html.includes('the preview'));
  // Without the padding the client fills the rest of the preview with whatever body text follows
  // — usually the greeting or the unsubscribe line.
  assert.ok(html.includes('&zwnj;&nbsp;'.repeat(20)));
});

test('no preview text means no empty preheader div', () => {
  assert.ok(!wrapHtml('<p>hi</p>', BRAND).includes('&zwnj;'));
});

test('the document is a 600px table layout, not a div', () => {
  const html = wrapHtml('<p>hi</p>', BRAND);
  // Outlook renders with Word. Flexbox and max-width on a div do not survive it.
  assert.match(html, /<table role="presentation" width="600"/);
});

// ------------------------------------------------------------------ end to end

test('rendering produces both parts, tokens resolved in each', () => {
  const email = {
    name: 'Confirm',
    subject: 'Confirm your subscription',
    preview: 'One click and you are in',
    body: 'Hi {contactfield=firstname|there},\n\n{global:confirm|Confirm}\n\n- a bullet',
  };
  const { html, plainText } = renderEmail(email, {
    ...BRAND,
    globals: { confirm: 'https://example.test/c' },
  });

  assert.match(html, /<a href="https:\/\/example\.test\/c"/);
  assert.match(html, /<li /);
  assert.ok(html.includes('{contactfield=firstname|there}'));
  assert.ok(plainText.includes('Confirm (https://example.test/c)'));
  assert.ok(!plainText.includes('<'));
});

// ------------------------------------------------------------------ the build-time gate

test('an undeclared reference is reported, a declared one is not', () => {
  const emails = [{ name: 'E1', subject: 'x', body: '{global:known} and {global:missing}' }];
  const problems = checkTokens(emails, { globals: { known: 'https://x.test' } });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /E1 \(body\).*\{global:missing\}/);
});

test('the subject is checked too, not only the body', () => {
  const emails = [{ name: 'E1', subject: '{global:nope}', body: 'fine' }];
  assert.equal(checkTokens(emails, { globals: {} }).length, 1);
});

test('references are extracted with their kind', () => {
  assert.deepEqual(referencedTokens('{global:a|X} {asset:b} {contactfield=c}'), [
    { kind: 'global', name: 'a' },
    { kind: 'asset', name: 'b' },
  ]);
});

// ------------------------------------------------------------------ regression: hyphens

test('a hyphenated alias resolves — Mautic names are slugs', () => {
  // `\w` excludes `-`, and every Mautic alias is a slug (`confirm-subscription`). This shipped
  // once: the resolver could not match the token, so the confirmation email went out carrying the
  // literal `{page:confirm-subscription|Confirm}` as body text, with no confirm link in it at
  // all. Mautic reported a successful send.
  const out = resolveTokens('{page:confirm-subscription|Confirm}', {
    pageIds: { 'confirm-subscription': 1 },
  });
  assert.match(out, /href="\{pagelink=1\}"/);

  assert.match(
    resolveTokens('{asset:my-guide|Get it}', { assetIds: { 'my-guide': 3 } }),
    /assetlink=3/
  );
  assert.equal(resolveTokens('{global:brand-name}', { globals: { 'brand-name': 'X' } }), 'X');
});

test('the checker and the resolver agree on what a name is', () => {
  // THE defect behind the bug above, and the reason both regexes are now built from one list of
  // kinds: the checker matched a hyphenated token, found the page declared, and passed — while
  // the resolver could not match it. A check that green-lights what the resolver cannot handle is
  // worse than no check, because it is trusted.
  const emails = [{ name: 'E', subject: 'x', body: '{page:confirm-subscription|Go}' }];
  assert.equal(checkTokens(emails, { pages: ['confirm-subscription'] }).length, 0);
  assert.equal(checkTokens(emails, { pages: [] }).length, 1);
});

test('the rendered confirmation email actually contains a link', () => {
  // The end-to-end assertion the bug slipped past: whatever the token layer does, the body must
  // come out with an anchor in it.
  const email = { name: 'c', subject: 's', body: 'click:\n\n{page:confirm-subscription|Confirm}' };
  const { html, plainText } = renderEmail(email, {
    ...BRAND,
    pageIds: { 'confirm-subscription': 1 },
  });
  assert.match(html, /<a href="\{pagelink=1\}"/);
  assert.ok(!html.includes('{page:'));
  assert.ok(!plainText.includes('{page:'));
});
