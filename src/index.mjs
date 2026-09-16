/**
 * mautic-kit — install, configure and provision Mautic from a brand's declarations.
 *
 * The engine is shared; WHAT each brand's Mautic holds stays in that brand's repo, as a config
 * module (see README). Everything here is dependency-free ESM so a brand runs it with plain
 * `node`, no build step and no loader.
 */

import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { baseParameters, configure } from './configure.mjs';
import { loadEnv } from './env.mjs';
import { install } from './install.mjs';
import { provision } from './provision.mjs';
import { checkTokens } from './tokens.mjs';

export { baseParameters, configure } from './configure.mjs';
export { dockerArgv, execIn, httpBase, shellQuote } from './docker.mjs';
export { loadEnv } from './env.mjs';
export { renderEmail, textToHtml, textToPlain, wrapHtml } from './html.mjs';
export { install, instanceState } from './install.mjs';
export { provision } from './provision.mjs';
export { checkTokens, MAUTIC_TOKEN_RE, referencedTokens, resolveTokens } from './tokens.mjs';

/**
 * @typedef {object} Declarations
 * @property {import('./types.d.mts').MauticField[]} [fields]
 * @property {string} [subscriberTag]
 * @property {(tagId: number | undefined) => import('./types.d.mts').MauticSegment[]} [segments]
 * @property {import('./types.d.mts').MauticPage[]} [pages]
 * @property {import('./types.d.mts').MauticEmail[]} [emails]
 * @property {import('./types.d.mts').MauticEmailTranslations} [emailTranslations]
 * @property {Record<string, string>} [globals]  `brand_name` / `brand_url` feed the email footer
 * @property {import('./types.d.mts').MauticCampaign[]} [campaigns]
 * @property {Array<{ name: string, description?: string, path: string, isPublished?: boolean, triggers: string[] }>} [webhooks]
 * @property {{ unsubscribe?: string, webview?: string }} [footerLabels]
 */

/**
 * @typedef {object} BrandConfig
 * @property {string} [envFile]         dotenv file, resolved against the config module's directory
 * @property {string} [cwd]             where compose files resolve; defaults to the config's directory
 * @property {string[]} [composeFiles]  for `docker compose -f … exec` when containers aren't named
 * @property {Declarations} declarations
 * @property {(env: Record<string, string|undefined>) => Record<string, unknown>} [parameters]
 *           the full local.php parameter set; defaults to baseParameters(env)
 * @property {(env: Record<string, string|undefined>) => string} [webhookBaseUrl]
 * @property {string} [resyncHint]
 */

/**
 * Offline: every `{global|asset|form|page:…}` token in every email (and translation) points at
 * something declared. The same check provision runs first, without a Mautic to talk to — for a
 * build step or a pre-commit hook.
 *
 * @param {Declarations} D
 * @returns {string[]} problems; empty means clean
 */
export function validate(D) {
  const translated = Object.entries(D.emailTranslations || {}).flatMap(([name, langs]) =>
    Object.entries(langs).map(([lang, copy]) => ({ ...copy, name: `${name} (${lang})` }))
  );
  return checkTokens((D.emails || []).concat(translated), {
    globals: D.globals || {},
    pages: (D.pages || []).map((p) => p.alias),
    assets: (D.assets || []).map((a) => a.name),
    forms: (D.forms || []).map((f) => f.alias),
  });
}

/**
 * Run one step for a brand config, as a CLI would: flags from argv, exit code from the result.
 *
 * Exit codes: 0 ok · 1 failure or drift under --check · 2 misconfiguration.
 *
 * @param {'install' | 'configure' | 'provision' | 'validate'} step
 * @param {BrandConfig} config
 * @param {{ argv?: string[], configDir?: string }} [opts]
 */
export async function run(step, config, { argv = process.argv.slice(2), configDir = process.cwd() } = {}) {
  const env = loadEnv(config.envFile ? resolve(configDir, config.envFile) : undefined);
  const cwd = resolve(configDir, config.cwd || '.');
  const base = { env, cwd, composeFiles: config.composeFiles || [] };
  const checkOnly = argv.includes('--check');
  try {
    if (step === 'validate') {
      const problems = validate(config.declarations);
      for (const p of problems) console.error(`✗ ${p}`);
      if (!problems.length) console.log('= tokens ok');
      return problems.length ? 1 : 0;
    }
    if (step === 'install') {
      await install({
        ...base,
        force: argv.includes('--force'),
        ifNeeded: argv.includes('--if-needed'),
      });
      return 0;
    }
    if (step === 'configure') {
      const parameters = config.parameters ? config.parameters(env) : baseParameters(env);
      const drift = await configure({ ...base, parameters, checkOnly });
      return checkOnly && drift ? 1 : 0;
    }
    if (step === 'provision') {
      const drift = await provision({
        ...base,
        declarations: config.declarations,
        checkOnly,
        resyncHint: config.resyncHint,
        webhookBaseUrl: config.webhookBaseUrl ? config.webhookBaseUrl(env) : undefined,
      });
      return checkOnly && drift ? 1 : 0;
    }
    console.error(`unknown step: ${step}`);
    return 2;
  } catch (err) {
    console.error(String(/** @type {any} */ (err)?.message || err));
    return 1;
  }
}

/** Load a brand config module by path (for the bin). */
export async function loadConfig(path) {
  const abs = resolve(path);
  const mod = await import(pathToFileURL(abs).href);
  return { config: /** @type {BrandConfig} */ (mod.default), configDir: dirname(abs) };
}
