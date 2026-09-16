// Public types for the JS entry point. Hand-written because consumers typecheck with `checkJs`, and
// TypeScript does not read JSDoc out of a package's .mjs files (maxNodeModuleJsDepth is 0).
import type {
  MauticCampaign,
  MauticEmail,
  MauticEmailTranslations,
  MauticField,
  MauticPage,
  MauticSegment,
} from './types.d.mts';

export type Env = Record<string, string | undefined>;
export type Log = (msg: string) => void;

export type MauticWebhook = {
  name: string;
  description?: string;
  /** Appended to the brand's webhookBaseUrl; the shared token is added as `?token=`. */
  path: string;
  isPublished?: boolean;
  triggers: string[];
};

export type Declarations = {
  fields?: MauticField[];
  /** The tag every subscriber carries; its id is passed to `segments`. Omit for no tag. */
  subscriberTag?: string;
  segments?: (tagId: number | undefined) => MauticSegment[];
  pages?: MauticPage[];
  emails?: MauticEmail[];
  emailTranslations?: MauticEmailTranslations;
  /** `brand_name` and `brand_url` feed the email footer. */
  globals?: Record<string, string>;
  campaigns?: MauticCampaign[];
  webhooks?: MauticWebhook[];
  footerLabels?: { unsubscribe?: string; webview?: string };
};

export type BrandConfig = {
  /** dotenv file, resolved against the config module's directory. */
  envFile?: string;
  /** Where compose files resolve; defaults to the config module's directory. */
  cwd?: string;
  /** For `docker compose -f … exec` when containers are not addressed by name. */
  composeFiles?: string[];
  declarations: Declarations;
  /** The full local.php parameter set to enforce; defaults to baseParameters(env). */
  parameters?: (env: Env) => Record<string, unknown>;
  /** How MAUTIC reaches the webhook receiver. */
  webhookBaseUrl?: (env: Env) => string;
  /** Printed after a field is recreated (and therefore blank). */
  resyncHint?: string;
};

type Ctx = { env: Env; composeFiles?: string[]; cwd?: string; log?: Log };

export function loadEnv(file?: string): Env;
export function httpBase(env: Env): string;
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
export function provision(
  ctx: Ctx & {
    declarations: Declarations;
    checkOnly?: boolean;
    resyncHint?: string;
    webhookBaseUrl?: string;
  }
): Promise<number>;
export function run(
  step: 'install' | 'configure' | 'provision',
  config: BrandConfig,
  opts?: { argv?: string[]; configDir?: string }
): Promise<number>;
export function loadConfig(path: string): Promise<{ config: BrandConfig; configDir: string }>;

export type RenderOpts = {
  globals?: Record<string, string>;
  assetIds?: Record<string, number>;
  pageIds?: Record<string, number>;
  brandName?: string;
  brandUrl?: string;
  footerLabels?: { unsubscribe?: string; webview?: string };
};
export function renderEmail(
  email: { body: string; preview?: string; language?: string },
  opts?: RenderOpts
): { html: string; plainText: string };
export function textToHtml(text: string): string;
export function textToPlain(text: string, opts?: RenderOpts): string;
export function wrapHtml(
  bodyHtml: string,
  opts?: {
    previewText?: string;
    brandName?: string;
    brandUrl?: string;
    lang?: string;
    footerLabels?: { unsubscribe?: string; webview?: string };
  }
): string;
export const MAUTIC_TOKEN_RE: RegExp;
export function resolveTokens(text: string, opts?: RenderOpts & { plain?: boolean }): string;
export function referencedTokens(text: string): Array<{ kind: string; name: string }>;
export function checkTokens(
  emails: Array<{ name: string; subject?: string; preview?: string; body?: string }>,
  known?: { globals?: Record<string, string>; assets?: string[]; forms?: string[]; pages?: string[] }
): string[];

export type * from './types.d.mts';
