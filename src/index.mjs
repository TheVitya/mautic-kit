/**
 * mautic-kit — install and configure a self-hosted Mautic: the steps that need the container's
 * console. Everything over Mautic's REST API (fields, segments, emails, campaigns, webhooks, sends)
 * is growth-kit's `crm` and `sends`.
 *
 * Dependency-free ESM so a brand runs it with plain `node`, no build step and no loader.
 */

import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { baseParameters, configure } from './configure.mjs';
import { loadEnv } from './env.mjs';
import { install } from './install.mjs';

export { baseParameters, configure } from './configure.mjs';
export { dockerArgv, execIn, httpBase, shellQuote } from './docker.mjs';
export { loadEnv } from './env.mjs';
export { install, instanceState } from './install.mjs';

/**
 * @typedef {object} BrandConfig
 * @property {string} [envFile]         dotenv file, resolved against the config module's directory
 * @property {string} [cwd]             where compose files resolve; defaults to the config's directory
 * @property {string[]} [composeFiles]  for `docker compose -f … exec` when containers aren't named
 * @property {(env: Record<string, string|undefined>) => Record<string, unknown>} [parameters]
 *           the full local.php parameter set; defaults to baseParameters(env)
 */

/**
 * Run one step for a brand config, as a CLI would: flags from argv, exit code from the result.
 *
 * Exit codes: 0 ok · 1 failure or drift under --check · 2 misconfiguration.
 *
 * @param {'install' | 'configure'} step
 * @param {BrandConfig} config
 * @param {{ argv?: string[], configDir?: string }} [opts]
 */
export async function run(step, config, { argv = process.argv.slice(2), configDir = process.cwd() } = {}) {
  const env = loadEnv(config.envFile ? resolve(configDir, config.envFile) : undefined);
  const cwd = resolve(configDir, config.cwd || '.');
  const base = { env, cwd, composeFiles: config.composeFiles || [] };
  const checkOnly = argv.includes('--check');
  try {
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
    if (step === 'provision' || step === 'validate') {
      console.error(`${step} moved to growth-kit: \`growth-kit crm ${step === 'provision' ? 'apply' : 'validate'}\` (mautic-kit v0.4.2 is the last with it)`);
      return 2;
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
