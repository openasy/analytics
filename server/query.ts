// What every report takes besides its site: a period, filters on any dimension and a period to compare with.
//
//   ?days=30&filter=country:is:DE|AT&filter=channel:not:direct&compare=previous
//
// A filter is `dimension:is:values` or `dimension:not:values`, values separated by `|`; `(none)` stands for a visit
// without a value, such as a visit with no source, and `*` in a page, entry, exit or referrer matches any characters.
// Filters on the same request all apply; the values of one filter are alternatives.
import type { SQLInputValue } from "node:sqlite";
import type { Goal } from "./config.ts";

export class QueryError extends Error {}
const bad = (m: string) => new QueryError(m);

/** Dimensions of a visit, as columns of sessions. */
export const SESSION_DIMENSIONS = {
  channel: "channel",
  source: "source",
  referrer: "referrer_url",
  utmSource: "utm_source",
  utmMedium: "utm_medium",
  utmCampaign: "utm_campaign",
  utmTerm: "utm_term",
  utmContent: "utm_content",
  entry: "entry_path",
  exit: "exit_path",
  browser: "browser",
  browserVersion: "browser_version",
  os: "os",
  osVersion: "os_version",
  device: "device",
  country: "country",
  region: "region",
  city: "city",
  language: "language",
  timezone: "timezone",
  screen: "screen",
  visitorType: "CASE is_returning WHEN 1 THEN 'returning' WHEN 0 THEN 'new' END",
} as const;
export type SessionDimension = keyof typeof SESSION_DIMENSIONS;

/** Dimensions of what a visit did: a visit matches when it viewed the page, sent the event or reached the goal. */
export const EVENT_DIMENSIONS = ["page", "event", "goal"] as const;
export type EventDimension = (typeof EVENT_DIMENSIONS)[number];
export type Dimension = SessionDimension | EventDimension;
export const DIMENSIONS = [...(Object.keys(SESSION_DIMENSIONS) as SessionDimension[]), ...EVENT_DIMENSIONS] as const;

/** Where `*` matches any characters. */
const PATTERNED = new Set<Dimension>(["page", "entry", "exit", "referrer"]);

export interface Filter {
  dimension: Dimension;
  op: "is" | "not";
  values: string[];
}

export const NONE = "(none)";
const MAX_FILTERS = 20;
const MAX_VALUES = 20;

/** Reads the `filter` parameters of a request. */
export function parseFilters(raw: string[]): Filter[] {
  if (raw.length > MAX_FILTERS) throw bad(`filter is given at most ${MAX_FILTERS} times.`);
  return raw.map((f) => {
    const m = /^([A-Za-z]+):(is|not):(.*)$/s.exec(f);
    if (!m) throw bad(`filter is dimension:is:values or dimension:not:values, such as country:is:DE|AT; ${JSON.stringify(f.slice(0, 80))} is not.`);
    const dimension = m[1] as Dimension;
    if (!DIMENSIONS.includes(dimension)) throw bad(`filter: ${dimension} is not a dimension; one of ${DIMENSIONS.join(", ")}.`);
    const values = [...new Set(m[3]!.split("|").map((v) => v.trim()))].filter(Boolean);
    if (!values.length || values.length > MAX_VALUES || values.some((v) => v.length > 512))
      throw bad(`filter ${dimension}: 1 to ${MAX_VALUES} values separated by |, each up to 512 characters.`);
    return { dimension, op: m[2] as Filter["op"], values };
  });
}

export const COMPARES = ["previous", "year"] as const;
export type Compare = (typeof COMPARES)[number];
export function parseCompare(v: string | null): Compare | null {
  if (v === null || v === "" || v === "none") return null;
  if (!COMPARES.includes(v as Compare)) throw bad("compare is previous (the period just before) or year (the same days a year before).");
  return v as Compare;
}

const DAY = 86_400_000;

/** A period of whole days (UTC): from the start of the first up to the start of the day after the last. */
export interface Window {
  from: string;
  to: string;
  days: string[];
}

const iso = (t: number) => new Date(t).toISOString();
function daysFrom(start: number, n: number) {
  return Array.from({ length: n }, (_, i) => iso(start + i * DAY).slice(0, 10));
}

/** The last n days, today included. Today is not over, so the period ends at the start of tomorrow. */
export function windowOf(n: number, now: number): Window {
  const today = Math.floor(now / DAY) * DAY;
  const start = today - (n - 1) * DAY;
  return { from: iso(start), to: iso(today + DAY), days: daysFrom(start, n) };
}

/** The same date a year before: 29 February becomes 1 March. */
function yearBefore(t: number) {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear() - 1, d.getUTCMonth(), d.getUTCDate());
}

/** The period to compare with: the as many days just before, or the same days a year before. */
export function compareWindow(w: Window, compare: Compare): Window {
  const n = w.days.length;
  const start = compare === "previous" ? Date.parse(w.from) - n * DAY : yearBefore(Date.parse(w.from));
  return { from: iso(start), to: iso(start + n * DAY), days: daysFrom(start, n) };
}

/** A path pattern as a GLOB: `*` is the only wildcard, so `?` and `[` stand for themselves. */
export const glob = (pattern: string) => pattern.replace(/[[?]/g, (c) => `[${c}]`);

interface Sql {
  sql: string;
  args: SQLInputValue[];
}

/** `column` matching one of the values, with (none) for null and * for patterns. */
function matchAny(column: string, values: string[], patterned: boolean): Sql {
  const terms: string[] = [];
  const args: SQLInputValue[] = [];
  for (const v of values) {
    if (v === NONE) terms.push(`${column} IS NULL`);
    else if (patterned && v.includes("*")) (terms.push(`${column} GLOB ?`), args.push(glob(v)));
    else (terms.push(`${column} = ?`), args.push(v));
  }
  return { sql: `(${terms.join(" OR ")})`, args };
}

const include = (op: Filter["op"], m: Sql): Sql => (op === "is" ? m : { sql: `NOT COALESCE(${m.sql}, 0)`, args: m.args });

/**
 * The conditions on sessions (no alias) that the filters set, for visits that started in the window. A filter on a
 * page, event or goal keeps the visits that did, or with not, did not do it.
 */
export function sessionConditions(site: string, w: Window, filters: Filter[], goals: Goal[]): Sql {
  const parts: string[] = [];
  const args: SQLInputValue[] = [];
  for (const f of filters) {
    if (f.dimension in SESSION_DIMENSIONS) {
      const m = include(f.op, matchAny(SESSION_DIMENSIONS[f.dimension as SessionDimension], f.values, PATTERNED.has(f.dimension)));
      parts.push(m.sql);
      args.push(...m.args);
      continue;
    }
    let what: Sql;
    if (f.dimension === "page") {
      const m = matchAny("path", f.values, true);
      what = { sql: `type = 'pageview' AND ${m.sql}`, args: m.args };
    } else if (f.dimension === "event") {
      const m = matchAny("name", f.values, false);
      what = { sql: `type = 'event' AND ${m.sql}`, args: m.args };
    } else {
      const chosen = goals.filter((g) => f.values.includes(g.name)).map(goalSql);
      what = chosen.length ? { sql: `(${chosen.map((t) => t.sql).join(" OR ")})`, args: chosen.flatMap((t) => t.args) } : { sql: "0", args: [] };
    }
    parts.push(`id ${f.op === "is" ? "IN" : "NOT IN"} (SELECT session FROM events WHERE site = ? AND at >= ? AND at < ? AND ${what.sql})`);
    args.push(site, w.from, w.to, ...what.args);
  }
  return { sql: parts.join(" AND "), args };
}

/** The events that reach a goal: a page view of its path, its own event, or a download of its file. */
export function goalSql(g: Goal): Sql {
  if (g.path) return { sql: "(type = 'pageview' AND path GLOB ?)", args: [glob(g.path)] };
  if (g.download) return { sql: "(type = 'click' AND link = 'download' AND href GLOB ?)", args: [glob(g.download)] };
  return { sql: "(type = 'event' AND name = ?)", args: [g.event] };
}

/** The page filters as conditions on an event's path, for the lists of pages, clicks and vitals. */
export function pathConditions(filters: Filter[], column = "path"): Sql {
  const parts: string[] = [];
  const args: SQLInputValue[] = [];
  for (const f of filters.filter((x) => x.dimension === "page")) {
    const m = include(f.op, matchAny(column, f.values, true));
    parts.push(m.sql);
    args.push(...m.args);
  }
  return { sql: parts.join(" AND "), args };
}

/** The visits and events a report reads: of the site, in the window, of the visits the filters keep. */
export function scopeOf(site: string, w: Window, filters: Filter[], goals: Goal[], table?: string) {
  // With `table`, the visits the filters keep were worked out once into that table, for every query of the report.
  const cond = table ? { sql: `id IN (SELECT id FROM ${table})`, args: [] } : sessionConditions(site, w, filters, goals);
  const sessions: Sql = {
    sql: `site = ? AND started_at >= ? AND started_at < ?${cond.sql ? ` AND ${cond.sql}` : ""}`,
    args: [site, w.from, w.to, ...cond.args],
  };
  /** Events (with the alias given) of the site in the window, of the visits the filters keep. */
  const events = (alias = ""): Sql => {
    const a = alias ? `${alias}.` : "";
    return {
      sql: `${a}site = ? AND ${a}at >= ? AND ${a}at < ?${
        table ? ` AND ${a}session IN (SELECT id FROM ${table})` : filters.length ? ` AND ${a}session IN (SELECT id FROM sessions WHERE ${sessions.sql})` : ""
      }`,
      args: [site, w.from, w.to, ...(!table && filters.length ? sessions.args : [])],
    };
  };
  const paths = (alias = "") => pathConditions(filters, alias ? `${alias}.path` : "path");
  return { sessions, events, paths, filtered: filters.length > 0 };
}

export type Scope = ReturnType<typeof scopeOf>;

/**
 * What one event that reaches a goal is worth: the goal's fixed amount, or its event's property (`value` is an
 * ecommerce event's own value). Null SQL when the goal has no value.
 */
export function goalWorthSql(g: Goal, alias = ""): Sql | null {
  const a = alias ? `${alias}.` : "";
  if (!g.value) return null;
  if ("amount" in g.value) return { sql: "?", args: [g.value.amount] };
  return { sql: `COALESCE(json_extract(${a}props, ?), CASE WHEN ? = 'value' THEN ${a}amount END)`, args: [`$."${g.value.prop}"`, g.value.prop] };
}

/** Monday 00:00 UTC of the week a time is in. */
export function weekStart(t: number): number {
  const day = Math.floor(t / DAY) * DAY;
  return day - ((new Date(day).getUTCDay() + 6) % 7) * DAY;
}
