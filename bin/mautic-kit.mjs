#!/usr/bin/env node
/**
 *   mautic-kit install   --config ./mautic.config.mjs [--force | --if-needed]
 *   mautic-kit configure --config ./mautic.config.mjs [--check]
 *   mautic-kit provision --config ./mautic.config.mjs [--check]
 */
import process from 'node:process';
import { loadConfig, run } from '../src/index.mjs';

const [step, ...rest] = process.argv.slice(2);
const i = rest.indexOf('--config');
const configPath = i >= 0 ? rest[i + 1] : process.env.MAUTIC_KIT_CONFIG;

if (!step || !configPath) {
  console.error('usage: mautic-kit <install|configure|provision> --config <brand config .mjs> [--check|--force|--if-needed]');
  process.exit(2);
}

const { config, configDir } = await loadConfig(configPath);
process.exitCode = await run(/** @type {any} */ (step), config, { argv: rest, configDir });
