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
}

export interface Goal {
  name: string;
  path: string | null;
  event: string | null;
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
type Counted<K extends string> = Record<K, string | null> & { visits: number; visitors: number };

export interface Report {
  site: string;
  days: Range;
  from: string;
  totals: { visitors: number; visits: number; pageviews: number; bounceRate: number; duration: number };
  series: Array<{ day: string; visitors: number; visits: number; pageviews: number }>;
  pages: Array<{ path: string; title: string | null; views: number; visitors: number; time: number | null; scroll: number | null }>;
  entries: Counted<"path">[];
  exits: Counted<"path">[];
  sources: Counted<"source">[];
  campaigns: Array<Counted<"source" | "medium" | "campaign">>;
  browsers: Array<{ name: string; visits: number; visitors: number }>;
  systems: Array<{ name: string; visits: number; visitors: number }>;
  devices: Array<{ name: string; visits: number; visitors: number }>;
  events: Array<{ name: string; count: number; visitors: number }>;
  clicks: Array<{ target: string | null; text: string | null; href: string | null; count: number; visitors: number }>;
  goals: Array<Goal & { visits: number; rate: number }>;
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
  utm: { source: string | null; medium: string | null; campaign: string | null };
  browser: string;
  os: string;
  device: string;
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
