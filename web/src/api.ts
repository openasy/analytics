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
  today: { visitors: number; pageviews: number };
  lastEventAt: string | null;
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
}

export interface VisitEvent {
  type: "pageview" | "leave" | "click" | "event";
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
}

export interface VisitDetail extends Visit {
  timeline: VisitEvent[];
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
