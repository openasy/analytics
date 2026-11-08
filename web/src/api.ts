// The UI is an ordinary client of the public API (ADR 0014, 0018). Types follow openapi.json.

/** Another OpenAsy product of this install, from OPENASY_PRODUCTS. */
export interface ProductLink {
  id: string;
  url: string;
}

/** The sites file and whether it is applied; null before it was first read. */
export type ConfigFile = {
  path: string;
  appliedAt: string | null;
  sites: number;
  /** Why the file on disk is not applied; the last good version stays in use. */
  error: string | null;
  warnings: string[];
} | null;

export interface Summary {
  sites: number;
  file: ConfigFile;
  visitors24h: number;
  visits24h: number;
  pageviews24h: number;
  /** Visitors active in the last five minutes. */
  live: number;
  lastEventAt: string | null;
  /** The GeoIP database places come from, with the attribution its licence asks for. */
  location?: GeoState | null;
}

export interface GeoState {
  enabled: boolean;
  file: string;
  update: boolean;
  database: string | null;
  month: string | null;
  updatedAt: string | null;
  attribution: string;
  error: string | null;
}

/** The sites file as it was last applied, read-only. */
export interface SettingsFile {
  file: ConfigFile;
  yaml: string | null;
}

export interface Goal {
  name: string;
  path: string | null;
  event: string | null;
  download: string | null;
  /** What a conversion is worth: a fixed amount, or its event's property. */
  value?: { amount: number } | { prop: string } | null;
}

export interface Site {
  name: string;
  domains: string[];
  consent: "none" | "required";
  script: string;
  goals: Goal[];
  query: string[];
  ignore: string[];
  keep: { events: number; days: number };
  rateLimit: number;
  serverKey: { variable: string; set: boolean } | null;
  funnels: Funnel[];
  /** Whether the script reports form fields entered and left. */
  forms: boolean;
  /** Session replays: the share of visits recorded, in percent, and the days kept; null when off. */
  replays: { sample: number; keep: number } | null;
  search: { path: string | null; params: string[] } | null;
  notFound: { title: string } | null;
  channels: Record<string, string[]>;
  vitals: boolean;
  downloads: string[];
  /** How precisely a visit's place is worked out from its IP address, which is never kept. */
  location: "city" | "region" | "country" | "off";
  /** ISO 4217, such as TRY; null when the site names none. */
  currency: string | null;
  ecommerce: boolean;
  searchConsole: Record<Engine, string | null>;
  today: { visitors: number; pageviews: number };
  lastEventAt: string | null;
}

export interface FunnelStep {
  name: string;
  path: string | null;
  event: string | null;
}

export interface Funnel {
  name: string;
  steps: FunnelStep[];
}

export type Range = 1 | 7 | 30 | 90;
export type Compare = "previous" | "year";
type Counted<K extends string> = Record<K, string | null> & { visits: number; visitors: number };

/** The same report for the period compared with, under compare: its fields but site and days. */
export type Compared<T> = Omit<T, "site" | "days" | "compare"> & { period: Compare; from: string; to: string };

export interface Annotation {
  id: number;
  site: string;
  /** The day it is about, such as 2026-11-08. */
  date: string;
  text: string;
  createdAt: string;
  createdBy: string | null;
}

export interface Report {
  site: string;
  days: Range;
  from: string;
  to: string;
  /** bounceRate is GA4's: the share of visits that were not engaged. */
  totals: {
    visitors: number;
    visits: number;
    pageviews: number;
    bounceRate: number;
    duration: number;
    engagedVisits: number;
    engagementRate: number;
    newVisitors: number;
    returningVisitors: number;
  };
  series: Array<{ day: string; visitors: number; visits: number; pageviews: number }>;
  pages: Array<{ path: string; title: string | null; views: number; visitors: number; time: number | null; scroll: number | null }>;
  entries: Counted<"path">[];
  exits: Counted<"path">[];
  sources: Counted<"source">[];
  channels: Counted<"channel">[];
  campaigns: Array<Counted<"source" | "medium" | "campaign">>;
  browsers: Array<{ name: string; visits: number; visitors: number }>;
  systems: Array<{ name: string; visits: number; visitors: number }>;
  devices: Array<{ name: string; visits: number; visitors: number }>;
  events: Array<{ name: string; count: number; visitors: number }>;
  clicks: Array<{ target: string | null; text: string | null; href: string | null; count: number; visitors: number }>;
  goals: Array<Goal & { visits: number; rate: number; value: number | null }>;
  annotations: Annotation[];
  compare?: Compared<Report>;
}

/** What /api/v1/breakdown groups by. */
export type BreakdownDimension =
  | "channel"
  | "source"
  | "referrer"
  | "utmSource"
  | "utmMedium"
  | "utmCampaign"
  | "utmTerm"
  | "utmContent"
  | "entry"
  | "exit"
  | "browser"
  | "browserVersion"
  | "os"
  | "osVersion"
  | "device"
  | "country"
  | "region"
  | "city"
  | "language"
  | "timezone"
  | "screen"
  | "visitorType"
  | "page"
  | "event"
  | "search"
  | "notFound"
  | "outbound"
  | "download";

export interface BreakdownRow {
  /** The value; null for visits without one. */
  value: string | null;
  /** What the value belongs to: a version's browser, a city's region and country, a page not found's referrer. */
  group: string | null;
  visitors: number;
  visits: number;
  /** Page views of the visits, or the page views, events, searches or clicks themselves. */
  count: number;
  engagementRate: number | null;
  /** Average visit in seconds, for a dimension of a visit. */
  duration: number | null;
}

export interface Breakdown {
  site: string;
  days: Range;
  from: string;
  to: string;
  dimension: BreakdownDimension;
  rows: BreakdownRow[];
  compare?: Compared<Breakdown>;
}

export type Vital = "lcp" | "inp" | "cls";
export interface VitalSummary {
  /** 75th percentile: LCP and INP in milliseconds, CLS as a score. */
  p75: number | null;
  samples: number;
  /** Shares of samples at or under the good threshold, and over the poor one. */
  good: number;
  poor: number;
}

export interface Vitals {
  site: string;
  days: Range;
  from: string;
  to: string;
  thresholds: Record<Vital, [number, number]>;
  totals: { samples: number } & Record<Vital, VitalSummary>;
  devices: Array<{ device: string; samples: number } & Record<Vital, VitalSummary>>;
  pages: Array<{ path: string; device: string; samples: number } & Record<Vital, number | null>>;
  /** The 75th percentile of each day, all devices. */
  series: Array<{ day: string; samples: number } & Record<Vital, number | null>>;
  compare?: Compared<Vitals>;
}

export interface Frustration {
  site: string;
  days: Range;
  from: string;
  to: string;
  totals: { clicks: number; rage: number; dead: number; rageVisits: number; deadVisits: number };
  pages: Array<{ path: string; clicks: number; rage: number; dead: number; visits: number }>;
  elements: Array<{ path: string; target: string | null; text: string | null; rage: number; dead: number; visitors: number }>;
  compare?: Compared<Frustration>;
}

export interface Realtime {
  site: string;
  at: string;
  /** Active in the last five minutes. */
  visitors: number;
  visits: number;
  /** Page views in the last five minutes. */
  pageviews: number;
  pages: Array<{ path: string | null; visitors: number }>;
  channels: Array<{ channel: string | null; visitors: number }>;
  sources: Array<{ source: string | null; visitors: number }>;
  countries: Array<{ country: string | null; visitors: number }>;
  devices: Array<{ device: string; visitors: number }>;
  /** Page views in each of the last 30 minutes, oldest first. */
  minutes: Array<{ minute: string; pageviews: number }>;
  /** Visits that reached each goal in the last 30 minutes. */
  goals: Array<{ name: string; visits: number }>;
  /** The latest of the last 30 minutes, newest first. */
  feed: Array<{
    at: string;
    kind: "visit" | "page" | "event" | "download" | "goal";
    visit: string;
    path: string | null;
    name: string | null;
    file: string | null;
    value: number | null;
    source: string | null;
    country: string | null;
    city: string | null;
  }>;
}

export interface Visit {
  id: string;
  site: string;
  visitor: string;
  user: string | null;
  startedAt: string;
  lastAt: string;
  /** Seconds. */
  duration: number;
  pageviews: number;
  events: number;
  entry: string | null;
  exit: string | null;
  source: string | null;
  referrer: string | null;
  referrerUrl: string | null;
  utm: { source: string | null; medium: string | null; campaign: string | null; term: string | null; content: string | null };
  channel: string | null;
  browser: string;
  browserVersion: string | null;
  os: string;
  osVersion: string | null;
  device: string;
  language: string | null;
  timezone: string | null;
  screen: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  returning: boolean | null;
  engaged: boolean;
  /** Whether the visit was recorded. */
  replay: boolean;
  /** Bursts of three or more quick clicks on the same element. */
  rage: number;
}

export interface VisitEvent {
  type: "pageview" | "leave" | "click" | "event" | "form";
  at: string;
  path: string | null;
  query: string | null;
  title: string | null;
  target: string | null;
  text: string | null;
  href: string | null;
  name: string | null;
  props: Record<string, string | number | boolean> | null;
  duration: number | null;
  scroll: number | null;
  x: number | null;
  y: number | null;
  form: string | null;
  field: string | null;
  kind: string | null;
  action: "start" | "leave" | "submit" | "abandon" | null;
  filled: boolean | null;
  again: boolean | null;
}

export interface VisitDetail extends Visit {
  timeline: VisitEvent[];
}

export interface Funnels {
  site: string;
  days: Range;
  from: string;
  funnels: Array<{
    name: string;
    /** Visits that reached each step having done the ones before, and the median seconds from the step before. */
    steps: Array<FunnelStep & { visits: number; median: number | null }>;
    sources: Array<{ source: string; entered: number; finished: number }>;
  }>;
}

export interface Forms {
  site: string;
  days: Range;
  from: string;
  enabled: boolean;
  forms: Array<{
    form: string;
    page: string | null;
    starts: number;
    submits: number;
    /** Median seconds from the first field to sending. */
    median: number | null;
    fields: Array<{ field: string; kind: string | null; reached: number; left: number; time: number | null; again: number }>;
  }>;
}

export interface Heatmap {
  site: string;
  days: Range;
  from: string;
  path: string;
  device: string | null;
  url: string;
  views: number;
  clicks: number;
  elements: Array<{ target: string; text: string | null; count: number; visitors: number }>;
  points: Array<{ target: string; x: number; y: number; count: number }>;
  scroll: Array<{ depth: number; share: number }>;
  pages: Array<{ path: string; views: number }>;
}

export interface Recording {
  visit: Visit;
  events: Array<{ type: number; timestamp: number }>;
}

interface Head {
  site: string;
  days: Range;
  from: string;
  to: string;
}

export interface Ecommerce extends Head {
  enabled: boolean;
  currency: string | null;
  totals: {
    revenue: number;
    orders: number;
    averageOrder: number;
    units: number;
    buyingVisits: number;
    conversionRate: number;
    visits: number;
    refunds: number;
    refunded: number;
  };
  series: Array<{ day: string; orders: number; revenue: number }>;
  funnel: Array<{ event: "view_item" | "add_to_cart" | "begin_checkout" | "purchase"; visits: number }>;
  products: Array<{
    sku: string;
    name: string | null;
    category: string | null;
    views: number;
    carts: number;
    units: number;
    revenue: number;
    refunded: number;
  }>;
  sources: Array<{ source: string | null; visits: number; orders: number; revenue: number }>;
  campaigns: Array<{ campaign: string | null; visits: number; orders: number; revenue: number }>;
  channels: Array<{ channel: string | null; visits: number; orders: number; revenue: number }>;
  compare?: Compared<Ecommerce>;
}

export type Model = "first" | "last" | "linear";
export interface Attribution extends Head {
  goal: string;
  by: "channel" | "source" | "campaign";
  lookback: number;
  currency: string | null;
  hasValue: boolean;
  conversions: number;
  medianVisits: number | null;
  rows: Array<{ value: string | null } & Record<Model, number> & Record<`${Model}Value`, number | null>>;
  compare?: Compared<Attribution>;
}

export interface FlowNode {
  id: string;
  path: string | null;
  column: number;
  visits: number;
  exit: boolean;
  other: boolean;
}
export interface Paths extends Head {
  page: string;
  direction: "from" | "to";
  steps: number;
  visits: number;
  nodes: FlowNode[];
  links: Array<{ from: string; to: string; visits: number }>;
}

export interface Retention {
  site: string;
  weeks: number;
  days: number;
  cohorts: Array<{ week: string; visitors: number; counts: number[]; shares: number[] }>;
  lifecycle: Array<{ week: string; new: number; returning: number; resurrected: number; dormant: number }>;
  stickiness: Array<{ day: string; dau: number; wau: number; mau: number }>;
}

export interface SiteSearch extends Head {
  enabled: boolean;
  totals: { searches: number; terms: number; visits: number; visitShare: number; noResults: number; clicked: number; left: number };
  terms: Array<{ term: string; searches: number; visits: number; noResults: number; clicked: number; refined: number; left: number }>;
  compare?: Compared<SiteSearch>;
}

export type Engine = "google" | "bing" | "yandex";
export interface SearchConsole extends Head {
  engine: Engine;
  engines: Array<{
    engine: Engine;
    property: string | null;
    missing: string | null;
    importedUntil: string | null;
    importedAt: string | null;
    error: string | null;
  }>;
  totals: { clicks: number; impressions: number; ctr: number; position: number | null };
  hidden: number;
  queries: Array<{ query: string; page: string | null; clicks: number; impressions: number; ctr: number; position: number | null }>;
  pages: Array<{
    page: string;
    path: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number | null;
    entries: number;
    bounceRate: number | null;
  }>;
  compare?: { period: Compare; from: string; to: string; totals: SearchConsole["totals"]; hidden: number };
}

export interface SavedSegment {
  id: string;
  name: string;
  filters: Array<{ dimension: string; op: "is" | "not"; values: string[] }>;
  shared: boolean;
  owner: string | null;
  mine: boolean;
  createdAt: string;
}

export const SECTIONS = ["overview", "acquisition", "conversions", "ecommerce", "search", "performance"] as const;
export type Section = (typeof SECTIONS)[number];

export interface EmailReport {
  id: string;
  site: string;
  name: string;
  recipients: string[];
  every: "daily" | "weekly" | "monthly";
  sections: Section[];
  segment: string | null;
  createdBy: string | null;
  createdAt: string;
  lastSentAt: string | null;
  lastError: string | null;
}

export interface Share {
  id: string;
  site: string;
  name: string;
  sections: Section[];
  password: boolean;
  expiresAt: string | null;
  createdBy: string | null;
  createdAt: string;
  views: number;
  lastViewedAt: string | null;
}

export interface AlertRule {
  id: string;
  site: string;
  name: string;
  kind: "drop" | "spike";
  ratio: number;
  recipients: string[];
  webhook: string | null;
  enabled: boolean;
  createdBy: string | null;
  createdAt: string;
  open: boolean;
}
export interface Alert {
  id: number;
  rule: string;
  name: string | null;
  site: string;
  hour: string;
  startedAt: string;
  endedAt: string | null;
  visits: number;
  usual: number;
  sent: string | null;
}

export class Unauthorized extends Error {}
/** The signed-in owner or admin has no second factor yet; the sign-in gate asks for one. */
export class MfaSetupRequired extends Error {}
export class ApiError extends Error {}

// The session is an HttpOnly cookie set by sign-in (@openasy/auth); the browser sends it, nothing is stored here.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
    if (res.status === 401) throw new Unauthorized(problem.detail);
    if (problem.code === "mfa-setup-required") throw new MfaSetupRequired(problem.detail);
    throw new ApiError(problem.detail ?? `${path}: ${res.status}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}
