/**
 * Symbolic tokens in email copy, resolved to what Mautic actually understands.
 *
 * Copy is authored as plain text with `{global:app_download|Get the app}` rather than with URLs
 * and anchor tags inline. Two reasons, and the second is the one that bites:
 *
 *   1. A URL that appears in nine emails is changed in one place.
 *   2. A body with raw HTML in it stops being reviewable. The copy is the part a human has to
 *      read and approve, and it has to survive being read.
 *
 * Ported from the CUE/PHP pipeline in ~/Projects/okos-automatizalas (`php/src/TokenResolver.php`).
 * The `|` / `||` convention is inherited from there deliberately — it is arbitrary, but it is
 * already in use and already understood.
 *
 * MAUTIC'S OWN tokens (`{contactfield=firstname}`, `{unsubscribe_url}`, `{assetlink=3}`) pass
 * through untouched. They are resolved by Mautic at send time, and rewriting one here would
 * produce a literal string in a delivered email.
 */

/**
 * Mautic-native tokens that must survive every transformation in this pipeline.
 *
 * Exported because the HTML converter needs to MASK these before it linkifies bare URLs —
 * `{global:guide|Read it}` contains no URL, but `{assetlink=3}` and a resolved global do, and a
 * linkifier that runs over them produces an anchor nested inside an anchor. Which renders as
 * broken markup in some clients and as a dead link in others.
 */
// The kinds this pipeline resolves. Kept in ONE place because the resolver and the build-time
// check both need them, and the two disagreeing is not a visible failure: the check reads a
// token the resolver cannot match, passes, and the literal `{page:confirm-subscription|…}` ships
// in the body — with the call to action it names simply absent from the email.
const RESOLVED_KINDS = ['global', 'asset', 'form', 'page'];

// HYPHENS ARE PART OF A NAME. Mautic aliases are slugs (`confirm-subscription`,
// `basket-index-mailable`), and `\w` excludes `-` — the difference between a working confirmation
// link and an email that ships the token as text.
const NAME = '[\\w-]+';

export const MAUTIC_TOKEN_RE = new RegExp(
  '\\{(?:' +
    'dynamiccontent="[^"]+"|' +
    'assetlink=\\d+(?:\\|[^}]+)?|' +
    RESOLVED_KINDS.map((k) => `${k}:${NAME}(?:\\|\\|?[^}]+)?`).join('|') +
    '|pagelink=\\d+(?:\\|[^}]+)?|' +
    'unsubscribe_url|webview_url|' +
    'contactfield=[^}]+' +
    ')\\}',
  'g'
);

/** Tokens this pipeline resolves itself, for the build-time check that they all point somewhere. */
const RESOLVED_TOKEN_RE = new RegExp(`\\{(${RESOLVED_KINDS.join('|')}):([^|}]+)`, 'g');

const BTN_STYLE =
  'display:inline-block; padding:12px 22px; background-color:#111827; color:#ffffff; ' +
  'border-radius:8px; text-decoration:none; font-weight:600; text-align:center; margin:8px 0;';

const LINK_STYLE = 'color:#2563eb; text-decoration:underline;';

/**
 * An HTML call-to-action button. Inline styles only — every `<style>` block is stripped somewhere.
 * `styles.button` / `styles.link` are the brand's; the defaults are only a starting point.
 */
function button(href, text, styles) {
  return `<a href="${href}" style="${styles?.button || BTN_STYLE}">${text}</a>`;
}

/** An inline text link. */
function link(href, text, styles) {
  return `<a href="${href}" style="${styles?.link || LINK_STYLE}">${text}</a>`;
}

/**
 * Split `name|Display` / `name||Display` into its parts.
 *
 * `||` means INLINE (a link inside a sentence), a single `|` means a BUTTON, and neither means
 * the bare value. Checked in that order because `||` also contains `|`.
 */
function splitRef(content) {
  if (content.includes('||')) {
    const [name, display] = content.split('||', 2);
    return { name, display, inline: true };
  }
  if (content.includes('|')) {
    const [name, display] = content.split('|', 2);
    return { name, display, inline: false };
  }
  return { name: content, display: null, inline: false };
}

/**
 * Resolve `{global:…}` and `{asset:…}` against the declared values.
 *
 * @param text        the copy
 * @param globals     { name: url-or-value }
 * @param assetIds    { name: mauticAssetId }
 * @param plain       render for the text/plain part instead of HTML
 *
 * An UNKNOWN name is left as the literal token rather than dropped. That is deliberate: a missing
 * link silently vanishing from an email reads as a copy decision, while `{global:typo}` sitting in
 * the body is unmistakable — and `checkTokens` below is what stops either from being sent at all.
 */
export function resolveTokens(
  text,
  { globals = {}, assetIds = {}, pageIds = {}, plain = false, styles } = {}
) {
  return String(text).replace(MAUTIC_TOKEN_RE, (token) => {
    if (token.startsWith('{global:')) {
      const { name, display, inline } = splitRef(token.slice(8, -1));
      const url = globals[name];
      if (url == null) return token;
      if (!display) return url;
      if (plain) return `${display} (${url})`;
      return inline ? link(url, display, styles) : button(url, display, styles);
    }

    if (token.startsWith('{asset:')) {
      const { name, display, inline } = splitRef(token.slice(7, -1));
      const id = assetIds[name];
      if (id == null) return token;
      // Mautic resolves `{assetlink=N}` itself at send time, and doing it that way rather than
      // hardcoding a URL is what keeps the download tracked and the asset movable.
      const href = `{assetlink=${id}}`;
      if (!display) return href;
      if (plain) return `${display} (${href})`;
      return inline ? link(href, display, styles) : button(href, display, styles);
    }

    if (token.startsWith('{page:')) {
      const { name, display, inline } = splitRef(token.slice(6, -1));
      const id = pageIds[name];
      if (id == null) return token;
      // Same reasoning as assetlink: `{pagelink=N}` is what makes the click a tracked page hit,
      // and a tracked hit is the entire mechanism the double-opt-in campaign confirms on. A
      // hardcoded URL here would take the visitor to the same page and confirm nobody.
      const href = `{pagelink=${id}}`;
      if (!display) return href;
      if (plain) return `${display} (${href})`;
      return inline ? link(href, display, styles) : button(href, display, styles);
    }

    // form:/contactfield/unsubscribe_url — Mautic's, resolved at send time.
    return token;
  });
}

/**
 * Every `{global:…}` / `{asset:…}` / `{form:…}` / `{page:…}` reference in `text`, as
 * `{ kind, name }`.
 */
export function referencedTokens(text) {
  const out = [];
  for (const m of String(text).matchAll(RESOLVED_TOKEN_RE)) {
    out.push({ kind: m[1], name: m[2].split('|')[0] });
  }
  return out;
}

/**
 * Build-time check: every symbolic reference points at something declared.
 *
 * This is the whole reason the token layer is worth having a check at all. An unresolved token is
 * not an error anywhere in Mautic — it renders as the literal string `{global:signoff}` in the
 * body, and the first person to notice is a subscriber reading mail that cannot be recalled.
 *
 * @returns array of human-readable problems; empty means clean.
 */
export function checkTokens(emails, { globals = {}, assets = [], forms = [], pages = [] } = {}) {
  const known = {
    global: new Set(Object.keys(globals)),
    asset: new Set(assets),
    form: new Set(forms),
    page: new Set(pages),
  };
  const problems = [];
  for (const email of emails) {
    for (const field of ['subject', 'preview', 'body']) {
      const value = email[field];
      if (!value) continue;
      for (const { kind, name } of referencedTokens(value)) {
        if (!known[kind]?.has(name)) {
          problems.push(`${email.name} (${field}): {${kind}:${name}} is not declared`);
        }
      }
    }
  }
  return problems;
}
