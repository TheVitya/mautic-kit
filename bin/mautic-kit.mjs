#!/usr/bin/env node
/**
 *   mautic-kit install   --config ./mautic.config.mjs [--force | --if-needed]
 *   mautic-kit configure --config ./mautic.config.mjs [--check]
 *
 * Provisioning and validation moved to growth-kit (`growth-kit crm validate|plan|apply`).
 */
import process from 'node:process';
import { loadConfig, run } from '../src/index.mjs';

const [step, ...rest] = process.argv.slice(2);
const i = rest.indexOf('--config');
const configPath = i >= 0 ? rest[i + 1] : process.env.MAUTIC_KIT_CONFIG;

if (!step || !configPath) {
  console.error('usage: mautic-kit <install|configure> --config <brand config .mjs> [--check|--force|--if-needed]');
  process.exit(2);
}

const { config, configDir } = await loadConfig(configPath);
process.exitCode = await run(/** @type {any} */ (step), config, { argv: rest, configDir });
