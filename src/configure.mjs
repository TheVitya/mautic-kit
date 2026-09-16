/**
 * Apply Mautic's own PARAMETERS from code — the half of its configuration that has no REST API.
 *
 * provision creates contact fields, tags and segments over HTTP. It cannot touch the settings in
 * `config/local.php`, and those are the ones that decide whether the API answers at all and where
 * mail goes. They are written ONCE, by the installer, from whatever environment happened to exist
 * that day — so an instance installed before a config change keeps the old value forever and
 * nothing ever says so. That is not configuration, it is an accident that persisted.
 *
 * Idempotent: a parameter already holding the wanted value is left alone, and the cache is only
 * rebuilt when something actually changed.
 *
 * This runs INSIDE the container, not over HTTP — local.php lives in the config volume, and the
 * only thing that can safely rewrite a PHP array is PHP. See docker.mjs for how the container is
 * addressed.
 *
 * WHICH parameters is the brand's call (`parameters(env)` in its config); `baseParameters` is the
 * part every brand needs for this engine to work at all.
 */

import { execIn } from './docker.mjs';

/**
 * What every instance driven by this engine needs, whatever the brand.
 *
 * @param {Record<string, string|undefined>} env
 */
export function baseParameters(env) {
  return {
    // provision talks to Mautic over the REST API with Basic auth. Both off by default, and both
    // fail in a way that reads like bad credentials rather than a disabled API.
    api_enabled: 1,
    api_enable_basic_auth: 1,

    // The public base URL Mautic builds links from. Managed here as well as passed to the
    // installer, because the installer writes it ONCE and nothing else ever corrects it — and a
    // wrong value is not visible in Mautic: the UI works, sends go out, and every unsubscribe and
    // double-opt-in link in them points at a host the recipient cannot reach.
    site_url: env.MAUTIC_SITE_URL || `http://127.0.0.1:${env.MAUTIC_PORT || '8095'}`,
  };
}

const CONFIG_PATH = '/var/www/html/config/local.php';

/**
 * local.php values are Symfony container parameters, where `%name%` is a REFERENCE and a literal `%`
 * must be written `%%` — Mautic's own config UI stores a DSN user as `viktor%%40example.com`.
 * Declarations are written the way a human writes a URL (`%40`); written raw, `%40…%` would be read
 * as a parameter reference and break every page and console command. So: escape on compare and write.
 */
export function escapePercent(value) {
  if (typeof value === 'string') return value.replace(/%/g, '%%');
  if (Array.isArray(value)) return value.map(escapePercent);
  return value;
}

/**
 * `php` with warnings on STDERR. A container whose php.ini names a missing extension prints
 * "Warning: PHP Startup: Unable to load dynamic library …" on stdout before anything else, and the
 * JSON read below then fails to parse — on a perfectly healthy instance.
 */
const PHP = ['php', '-d', 'display_startup_errors=0', '-d', 'display_errors=stderr'];

async function inService(ctx, service, argv) {
  const { stdout } = await execIn(ctx, service, argv);
  return stdout;
}

/**
 * The live parameter values, as JSON.
 *
 * local.php ASSIGNS `$parameters`, it does not return — so `include` yields 1, not the array, and
 * reading its return value makes every setting look unset. Include for the side effect and read
 * the variable.
 */
async function readParameters(ctx) {
  const out = await inService(ctx, 'mautic', [
    ...PHP,
    '-r',
    `include '${CONFIG_PATH}'; echo json_encode($parameters);`,
  ]);
  return JSON.parse(out.trim());
}

/**
 * Merge and write back with PHP itself.
 *
 * `var_export` rather than hand-built PHP: the file is a PHP array literal, and the one thing
 * guaranteed to write a PHP array literal correctly — quoting, escaping, nesting — is PHP.
 *
 * The file is rewritten in the shape Mautic wrote it, `$parameters = array(…);` — this holds the
 * DB credentials of a running install, so a file that parses but assigns nothing takes the
 * instance down with it, and there is no copy to restore from.
 */
async function writeParameters(ctx, updates) {
  // base64 so the values cross the argv boundary untouched: a DSN carries `//`, `:` and often a
  // password, and quoting that through docker exec into `php -r` by hand is a bug waiting for the
  // first password with a quote in it.
  const payload = Buffer.from(JSON.stringify(updates)).toString('base64');
  const php = [
    `include '${CONFIG_PATH}';`,
    `$u = json_decode(base64_decode('${payload}'), true);`,
    '$p = array_merge($parameters, $u);',
    `file_put_contents('${CONFIG_PATH}', "<?php\\n\\$parameters = " . var_export($p, true) . ";\\n");`,
  ].join('');
  await inService(ctx, 'mautic', [...PHP, '-r', php]);
}

/**
 * Parameters are compiled into the container's cache, so a written value that is never rebuilt
 * is a change that appears to have worked and has not. Both roles need it: they run from the
 * same config volume but keep their own caches.
 */
async function rebuildCache(ctx, log) {
  for (const service of /** @type {const} */ (['mautic', 'mautic_cron'])) {
    await inService(ctx, service, [...PHP, '/var/www/html/bin/console', 'cache:clear', '--no-warmup']);
    log(`~ cache cleared (${service})`);
  }
}

/**
 * @param {object} ctx
 * @param {Record<string, string|undefined>} ctx.env
 * @param {Record<string, unknown>} ctx.parameters  the full set to enforce
 * @param {boolean} [ctx.checkOnly]
 * @param {string[]} [ctx.composeFiles]
 * @param {string} [ctx.cwd]
 * @param {(msg: string) => void} [ctx.log]
 * @returns {Promise<number>} parameters that differed (applied unless checkOnly)
 */
export async function configure(ctx) {
  const { parameters, checkOnly = false, log = console.log } = ctx;
  const live = await readParameters(ctx);
  /** @type {Record<string, { from: unknown, to: unknown }>} */
  const drift = {};
  for (const [key, want] of Object.entries(parameters)) {
    // Loose compare: PHP writes an int 1 where the declaration says 1, but a value that came back
    // from JSON as "1" is the same setting. A strict compare would rewrite the file every run.
    //
    // Arrays are compared as JSON, not stringified: `String(['a','b'])` is `'a,b'`, which makes
    // `['a,b']` and `['a','b']` indistinguishable — and one of those is a hostname that does not
    // exist.
    // Booleans too: a UI-saved local.php holds `true` where the declaration says 1.
    const scalar = (v) => (v === true ? '1' : v === false ? '0' : String(v ?? ''));
    const same = Array.isArray(want)
      ? JSON.stringify(live[key] ?? []) === JSON.stringify(escapePercent(want))
      : scalar(live[key]) === scalar(escapePercent(want));
    if (!same) drift[key] = { from: live[key] ?? null, to: escapePercent(want) };
  }

  const keys = Object.keys(drift);
  if (keys.length === 0) {
    log(`= parameters ok (${Object.keys(parameters).length})`);
    return 0;
  }

  for (const k of keys) {
    // A DSN carries the relay password; the key names what drifted without printing the secret.
    // Only values that can carry one are hidden: `sync://` is a DSN with nothing to leak, and
    // redacting it would hide exactly the drift (queue vs inline) someone is looking for.
    const secret = /password|secret|token/i.test(k);
    const show = (v) => {
      if (secret && v) return '"<redacted>"';
      if (typeof v === 'string' && /:\/\/[^/\s]*@/.test(v)) {
        return JSON.stringify(v.replace(/(:\/\/[^:/@\s]*:)[^@\s]*@/, '$1<redacted>@'));
      }
      return JSON.stringify(v);
    };
    log(`${checkOnly ? 'DRIFT' : '~'} ${k}: ${show(drift[k].from)} -> ${show(drift[k].to)}`);
  }
  if (checkOnly) return keys.length;

  await writeParameters(ctx, Object.fromEntries(keys.map((k) => [k, escapePercent(parameters[k])])));
  await rebuildCache(ctx, log);
  log('done');
  return keys.length;
}
