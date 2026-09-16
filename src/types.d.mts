// The SHAPES a brand's Mautic declarations must have. Types only — deliberately no `declare const`.
//
// Declarations stay plain .mjs (or JSON) because the engine runs them with no flags and no build
// step; a .ts there would need a loader on every operator's machine. Brands point JSDoc `@type`
// annotations here (`import('mautic-kit/types').MauticField`).
//
// NEVER name a brand's file `declarations.d.mts` beside `declarations.mjs`: it becomes the ambient
// declaration, TypeScript drops the implementation from the program, and the .mjs is silently
// never checked. That already happened once — the field-type union said 'text' | 'boolean' while
// five fields were 'date', and `checkJs` did not catch it.

export type MauticFieldType = 'text' | 'boolean' | 'date';

export type MauticField = {
  alias: string;
  label: string;
  type: MauticFieldType;
  /** Required for `boolean` — Mautic refuses a boolean field that declares no labels. */
  properties?: { yes: string; no: string };
};

/**
 * Operators Mautic accepts. `empty` / `!empty` are the valueless pair — supplying a value with
 * them is rejected, and omitting one with any other operator is answered `filter: A value is
 * required`, which reads like a missing key rather than a missing value.
 */
export type MauticFilterOperator =
  | '='
  | '!='
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'like'
  | '!like'
  | 'in'
  | '!in'
  | 'empty'
  | '!empty'
  | 'startsWith'
  | 'endsWith'
  | 'contains';

export type MauticFilter = {
  glue: 'and' | 'or';
  /** A FIELD ALIAS, a core (Mautic-shipped) field, or `tags`. Anything else matches nobody, silently. */
  field: string;
  object: 'lead' | 'company';
  /**
   * MUST equal the declared type of `field`. Mautic's filters are typed: a relative date
   * comparison against a text field is a 400, and an equality against a date field that holds a
   * timestamp matches nothing. `tags` is the one filter type with no corresponding field type.
   */
  type: MauticFieldType | 'tags';
  operator: MauticFilterOperator;
  /** Absent on the valueless operators (`empty` / `!empty`), which carry no filter value. */
  properties?: { filter: unknown };
};

export type MauticSegment = {
  alias: string;
  name: string;
  description: string;
  /**
   * Present ONLY on a segment that carries service mail rather than marketing, and holding the
   * reason. Brands may use its absence to require a consent clause in the filters (banklens
   * enforces that in its conformance test).
   */
  service?: string;
  /** Omitted for a segment filled only by campaigns (`lead.changelist`), not by a query. */
  filters?: MauticFilter[];
  isPublished?: boolean;
  isGlobal?: boolean;
  /** Mautic 7 Project ids — instance-specific. */
  projects?: number[];
};

export type MauticCategory = {
  alias: string;
  title: string;
  bundle: 'email' | 'form' | 'asset' | 'stage' | 'campaign' | 'page' | 'segment';
  /** Hex without `#`. */
  color: string;
  isPublished?: boolean;
};

export type MauticTag = { tag: string; _description?: string };

export type MauticStage = {
  name: string;
  weight: number;
  description?: string;
  isPublished?: boolean;
};

/** Looked up by title, never created — the file is uploaded in the UI. `name` is the token key. */
export type MauticAsset = { name: string; title: string; remote_url?: string };

export type MauticFormField = {
  label: string;
  alias: string;
  type: string;
  order: number;
  [key: string]: unknown;
};

/**
 * Created with its fields; an existing form's fields are never rewritten (its results table is keyed
 * by field alias). Field differences surface as drift.
 */
export type MauticForm = {
  name: string;
  /** Mautic truncates form aliases to 10 characters — declare one that already fits. */
  alias: string;
  formType: 'campaign' | 'standalone';
  description?: string | null;
  isPublished?: boolean;
  /** A category ALIAS. */
  category?: string;
  projects?: number[];
  fields?: MauticFormField[];
  actions?: unknown[];
  [key: string]: unknown;
};

/** Brand-wide email settings; any email may override each one. */
export type MauticEmailDefaults = {
  language?: string;
  emailType?: 'template' | 'list';
  fromName?: string;
  fromAddress?: string;
  replyToAddress?: string;
};



export type MauticPage = {
  alias: string;
  title: string;
  /** Full HTML document. */
  body: string;
  isPublished?: boolean;
};

export type MauticEmail = {
  name: string;
  /** Tokens are resolved here too, as plain text. */
  subject: string;
  preview?: string | null;
  /** A category ALIAS. */
  category?: string | null;
  projects?: number[];
  fromName?: string;
  fromAddress?: string;
  replyToAddress?: string;
  /** `template` is campaign-sendable; `list` is a broadcast to a segment. A campaign refuses a list email. */
  emailType?: 'template' | 'list';
  language?: string;
  /** PLAIN TEXT. Rendered to HTML + a text part by mautic-kit's html.mjs. */
  body: string;
  isPublished?: boolean;
};

/**
 * Campaign event types Mautic actually implements.
 *
 * Enumerated rather than `string` because an unknown type is not an error: Mautic saves the
 * campaign and the event simply never fires. `emial.send` provisions cleanly and sends nothing,
 * forever, with no complaint anywhere.
 *
 * Taken from Mautic's own event registry. Extend it when a new one is genuinely used — the point
 * is that adding a type is a deliberate act rather than a typo.
 */
export type MauticActionType =
  | 'email.send'
  | 'lead.changelist'
  | 'lead.changetags'
  | 'lead.updatelead'
  | 'lead.changepoints'
  | 'lead.changeowner'
  | 'stage.change'
  | 'campaign.sendwebhook'
  | 'message.send';

export type MauticDecisionType = 'form.submit' | 'page.pagehit' | 'asset.download' | 'email.open';

type EventCommon = {
  /** Only for `triggerMode: 'date'`-style scheduling; sent as null otherwise. */
  triggerDate?: string | null;
  id: string;
  name: string;
  description?: string;
  order: number;
  /** `interval` needs BOTH triggerInterval and triggerIntervalUnit; `immediate` needs neither. */
  triggerMode: 'immediate' | 'interval' | null;
  triggerInterval: number;
  triggerIntervalUnit: 'h' | 'd' | 'w' | 'm' | null;
  parent: string | null;
  children: string[];
  /** Which branch of a DECISION parent this hangs off. An action without it never fires. */
  decisionPath: 'yes' | 'no' | null;
};

/**
 * `properties` is discriminated on `type`, because it is the field with the least safety and the
 * most consequence: Mautic ignores properties it does not recognise, so `email_typ` provisions
 * cleanly and the send silently loses its type. Each shape below is the one Mautic reads.
 *
 * References are BY NAME here and resolved to ids by the engine — see resolveCampaign in provision.mjs.
 */
export type MauticCampaignEvent =
  | (EventCommon & {
      type: 'email.send';
      eventType: 'action';
      properties: {
        /** An EMAIL NAME from EMAILS. Must be an email whose emailType is 'template'. */
        email: string;
        email_type: 'marketing' | 'transactional';
        priority?: number;
        attempts?: number;
      };
    })
  | (EventCommon & {
      type: 'page.pagehit';
      eventType: 'decision';
      /** PAGE ALIASES from PAGES. */
      properties: { pages: string[] };
    })
  | (EventCommon & {
      type: 'lead.changelist';
      eventType: 'action';
      /** SEGMENT ALIASES. Both keys are required — Mautic reads them unconditionally. */
      properties: { addToLists: string[]; removeFromLists: string[] };
    })
  | (EventCommon & {
      type: 'lead.changetags';
      eventType: 'action';
      properties: { add_tags: string[]; remove_tags: string[] };
    })
  | (EventCommon & {
      type: 'lead.updatelead';
      eventType: 'action';
      /** Contact FIELD ALIASES to values. The only way a campaign writes a contact field (e.g. a double-opt-in flag). */
      properties: Record<string, string | number>;
    })
  | (EventCommon & {
      type: 'stage.change';
      eventType: 'action';
      /** A STAGE NAME. */
      properties: { stage: string };
    })
  | (EventCommon & {
      type: 'form.submit';
      eventType: 'decision';
      /** FORM ALIASES. */
      properties: { forms: string[] };
    })
  | (EventCommon & {
      type: Exclude<MauticActionType, 'email.send' | 'lead.changelist' | 'lead.changetags' | 'lead.updatelead' | 'stage.change'>;
      eventType: 'action';
      properties: Record<string, unknown>;
    })
  | (EventCommon & {
      type: Exclude<MauticDecisionType, 'page.pagehit' | 'form.submit'>;
      eventType: 'decision';
      properties: Record<string, unknown>;
    });

export type MauticCampaign = {
  name: string;
  description?: string;
  /** Lifecycle campaigns are declared false — publishing mails the segment's existing members. */
  isPublished: boolean;
  /** Source segments, by alias. */
  lists: string[];
  /** Source forms, by alias. */
  forms: string[];
  /** A category ALIAS. */
  category?: string;
  projects?: number[];
  events: MauticCampaignEvent[];
  canvasSettings?: unknown;
};


/** One email's copy in one language. Structure comes from the parent; only the words change. */
export type MauticEmailCopy = {
  subject: string;
  preview?: string;
  body: string;
};

/**
 * Translations, keyed by email name then language code.
 *
 * Provisioned as Mautic translation CHILDREN of the named email. The child is written with
 * `templateTranslationParent` (or `segmentTranslationParent` for a list email) — NOT
 * `translationParent`, which the API returns on a read and silently ignores on a write.
 */
export type MauticEmailTranslations = Record<string, Record<string, MauticEmailCopy>>;
