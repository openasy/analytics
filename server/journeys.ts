// How visitors move and come back: where they go on from a page (paths), whether they return (retention), and what
// happens after they search the site.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { pathPattern, type Site } from "./config.ts";
import { sessionConditions, weekStart, windowOf, type Filter, type Scope } from "./query.ts";

type Row = Record<string, any>;
const DAY = 86_400_000;
const WEEK = 7 * DAY;
const iso = (t: number) => new Date(t).toISOString();

/* ---------------------------------------------------------------- paths */

export interface FlowNode {
  id: string;
  /** A page's path, or null for the visits that left the site (exit) and for the other pages of a step (other). */
  path: string | null;
  column: number;
  visits: number;
  exit: boolean;
  other: boolean;
}

/**
 * Where visits went on from a page (or, with direction "to", how they reached it), step by step: each column a step,
 * each link the visits that moved from one page to the next. A step keeps its `top` pages; the rest are one node. A
 * reload of the same page is not a step.
 */
export function pathsOf(db: DatabaseSync, sc: Scope, page: string, direction: "from" | "to", steps: number, top = 6) {
  const e = sc.events();
  const match = pathPattern(page);
  const chains: string[][] = [];
  let current = "";
  let seen: string[] = [];
  const close = () => {
    const at = seen.findIndex((p) => match.test(p));
    if (at < 0) return;
    // Starting at the first view of the page, onward or back to the start of the visit; "" stands for leaving.
    const chain = direction === "from" ? seen.slice(at, at + steps + 1) : seen.slice(Math.max(0, at - steps), at + 1).reverse();
    if (chain.length <= steps) chain.push("");
    chains.push(chain);
  };
  for (const r of db
    .prepare(`SELECT session, path FROM events WHERE ${e.sql} AND type = 'pageview' ORDER BY session, at, id`)
    .iterate(...e.args) as Iterable<Row>) {
    if (r.session !== current) {
      close();
      current = r.session as string;
      seen = [];
    }
    if (seen.at(-1) !== r.path) seen.push(r.path as string);
  }
  close();

  // The pages kept at each step: the most visited ones; the others share a node.
  const keep: Array<Set<string>> = [];
  for (let c = 1; c <= steps; c++) {
    const counts = new Map<string, number>();
    for (const ch of chains) if (ch[c]) counts.set(ch[c]!, (counts.get(ch[c]!) ?? 0) + 1);
    keep[c] = new Set(
      [...counts]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, top)
        .map(([p]) => p),
    );
  }
  const nodes = new Map<string, FlowNode>();
  const links = new Map<string, { from: string; to: string; visits: number }>();
  const nodeOf = (c: number, p: string) => {
    const kind = c === 0 ? "page" : p === "" ? "exit" : keep[c]!.has(p) ? "page" : "other";
    const id = c === 0 ? "0:start" : `${c}:${kind === "page" ? p : kind}`;
    let n = nodes.get(id);
    if (!n)
      nodes.set(id, (n = { id, path: kind === "page" ? (c === 0 ? page : p) : null, column: c, visits: 0, exit: kind === "exit", other: kind === "other" }));
    n.visits++;
    return id;
  };
  for (const ch of chains) {
    let prev = nodeOf(0, ch[0]!);
    for (let c = 1; c < ch.length; c++) {
      const id = nodeOf(c, ch[c]!);
      const key = `${prev}>${id}`;
      const l = links.get(key) ?? { from: prev, to: id, visits: 0 };
      l.visits++;
      links.set(key, l);
      if (ch[c] === "") break;
      prev = id;
    }
  }
  const order = (a: FlowNode, b: FlowNode) =>
    a.column - b.column || Number(a.exit) - Number(b.exit) || Number(a.other) - Number(b.other) || b.visits - a.visits;
  return {
    page,
    direction,
    steps,
    visits: chains.length,
    nodes: [...nodes.values()].sort(order),
    links: [...links.values()].sort((a, b) => b.visits - a.visits),
  };
}

/* ------------------------------------------------------------ retention */

/**
 * Weekly cohorts (visitors first seen in a week, Monday to Sunday in UTC, and how many came back each week after),
 * stickiness (daily, weekly and monthly active visitors) and each week's visitors as new, returning or resurrected.
 * First seen is the first visit that is still kept; with filters, only the visits they keep count.
 */
export function retentionOf(db: DatabaseSync, site: Site, filters: Filter[], now: number, weeks: number, days: number) {
  const cond = sessionConditions(site.name, { from: "0000", to: "9999", days: [] }, filters, site.goals);
  const where = `site = ?${cond.sql ? ` AND ${cond.sql}` : ""}`;
  const args: SQLInputValue[] = [site.name, ...cond.args];
  const thisWeek = weekStart(now);
  const firstWeek = thisWeek - (weeks - 1) * WEEK;
  const stick = windowOf(days, now);
  // Visits from four weeks before the first cohort, so the first weeks know who was away; and 29 days before the
  // first day of stickiness, for its monthly count.
  const since = Math.min(firstWeek - 4 * WEEK, Date.parse(stick.from) - 29 * DAY);
  const firstSeen = new Map<string, number>();
  for (const r of db.prepare(`SELECT visitor, MIN(started_at) AS first FROM sessions WHERE ${where} GROUP BY visitor`).iterate(...args) as Iterable<Row>)
    firstSeen.set(r.visitor as string, Date.parse(r.first as string));
  // The days and weeks each visitor came.
  const byDay = new Map<number, Set<string>>();
  const byWeek = new Map<number, Set<string>>();
  for (const r of db
    .prepare(`SELECT DISTINCT visitor, substr(started_at, 1, 10) AS day FROM sessions WHERE ${where} AND started_at >= ?`)
    .iterate(...args, iso(since)) as Iterable<Row>) {
    const d = Date.parse(`${r.day}T00:00:00Z`);
    const wk = weekStart(d);
    (byDay.get(d) ?? byDay.set(d, new Set()).get(d)!).add(r.visitor as string);
    (byWeek.get(wk) ?? byWeek.set(wk, new Set()).get(wk)!).add(r.visitor as string);
  }
  const weekList = Array.from({ length: weeks }, (_, i) => firstWeek + i * WEEK);
  const cohorts = weekList.map((wk) => {
    const members = [...(byWeek.get(wk) ?? [])].filter((v) => weekStart(firstSeen.get(v) ?? 0) === wk);
    const counts = weekList
      .filter((later) => later >= wk)
      .map((later) => {
        const active = byWeek.get(later);
        return active ? members.filter((v) => active.has(v)).length : 0;
      });
    return {
      week: iso(wk).slice(0, 10),
      visitors: members.length,
      /** Visitors of the cohort who came in its week and in each week after it, this week last and not over yet. */
      counts,
      shares: counts.map((n) => (members.length ? n / members.length : 0)),
    };
  });

  const lifecycle = weekList.map((wk) => {
    const active = byWeek.get(wk) ?? new Set<string>();
    const before = byWeek.get(wk - WEEK) ?? new Set<string>();
    const recent = new Set([1, 2, 3, 4].flatMap((k) => [...(byWeek.get(wk - k * WEEK) ?? [])]));
    let fresh = 0;
    let returning = 0;
    let resurrected = 0;
    for (const v of active) {
      if (weekStart(firstSeen.get(v) ?? wk) >= wk) fresh++;
      else if (recent.has(v)) returning++;
      else resurrected++;
    }
    return { week: iso(wk).slice(0, 10), new: fresh, returning, resurrected, dormant: [...before].filter((v) => !active.has(v)).length };
  });

  // Daily, weekly and monthly active visitors of each day: those who came that day, or in the 7 or 30 days ending it.
  const rolling = (span: number) => {
    const count = new Map<string, number>();
    const out = new Map<number, number>();
    const first = Date.parse(stick.from) - (span - 1) * DAY;
    for (let d = first; d < Date.parse(stick.to); d += DAY) {
      for (const v of byDay.get(d) ?? []) count.set(v, (count.get(v) ?? 0) + 1);
      for (const v of byDay.get(d - span * DAY) ?? []) {
        const n = count.get(v)! - 1;
        if (n) count.set(v, n);
        else count.delete(v);
      }
      out.set(d, count.size);
    }
    return out;
  };
  const wau = rolling(7);
  const mau = rolling(30);
  const stickiness = stick.days.map((day) => {
    const d = Date.parse(`${day}T00:00:00Z`);
    return { day, dau: byDay.get(d)?.size ?? 0, wau: wau.get(d) ?? 0, mau: mau.get(d) ?? 0 };
  });
  return { site: site.name, weeks, days, cohorts, lifecycle, stickiness };
}

/* ---------------------------------------------------------- site search */

/**
 * What came after each search on the site: another page (clicked a result), another search, or nothing (left). A
 * page the site marks as finding nothing counts as no results.
 */
export function siteSearchOf(db: DatabaseSync, sc: Scope) {
  const e = sc.events();
  const terms = new Map<string, { searches: number; visits: Set<string>; noResults: number; clicked: number; refined: number; left: number }>();
  const visits = new Set<string>();
  let current = "";
  let prev: Row | null = null;
  const after = (next: Row | null) => {
    if (!prev?.search) return;
    const t = terms.get(prev.search as string) ?? { searches: 0, visits: new Set(), noResults: 0, clicked: 0, refined: 0, left: 0 };
    terms.set(prev.search as string, t);
    t.searches++;
    t.visits.add(prev.session as string);
    visits.add(prev.session as string);
    if (prev.no_results === 1) t.noResults++;
    if (!next) t.left++;
    else if (next.search) t.refined++;
    else t.clicked++;
  };
  for (const r of db
    .prepare(
      `SELECT session, search, no_results FROM events WHERE ${e.sql} AND type = 'pageview'
         AND session IN (SELECT session FROM events WHERE ${e.sql} AND type = 'pageview' AND search IS NOT NULL) ORDER BY session, at, id`,
    )
    .iterate(...e.args, ...e.args) as Iterable<Row>) {
    if (r.session !== current) {
      after(null);
      current = r.session as string;
      prev = null;
    } else after(r);
    prev = r;
  }
  after(null);
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE ${sc.sessions.sql}`).get(...sc.sessions.args) as Row).n as number;
  const rows = [...terms]
    .map(([term, t]) => ({
      term,
      searches: t.searches,
      visits: t.visits.size,
      noResults: t.noResults,
      clicked: t.searches ? t.clicked / t.searches : 0,
      refined: t.searches ? t.refined / t.searches : 0,
      left: t.searches ? t.left / t.searches : 0,
    }))
    .sort((a, b) => b.searches - a.searches || a.term.localeCompare(b.term));
  const sum = (k: "searches" | "noResults") => rows.reduce((n, x) => n + x[k], 0);
  const searches = sum("searches");
  const left = [...terms.values()].reduce((n, t) => n + t.left, 0);
  const clicked = [...terms.values()].reduce((n, t) => n + t.clicked, 0);
  return {
    totals: {
      searches,
      terms: rows.length,
      visits: visits.size,
      visitShare: total ? visits.size / total : 0,
      noResults: sum("noResults"),
      clicked: searches ? clicked / searches : 0,
      left: searches ? left / searches : 0,
    },
    terms: rows.slice(0, 500),
  };
}
