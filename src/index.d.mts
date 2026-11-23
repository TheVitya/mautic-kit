// Public types for the JS entry point. Hand-written because consumers typecheck with `checkJs`, and
// TypeScript does not read JSDoc out of a package's .mjs files (maxNodeModuleJsDepth is 0).

export type Env = Record<string, string | undefined>;
export type Log = (msg: string) => void;

export type BrandConfig = {
  /** dotenv file, resolved against the config module's directory. */
  envFile?: string;
  /** Where compose files resolve; defaults to the config module's directory. */
  cwd?: string;
  /** For `docker compose -f … exec` when containers are not addressed by name. */
  composeFiles?: string[];
  /** The full local.php parameter set to enforce; defaults to baseParameters(env). */
  parameters?: (env: Env) => Record<string, unknown>;
};

type Ctx = { env: Env; composeFiles?: string[]; cwd?: string; log?: Log };

export function loadEnv(file?: string): Env;
export function httpBase(env: Env): string;
export function shellQuote(word: string): string;
export function dockerArgv(ctx: Ctx, service: 'mautic' | 'mautic_cron', argv: string[]): string[];
export function execIn(
  ctx: Ctx,
  service: 'mautic' | 'mautic_cron',
  argv: string[],
  opts?: object
): Promise<{ stdout: string; stderr: string }>;
export function instanceState(ctx: Ctx): Promise<'installed' | 'fresh' | 'unreachable'>;
export function install(ctx: Ctx & { force?: boolean; ifNeeded?: boolean }): Promise<void>;
export function baseParameters(env: Env): Record<string, unknown>;
export function configure(
  ctx: Ctx & { parameters: Record<string, unknown>; checkOnly?: boolean }
): Promise<number>;
export function run(
  step: 'install' | 'configure',
  config: BrandConfig,
  opts?: { argv?: string[]; configDir?: string }
): Promise<number>;
export function loadConfig(path: string): Promise<{ config: BrandConfig; configDir: string }>;
