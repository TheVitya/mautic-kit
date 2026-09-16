/**
 * How install and configure run Mautic's console, and how every step reaches Mautic over HTTP.
 * Both differ by where the tool runs, and both are silent when wrong — a `compose exec` against
 * the wrong project reports "no such service", and an HTTP probe against an unreachable port
 * reports "not installed", which is the answer that makes install DROP a populated database.
 *
 * Three cases, in the order they were needed:
 *
 *   compose       the brand passes `composeFiles`; the console is reached with
 *                 `docker compose -f … exec <service>`, and HTTP on the loopback port.
 *   containers    a managed host runs compose under ITS project name from ITS generated file, so
 *                 `compose -f … exec mautic` resolves no service even though the container is
 *                 running two feet away. Set MAUTIC_CONTAINER / MAUTIC_CRON_CONTAINER and the
 *                 containers are addressed directly.
 *   MAUTIC_EXEC=local
 *                 already INSIDE the container — a self-provisioning image, where there is no
 *                 docker to exec through and the console is simply on PATH.
 *
 * MAUTIC_DOCKER swaps the binary (e.g. `podman`), for hosts that run Mautic under podman.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * `-u www-data`: exec defaults to ROOT, and anything root creates under var/cache or config is
 * unreadable to Apache afterwards — 500 on every request, surviving a restart because the files
 * do. In local mode the caller is already www-data for the same reason.
 *
 * @param {{ env: Record<string, string|undefined>, composeFiles?: string[] }} ctx
 * @param {'mautic' | 'mautic_cron'} service
 * @param {string[]} argv
 */
export function dockerArgv(ctx, service, argv) {
  const { env, composeFiles = [] } = ctx;
  // Both or neither. Set one and configure writes local.php through the container, then fails
  // clearing the OTHER role's cache — leaving a parameter that is written, uncompiled and
  // therefore not in effect, which is the one state that looks like it worked. Names are not
  // derived from each other because a stack suffix is a suffix, not an infix.
  if (!env.MAUTIC_CONTAINER !== !env.MAUTIC_CRON_CONTAINER) {
    throw new Error(
      'Set BOTH MAUTIC_CONTAINER and MAUTIC_CRON_CONTAINER, or neither. Only one means the web role is addressed directly and the cron role through compose, and the two do not resolve to the same stack.'
    );
  }
  const container = service === 'mautic_cron' ? env.MAUTIC_CRON_CONTAINER : env.MAUTIC_CONTAINER;
  if (!container && composeFiles.length === 0) {
    // Without either there is no address at all; `docker exec mautic` would hit whatever
    // container happens to carry that name on this machine.
    throw new Error(
      'No way to reach the Mautic console: set MAUTIC_CONTAINER + MAUTIC_CRON_CONTAINER, MAUTIC_EXEC=local, or pass composeFiles in the brand config.'
    );
  }
  const compose = composeFiles.flatMap((f) => ['-f', f]);
  const head = container ? ['exec'] : ['compose', ...compose, 'exec'];
  return [...head, '-T', '-u', 'www-data', container || service, ...argv];
}

/**
 * Run `argv` against a Mautic install, wherever this tool happens to be running.
 *
 * @param {{ env: Record<string, string|undefined>, composeFiles?: string[], cwd?: string }} ctx
 * @param {'mautic' | 'mautic_cron'} service
 * @param {string[]} argv
 */
export function execIn(ctx, service, argv, opts = {}) {
  const base = { maxBuffer: 16 * 1024 * 1024, cwd: ctx.cwd, ...opts };
  // One container holds both roles there, so a per-role address would name the same filesystem
  // twice — `service` is ignored rather than mapped.
  if (ctx.env.MAUTIC_EXEC === 'local') {
    const [cmd, ...rest] = argv;
    return execFileAsync(cmd, rest, base);
  }
  return execFileAsync(ctx.env.MAUTIC_DOCKER || 'docker', dockerArgv(ctx, service, argv), base);
}

/**
 * The URL these tools reach Mautic on. NOT `site_url`: this one is how the CALLER gets there
 * (loopback in dev, the public hostname from an operator's machine, 127.0.0.1:80 from inside the
 * image), while site_url is what Mautic writes into mail. They coincide only by accident.
 *
 * @param {Record<string, string|undefined>} env
 */
export function httpBase(env) {
  const fallback =
    env.MAUTIC_EXEC === 'local'
      ? 'http://127.0.0.1'
      : `http://127.0.0.1:${env.MAUTIC_PORT || 8095}`;
  return (env.MAUTIC_PROVISION_URL || fallback).replace(/\/+$/, '');
}
