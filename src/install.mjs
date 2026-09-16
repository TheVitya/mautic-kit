/**
 * Install Mautic from nothing, without the web installer.
 *
 * A Mautic that only exists because somebody clicked through five wizard screens cannot be
 * rebuilt, cannot be created in CI, and cannot be told apart from one that was clicked through
 * differently. This is the first of three steps that together make the instance reproducible:
 *
 *   install    the schema, the admin user, config/local.php
 *   configure  the parameters that have no REST API (API on, mailer)
 *   provision  contact fields, tags, segments, pages, emails, campaigns — over REST
 *
 * That is also the order they depend on: there is no API to provision against until the install
 * has run and configure has enabled it.
 *
 * DESTRUCTIVE. Installing over a populated database drops its tables. This refuses to run
 * against an instance that already answers, and `force` is the only way past that — so the
 * accident it prevents is "I ran the setup script on the wrong stack", which is unrecoverable
 * and has no undo.
 */

import { execIn, httpBase } from './docker.mjs';

/**
 * `installed` | `fresh` | `unreachable`. An installed Mautic answers its own login page; an
 * uninstalled one 500s on it.
 *
 * `unreachable` is a THIRD answer on purpose. A connection error is not evidence of a fresh
 * instance — it is evidence the probe went somewhere else, which on a managed host (wrong
 * MAUTIC_PROVISION_URL, tunnel down) is exactly when a populated database is one exit code away
 * from being dropped. The container has to be up for the exec below regardless, so refusing
 * costs nothing a real install needs.
 */
export async function instanceState(ctx) {
  const { env } = ctx;
  // Inside the image, ask the filesystem rather than the network. Apache and a bootstrap start
  // together under supervisord, so an HTTP probe races the web role and reports `unreachable` on
  // a perfectly healthy boot. local.php is what the upstream entrypoint's own
  // wait_for_mautic_install checks, and it is true the moment the install finished.
  if (env.MAUTIC_EXEC === 'local') {
    try {
      await execIn(ctx, 'mautic', [
        'php',
        '-r',
        `include '${env.MAUTIC_VOLUME_CONFIG || '/var/www/html/config'}/local.php'; exit(!empty($parameters['db_driver']) && !empty($parameters['site_url']) ? 0 : 1);`,
      ]);
      return 'installed';
    } catch {
      return 'fresh';
    }
  }
  try {
    const res = await fetch(`${httpBase(env)}/s/login`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    });
    return res.status < 500 ? 'installed' : 'fresh';
  } catch {
    return 'unreachable';
  }
}

/**
 * @param {object} ctx
 * @param {Record<string, string|undefined>} ctx.env
 * @param {string[]} [ctx.composeFiles]
 * @param {string} [ctx.cwd]
 * @param {boolean} [ctx.force]     install over an instance that answers — DROPS its tables
 * @param {boolean} [ctx.ifNeeded]  an existing install is success, not an error (boot-time use)
 * @param {(msg: string) => void} [ctx.log]
 */
export async function install(ctx) {
  const { env, force = false, ifNeeded = false, log = console.log } = ctx;
  const base = httpBase(env);
  // The URL Mautic believes it is served from. It is NOT the URL an app reaches it by over a
  // container network — this one goes into every link Mautic MAILS: the unsubscribe link, the
  // tracking pixel, every hosted page. A container hostname here produces mail whose unsubscribe
  // link resolves for nobody, and the only person who finds out is a recipient trying to opt out.
  //
  // Loopback is right for local dev, where the reader of a test mail is the developer whose
  // browser can reach it. Production must set this to the public hostname explicitly.
  const siteUrl = env.MAUTIC_SITE_URL || `http://127.0.0.1:${env.MAUTIC_PORT || 8095}`;
  const user = env.MAUTIC_API_USERNAME || 'admin';
  const pass = env.MAUTIC_API_PASSWORD || env.MAUTIC_ADMIN_PASSWORD || '';
  const email = env.MAUTIC_ADMIN_EMAIL || 'admin@example.test';

  if (!pass) {
    throw new Error('No admin password. Set MAUTIC_API_PASSWORD (or MAUTIC_ADMIN_PASSWORD).');
  }

  const state = await instanceState(ctx);
  if (state === 'installed' && ifNeeded) {
    log(`Mautic at ${base} is already installed — nothing to do.`);
    return;
  }
  if (state === 'installed' && !force) {
    throw new Error(
      `Mautic at ${base} is already installed and answering. Installing over it DROPS its tables, including every contact and every consent record. Re-run with --force only if that is genuinely what you want.`
    );
  }
  if (state === 'unreachable' && !force) {
    throw new Error(
      `Cannot reach Mautic at ${base}, so there is no way to tell an empty instance from a populated one — and installing over a populated one DROPS every contact. Point MAUTIC_PROVISION_URL at the instance you mean to install, or re-run with --force if you are certain it is empty.`
    );
  }

  log(`Installing Mautic (site_url ${siteUrl}) …`);
  try {
    const { stdout } = await execIn(ctx, 'mautic', [
      'php',
      '/var/www/html/bin/console',
      'mautic:install',
      siteUrl,
      '--force',
      '--no-interaction',
      '--db_driver=pdo_mysql',
      `--db_host=${env.MAUTIC_DB_HOST || 'mautic_db'}`,
      `--db_port=${env.MAUTIC_DB_PORT || 3306}`,
      `--db_name=${env.MAUTIC_DB_NAME || 'mautic'}`,
      `--db_user=${env.MAUTIC_DB_USER || 'mautic'}`,
      `--db_password=${env.MAUTIC_DB_PASSWORD || ''}`,
      `--admin_email=${email}`,
      `--admin_username=${user}`,
      `--admin_password=${pass}`,
      '--admin_firstname=Local',
      '--admin_lastname=Admin',
    ]);
    log(stdout.trim().split('\n').slice(-6).join('\n'));
  } catch (err) {
    // The installer prints its real complaint on stdout and exits non-zero with an empty message,
    // so both streams matter here — without stdout the failure reads as "command failed".
    const e = /** @type {any} */ (err);
    throw new Error(`${String(e.stdout || '')}\n${String(e.stderr || e.message || e)}`.trim());
  }
  log('\ndone — now run configure, then provision');
}
