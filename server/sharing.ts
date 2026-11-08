// Sharing what Analytics knows with people and other tools: saved segments (a member's own, or the team's), email
// reports on a schedule, read-only dashboard links for people without an account, and alerts when a site's traffic
// is far from the usual.
//
// Nothing shared names anyone: email reports and shared links hold totals and tables of pages, sources and the like,
// never a visit, a replay, a heatmap, a visitor id or a user id.
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { AnalyticsError, type Analytics, type Range, type ReportQuery } from "./analytics.ts";
import type { Site } from "./config.ts";
import { ENGINES } from "./searchconsole.ts";
import { parseFilters, QueryError, type Filter } from "./query.ts";
import type { Mailer } from "./smtp.ts";

type Row = Record<string, any>;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const bad = (detail: string) => new AnalyticsError(422, "invalid-body", detail);
const notFound = (what: string) => new AnalyticsError(404, "not-found", `${what} does not exist.`);
const EMAIL = /^[^\s@<>,;"]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,}$/;
const id = () => randomBytes(9).toString("base64url");
const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, length: number, options: { N: number; r: number; p: number }) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1 };
/** A shared link's password, hashed with scrypt and a salt of its own. */
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("base64url")}$${(await scryptAsync(password, salt, 32, SCRYPT)).toString("base64url")}`;
}
async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, salt, hash] = stored.split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const a = await scryptAsync(password, Buffer.from(salt, "base64url"), 32, SCRYPT);
  const b = Buffer.from(hash, "base64url");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Who asks: a member by their id, or an API token. */
export interface Who {
  id: string;
  name: string | null;
  role: "viewer" | "editor" | "admin" | "owner";
}
const isAdmin = (w: Who) => w.role === "admin" || w.role === "owner";

/** The reports a share or an email can hold. None of them lists visits or anything that names a visitor. */
export const SECTIONS = ["overview", "acquisition", "conversions", "ecommerce", "search", "performance"] as const;
export type Section = (typeof SECTIONS)[number];
/** The dimensions a shared link may filter by: none narrow the visits enough to single one out on their own. */
const SHARED_FILTERS = new Set(["channel", "source", "utmSource", "utmMedium", "utmCampaign", "country", "device", "browser", "os", "page", "goal"]);

export interface SharingOptions {
  publicUrl: string;
  /** The mailer for the file's smtp:, or null when there is none. */
  mailer: () => Mailer | null;
  /** For webhooks; tests pass a fake. */
  fetch?: typeof fetch;
  log?: (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;
  clock?: () => number;
}

function obj(body: unknown, what: string): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad(`The body is ${what}.`);
  return body as Record<string, unknown>;
}
function only(b: Record<string, unknown>, keys: string[]) {
  const extra = Object.keys(b).filter((k) => !keys.includes(k));
  if (extra.length) throw bad(`${extra.join(", ")} is not part of it; it takes ${keys.join(", ")}.`);
}
function text(v: unknown, name: string, max: number): string {
  if (typeof v !== "string" || !v.trim() || v.trim().length > max) throw bad(`${name} is 1 to ${max} characters.`);
  return v.trim();
}
function recipients(v: unknown): string[] {
  if (!Array.isArray(v) || !v.length || v.length > 20 || v.some((x) => typeof x !== "string" || !EMAIL.test(x.trim())))
    throw bad("recipients is a list of 1 to 20 email addresses.");
  return [...new Set((v as string[]).map((x) => x.trim().toLowerCase()))];
}
function sections(v: unknown): Section[] {
  if (!Array.isArray(v) || !v.length || v.some((x) => !SECTIONS.includes(x as Section))) throw bad(`sections is a list of ${SECTIONS.join(", ")}.`);
  return SECTIONS.filter((s) => v.includes(s));
}
function filtersOf(v: unknown): Filter[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw bad('filters is a list such as ["country:is:DE|AT"].');
  try {
    return parseFilters(v as string[]);
  } catch (err) {
    if (err instanceof QueryError) throw bad(err.message);
    throw err;
  }
}
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot", "'": "#39" }[c]};`);

/** The parts of a date in a time zone: the day, the ISO week, the month, the weekday (1 is Monday) and the hour. */
export function zoned(t: number, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" })
      .formatToParts(new Date(t))
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday!) + 1;
  // The ISO week: the Thursday of the date's week decides its year.
  const d = Date.parse(`${date}T00:00:00Z`) + (4 - weekday) * DAY;
  const year = new Date(d).getUTCFullYear();
  const week = Math.floor((d - Date.UTC(year, 0, 1)) / (7 * DAY)) + 1;
  return { date, month: date.slice(0, 7), week: `${year}-W${String(week).padStart(2, "0")}`, weekday, day: Number(parts.day), hour: Number(parts.hour) };
}

/** When each kind of report is sent, in the file's time zone: daily at 08:00, weekly Mondays 09:00, monthly the 1st 09:00. */
export const SCHEDULE = { daily: { hour: 8, days: 1 }, weekly: { hour: 9, days: 7 }, monthly: { hour: 9, days: 30 } } as const;
type Every = keyof typeof SCHEDULE;

/** The period a report is for, and whether it is due: the period's first moment has passed and it was not sent for it. */
export function due(every: Every, last: string | null, now: number, timeZone: string): { period: string; due: boolean } {
  const z = zoned(now, timeZone);
  const period = every === "daily" ? z.date : every === "weekly" ? z.week : z.month;
  const first = every === "daily" || (every === "weekly" ? z.weekday === 1 : z.day === 1);
  return { period, due: period !== last && !(first && z.hour < SCHEDULE[every].hour) };
}

export function createSharing(
  db: DatabaseSync,
  analytics: Analytics,
  { publicUrl, mailer, fetch: doFetch = fetch, log = () => {}, clock = Date.now }: SharingOptions,
) {
  // A secret of this install, for unsubscribe links and shared links' access after their password.
  let secret = (db.prepare("SELECT value FROM settings WHERE key = 'sharing.secret'").get() as { value: string } | undefined)?.value;
  if (!secret) {
    secret = randomBytes(32).toString("base64url");
    db.prepare("INSERT INTO settings (key, value) VALUES ('sharing.secret', ?)").run(secret);
  }
  const sign = (v: string) => createHmac("sha256", secret!).update(v).digest("base64url");
  const verify = (v: string, sig: string) => {
    const a = Buffer.from(sign(v));
    const b = Buffer.from(sig);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const all = (sql: string, ...args: Array<string | number | null>) => db.prepare(sql).all(...args) as Row[];
  const one = (sql: string, ...args: Array<string | number | null>) => db.prepare(sql).get(...args) as Row | undefined;
  const now = () => new Date(clock()).toISOString();

  /* ------------------------------------------------------------ segments */

  const presentSegment = (s: Row) => ({
    id: s.id as string,
    name: s.name as string,
    filters: JSON.parse(s.filters as string) as Filter[],
    shared: s.shared === 1,
    owner: (s.owner_name as string | null) ?? null,
    mine: false,
    createdAt: s.created_at as string,
  });
  const segments = {
    /** The member's own segments and the team's. */
    list(who: Who) {
      return all("SELECT * FROM segments WHERE owner = ? OR shared = 1 ORDER BY name, id", who.id).map((s) => ({
        ...presentSegment(s),
        mine: s.owner === who.id,
      }));
    },
    create(who: Who, body: unknown) {
      const b = obj(body, "{ name, filters, shared }");
      only(b, ["name", "filters", "shared"]);
      const name = text(b.name, "name", 80);
      const filters = filtersOf(b.filters);
      if (!filters.length) throw bad("filters holds at least one filter.");
      if (b.shared !== undefined && typeof b.shared !== "boolean") throw bad("shared is true or false.");
      if ((one("SELECT COUNT(*) AS n FROM segments WHERE owner = ?", who.id)!.n as number) >= 200) throw bad("A member keeps at most 200 segments.");
      const sid = id();
      db.prepare("INSERT INTO segments (id, name, filters, owner, owner_name, shared, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        sid,
        name,
        JSON.stringify(filters),
        who.id,
        who.name,
        b.shared ? 1 : 0,
        now(),
      );
      return { ...presentSegment(one("SELECT * FROM segments WHERE id = ?", sid)!), mine: true };
    },
    /** Its owner deletes a segment, and an admin a shared one. */
    remove(who: Who, sid: string) {
      const s = one("SELECT * FROM segments WHERE id = ?", sid);
      if (!s || (s.owner !== who.id && !(s.shared === 1 && isAdmin(who)))) throw notFound("The segment");
      db.prepare("DELETE FROM segments WHERE id = ?").run(sid);
    },
    filters(sid: string | null): Filter[] {
      if (!sid) return [];
      const s = one("SELECT filters FROM segments WHERE id = ?", sid);
      return s ? (JSON.parse(s.filters as string) as Filter[]) : [];
    },
  };

  /* ------------------------------------------------------------ sections */

  /** What a section of a share or an email holds: totals and tables, never a visit or a visitor. */
  function sectionData(site: Site, section: Section, q: ReportQuery) {
    if (section === "overview" || section === "acquisition" || section === "conversions") {
      const r = analytics.report(site.name, q);
      const pick = (x: typeof r | NonNullable<typeof r.compare>) =>
        section === "overview"
          ? {
              totals: x.totals,
              series: x.series,
              channels: x.channels,
              pages: x.pages.map((p) => ({ path: p.path, title: p.title, views: p.views, visitors: p.visitors })),
              devices: x.devices,
              goals: x.goals,
            }
          : section === "acquisition"
            ? { totals: x.totals, channels: x.channels, sources: x.sources, campaigns: x.campaigns }
            : { totals: x.totals, goals: x.goals };
      const countries =
        section === "overview"
          ? analytics.breakdown(site.name, "country", { ...q, compare: null }, 10).rows.map((c) => ({ country: c.value, visitors: c.visitors }))
          : undefined;
      return {
        ...pick(r),
        ...(countries && { countries }),
        ...(section === "overview" && { annotations: r.annotations.map((a) => ({ date: a.date, text: a.text })) }),
        ...(r.compare && { compare: { period: r.compare.period, ...pick(r.compare) } }),
      };
    }
    if (section === "ecommerce") {
      const { site: _s, days: _d, from: _f, to: _t, ...rest } = analytics.ecommerce(site.name, q);
      return rest;
    }
    if (section === "search") {
      const engine = ENGINES.find((e) => site.searchConsole[e]) ?? "google";
      const r = analytics.searchConsole(site.name, engine, q);
      return {
        engine,
        totals: r.totals,
        hidden: r.hidden,
        queries: r.queries.slice(0, 100),
        pages: r.pages.slice(0, 100),
        compare: "compare" in r ? r.compare : undefined,
      };
    }
    const v = analytics.vitals(site.name, q);
    return {
      thresholds: v.thresholds,
      totals: v.totals,
      devices: v.devices,
      series: v.series,
      pages: v.pages.slice(0, 50),
      compare: v.compare && { totals: v.compare.totals },
    };
  }

  /* ------------------------------------------------------------- shares */

  const presentShare = (s: Row) => ({
    id: s.id as string,
    site: s.site as string,
    name: s.name as string,
    sections: JSON.parse(s.sections as string) as Section[],
    password: !!s.password_hash,
    expiresAt: (s.expires_at as string | null) ?? null,
    createdBy: (s.created_by as string | null) ?? null,
    createdAt: s.created_at as string,
    views: s.views as number,
    lastViewedAt: (s.last_viewed_at as string | null) ?? null,
  });
  // Opened shared links, a minute at a time: per link, and unlock attempts per link a quarter of an hour.
  const opened = new Map<string, { start: number; n: number }>();
  const limit = (key: string, max: number, ms: number) => {
    const t = clock();
    const w = opened.get(key);
    if (!w || t - w.start >= ms) {
      opened.set(key, { start: t, n: 1 });
      if (opened.size > 10_000) for (const [k, x] of opened) if (t - x.start >= ms) opened.delete(k);
      return;
    }
    if (++w.n > max) throw new AnalyticsError(429, "rate-limited", "Too many requests for this link; try again shortly.", Math.ceil((w.start + ms - t) / 1000));
  };
  /** The live share a token opens, or not found: revoked, expired or never made look the same. */
  const shareOf = (token: string) => {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw notFound("The link");
    const s = one("SELECT * FROM shares WHERE token_hash = ?", sha256(token));
    if (!s || (s.expires_at && (s.expires_at as string) <= now()) || !analytics.sites().some((x) => x.name === s.site)) throw notFound("The link");
    return s;
  };
  const accessFor = (s: Row) => {
    const until = clock() + 12 * HOUR;
    return { access: `${until}.${sign(`share:${s.id}:${until}`)}`, expiresAt: new Date(until).toISOString() };
  };
  const unlocked = (s: Row, access: string | undefined) => {
    if (!s.password_hash) return true;
    const [until, sig] = (access ?? "").split(".");
    return !!until && !!sig && Number(until) > clock() && verify(`share:${s.id}:${until}`, sig);
  };
  const shares = {
    list(site?: string) {
      return all(`SELECT * FROM shares${site ? " WHERE site = ?" : ""} ORDER BY created_at DESC`, ...(site ? [site] : [])).map(presentShare);
    },
    async create(who: Who, body: unknown) {
      const b = obj(body, "{ site, name, sections, password, expiresDays }");
      only(b, ["site", "name", "sections", "password", "expiresDays"]);
      const site = analytics.site(text(b.site, "site", 64));
      const name = text(b.name, "name", 80);
      const list = sections(b.sections);
      if (b.password !== undefined && b.password !== null && (typeof b.password !== "string" || b.password.length < 12 || b.password.length > 200))
        throw bad("password is 12 to 200 characters, or left out for a public link.");
      if (
        b.expiresDays !== undefined &&
        b.expiresDays !== null &&
        (!Number.isInteger(b.expiresDays) || (b.expiresDays as number) < 1 || (b.expiresDays as number) > 3650)
      )
        throw bad("expiresDays is 1 to 3650, or left out for a link that does not expire.");
      if ((one("SELECT COUNT(*) AS n FROM shares")!.n as number) >= 500) throw bad("The install keeps at most 500 shared links; revoke some first.");
      const token = randomBytes(24).toString("base64url");
      const sid = id();
      db.prepare(
        "INSERT INTO shares (id, site, name, token_hash, password_hash, sections, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        sid,
        site.name,
        name,
        sha256(token),
        typeof b.password === "string" ? await hashPassword(b.password) : null,
        JSON.stringify(list),
        b.expiresDays ? new Date(clock() + (b.expiresDays as number) * DAY).toISOString() : null,
        who.name,
        now(),
      );
      // The token is shown once; only its hash is kept.
      return { ...presentShare(one("SELECT * FROM shares WHERE id = ?", sid)!), url: `${publicUrl}/shared/${token}` };
    },
    revoke(sid: string) {
      if (!db.prepare("DELETE FROM shares WHERE id = ?").run(sid).changes) throw notFound("The shared link");
    },
    /** What a link opens: its name, site and sections, and whether it asks for a password. */
    open(token: string, access?: string) {
      limit(`open:${token}`, 120, 60_000);
      const s = shareOf(token);
      const site = analytics.site(s.site as string);
      return {
        name: s.name as string,
        site: site.name,
        sections: (JSON.parse(s.sections as string) as Section[]).filter((x) => x !== "ecommerce" || site.ecommerce),
        password: !!s.password_hash,
        unlocked: unlocked(s, access),
        currency: site.currency,
        expiresAt: (s.expires_at as string | null) ?? null,
      };
    },
    async unlock(token: string, body: unknown) {
      limit(`unlock:${token}`, 10, 15 * 60_000);
      const s = shareOf(token);
      const b = obj(body, "{ password }");
      if (!s.password_hash) return accessFor(s);
      if (typeof b.password !== "string" || !(await verifyPassword(b.password, s.password_hash as string)))
        throw new AnalyticsError(401, "invalid-token", "The password is not this link's.");
      return accessFor(s);
    },
    /** One section of a shared link, read-only, with the filters the link allows. */
    section(token: string, access: string | undefined, section: string, q: ReportQuery) {
      limit(`open:${token}`, 120, 60_000);
      const s = shareOf(token);
      if (!unlocked(s, access)) throw new AnalyticsError(401, "invalid-token", "This link asks for its password.");
      const list = JSON.parse(s.sections as string) as Section[];
      if (!list.includes(section as Section)) throw notFound("The section");
      const bad_ = (q.filters ?? []).find((f) => !SHARED_FILTERS.has(f.dimension));
      if (bad_) throw bad(`A shared link filters by ${[...SHARED_FILTERS].join(", ")}; not by ${bad_.dimension}.`);
      db.prepare("UPDATE shares SET views = views + 1, last_viewed_at = ? WHERE id = ?").run(now(), s.id as string);
      const site = analytics.site(s.site as string);
      return { site: site.name, section, days: q.range, data: sectionData(site, section as Section, q) };
    },
  };

  /* -------------------------------------------------------- email reports */

  const presentReport = (r: Row) => ({
    id: r.id as string,
    site: r.site as string,
    name: r.name as string,
    recipients: JSON.parse(r.recipients as string) as string[],
    every: r.every as Every,
    sections: JSON.parse(r.sections as string) as Section[],
    segment: (r.segment as string | null) ?? null,
    createdBy: (r.created_by as string | null) ?? null,
    createdAt: r.created_at as string,
    lastSentAt: (r.last_sent_at as string | null) ?? null,
    lastError: (r.last_error as string | null) ?? null,
  });
  const timeZone = () => analytics.smtp()?.timeZone ?? "UTC";

  /** The unsubscribe link of one recipient of a report. */
  const unsubscribeUrl = (rid: string, to: string) => {
    const v = Buffer.from(`${rid}\n${to}`).toString("base64url");
    return `${publicUrl}/api/v1/unsubscribe?token=${v}.${sign(`unsubscribe:${v}`)}`;
  };

  function render(site: Site, name: string, list: Section[], q: ReportQuery, segment: string | null) {
    const fmt = (n: number | null | undefined, digits = 0) =>
      n == null ? "–" : n.toLocaleString("en", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
    const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
    const money = (n: number) => `${fmt(n, 2)}${site.currency ? ` ${site.currency}` : ""}`;
    const html: string[] = [];
    const lines: string[] = [];
    const csv: Array<{ filename: string; contentType: string; content: string }> = [];
    const table = (title: string, head: string[], rows: Array<Array<string | number | null>>, file: string) => {
      if (!rows.length) return;
      html.push(
        `<h3 style="font:600 14px system-ui;margin:16px 0 6px">${escape(title)}</h3><table style="border-collapse:collapse;font:13px system-ui">` +
          `<tr>${head.map((h, i) => `<th style="text-align:${i ? "right" : "left"};padding:3px 10px;border-bottom:1px solid #ddd">${escape(h)}</th>`).join("")}</tr>` +
          rows
            .slice(0, 10)
            .map(
              (r) => `<tr>${r.map((c, i) => `<td style="text-align:${i ? "right" : "left"};padding:3px 10px">${escape(String(c ?? "–"))}</td>`).join("")}</tr>`,
            )
            .join("") +
          "</table>",
      );
      lines.push(`\n${title}`, ...rows.slice(0, 10).map((r) => `  ${r.map((c) => String(c ?? "-")).join("  ")}`));
      const cell = (c: string | number | null) => (c === null ? "" : /[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c));
      csv.push({
        filename: `${file}.csv`,
        contentType: "text/csv; charset=utf-8",
        content: [head, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n",
      });
    };
    const kpis = (items: Array<[string, string]>) => {
      html.push(
        `<p style="font:13px system-ui">${items.map(([k, v]) => `<span style="display:inline-block;margin:0 18px 6px 0"><b style="font-size:18px">${escape(v)}</b><br>${escape(k)}</span>`).join("")}</p>`,
      );
      lines.push(...items.map(([k, v]) => `${k}: ${v}`));
    };
    for (const section of list) {
      const title = section[0]!.toUpperCase() + section.slice(1);
      html.push(`<h2 style="font:600 16px system-ui;margin:24px 0 8px">${escape(title)}</h2>`);
      lines.push(`\n== ${title} ==`);
      const d = sectionData(site, section, q) as Row;
      if (section === "overview" || section === "acquisition" || section === "conversions") {
        const t = d.totals as Row;
        kpis([
          ["Visitors", fmt(t.visitors)],
          ["Visits", fmt(t.visits)],
          ["Page views", fmt(t.pageviews)],
          ["Bounce rate", pct(t.bounceRate)],
        ]);
        if (section === "overview")
          table(
            "Top pages",
            ["Page", "Views", "Visitors"],
            (d.pages as Row[]).map((p) => [p.path, p.views, p.visitors]),
            "pages",
          );
        if (section !== "conversions")
          table(
            "Channels",
            ["Channel", "Visits", "Visitors"],
            (d.channels as Row[]).map((c) => [c.channel, c.visits, c.visitors]),
            "channels",
          );
        if (section === "acquisition")
          table(
            "Sources",
            ["Source", "Visits", "Visitors"],
            (d.sources as Row[]).map((c) => [c.source ?? "Direct", c.visits, c.visitors]),
            "sources",
          );
        if (section !== "acquisition")
          table(
            "Goals",
            ["Goal", "Conversions", "Rate", "Value"],
            (d.goals as Row[]).map((g) => [g.name, g.visits, pct(g.rate), g.value === null ? null : money(g.value)]),
            "goals",
          );
      } else if (section === "ecommerce") {
        const t = d.totals as Row;
        kpis([
          ["Revenue", money(t.revenue)],
          ["Orders", fmt(t.orders)],
          ["Average order", money(t.averageOrder)],
          ["Refunds", fmt(t.refunds)],
        ]);
        table(
          "Products",
          ["SKU", "Product", "Sold", "Revenue"],
          (d.products as Row[]).map((p) => [p.sku, p.name, p.units, p.revenue]),
          "products",
        );
        table(
          "Revenue by source",
          ["Source", "Orders", "Revenue"],
          (d.sources as Row[]).filter((x) => x.orders).map((x) => [x.source ?? "Direct", x.orders, x.revenue]),
          "revenue-by-source",
        );
      } else if (section === "search") {
        const t = d.totals as Row;
        kpis([
          ["Clicks", fmt(t.clicks)],
          ["Impressions", fmt(t.impressions)],
          ["CTR", pct(t.ctr)],
          ["Position", fmt(t.position, 1)],
        ]);
        table(
          "Queries",
          ["Query", "Clicks", "Impressions", "Position"],
          (d.queries as Row[]).map((x) => [x.query, x.clicks, x.impressions, x.position]),
          "search-queries",
        );
      } else {
        const t = d.totals as Row;
        kpis([
          ["LCP p75", t.lcp.p75 === null ? "–" : `${(t.lcp.p75 / 1000).toFixed(1)} s`],
          ["INP p75", t.inp.p75 === null ? "–" : `${t.inp.p75} ms`],
          ["CLS p75", t.cls.p75 === null ? "–" : String(t.cls.p75)],
        ]);
        table(
          "Slowest pages",
          ["Page", "Device", "LCP ms", "INP ms", "CLS"],
          (d.pages as Row[]).map((p) => [p.path, p.device, p.lcp, p.inp, p.cls]),
          "web-vitals",
        );
      }
    }
    const period = analytics.report(site.name, { ...q, filters: [] });
    const span = `${period.from.slice(0, 10)} to ${new Date(Date.parse(period.to) - 1).toISOString().slice(0, 10)} (UTC)`;
    const head = `<h1 style="font:600 20px system-ui;margin:0 0 4px">${escape(name)}</h1><p style="font:13px system-ui;color:#555;margin:0">${escape(site.name)}, ${escape(span)}${segment ? `, segment ${escape(segment)}` : ""}</p>`;
    return { html: head + html.join(""), text: `${name}\n${site.name}, ${span}${segment ? `, segment ${segment}` : ""}\n${lines.join("\n")}`, csv };
  }

  async function send(r: Row, period: string | null) {
    const m = mailer();
    const smtp = analytics.smtp();
    if (!m || !smtp) throw new AnalyticsError(422, "invalid-body", "Email needs smtp: in the sites file, with its password in ANALYTICS_SMTP_PASSWORD.");
    const site = analytics.site(r.site as string);
    const report = presentReport(r);
    const days = SCHEDULE[report.every].days as Range;
    // Whole days up to the end of yesterday.
    const at = Math.floor(clock() / DAY) * DAY - 1;
    const seg = report.segment ? one("SELECT name FROM segments WHERE id = ?", report.segment) : undefined;
    const q: ReportQuery = { range: days, at, filters: segments.filters(report.segment), compare: "previous" };
    const body = render(site, report.name, report.sections, q, (seg?.name as string | undefined) ?? null);
    let error: string | null = null;
    for (const to of report.recipients) {
      const stop = unsubscribeUrl(report.id, to);
      try {
        await m.send({
          from: smtp.from,
          to,
          subject: `${report.name}: ${site.name}`,
          text: `${body.text}\n\nStop these emails: ${stop}\n`,
          html: `<div style="max-width:720px">${body.html}<p style="font:12px system-ui;color:#777;margin-top:24px">The tables are attached as CSV. <a href="${escape(stop)}">Stop these emails</a>.</p></div>`,
          attachments: body.csv,
          headers: { "List-Unsubscribe": `<${stop}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
        });
      } catch (err) {
        error = `${to}: ${(err as Error).message}`.slice(0, 500);
        log("warn", "email report not sent", { report: report.id, error });
      }
    }
    db.prepare("UPDATE email_reports SET last_period = COALESCE(?, last_period), last_sent_at = ?, last_error = ? WHERE id = ?").run(
      period,
      now(),
      error,
      report.id,
    );
    return { ...presentReport(one("SELECT * FROM email_reports WHERE id = ?", report.id)!), sent: report.recipients.length - (error ? 1 : 0) };
  }

  const reports = {
    list(site?: string) {
      return all(`SELECT * FROM email_reports${site ? " WHERE site = ?" : ""} ORDER BY name, id`, ...(site ? [site] : [])).map(presentReport);
    },
    create(who: Who, body: unknown) {
      const b = obj(body, "{ site, name, recipients, every, sections, segment }");
      only(b, ["site", "name", "recipients", "every", "sections", "segment"]);
      const site = analytics.site(text(b.site, "site", 64));
      if (!["daily", "weekly", "monthly"].includes(b.every as string)) throw bad("every is daily, weekly or monthly.");
      if (
        b.segment !== undefined &&
        b.segment !== null &&
        (typeof b.segment !== "string" || !one("SELECT 1 AS x FROM segments WHERE id = ? AND (shared = 1 OR owner = ?)", b.segment, who.id))
      )
        throw bad("segment is a saved segment you can see, or null for all visits.");
      if ((one("SELECT COUNT(*) AS n FROM email_reports")!.n as number) >= 200) throw bad("The install keeps at most 200 email reports.");
      const rid = id();
      // The first one goes out at the next period, not at once.
      const period = due(b.every as Every, null, clock(), timeZone()).period;
      db.prepare(
        "INSERT INTO email_reports (id, site, name, recipients, every, sections, segment, created_by, created_at, last_period) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        rid,
        site.name,
        text(b.name, "name", 80),
        JSON.stringify(recipients(b.recipients)),
        b.every as string,
        JSON.stringify(sections(b.sections)),
        (b.segment as string | null) ?? null,
        who.name,
        now(),
        period,
      );
      return presentReport(one("SELECT * FROM email_reports WHERE id = ?", rid)!);
    },
    remove(rid: string) {
      if (!db.prepare("DELETE FROM email_reports WHERE id = ?").run(rid).changes) throw notFound("The email report");
    },
    async sendNow(rid: string) {
      const r = one("SELECT * FROM email_reports WHERE id = ?", rid);
      if (!r) throw notFound("The email report");
      return send(r, null);
    },
    /** Sends the reports that are due. Called every few minutes. */
    async tick() {
      if (!mailer()) return 0;
      let n = 0;
      for (const r of all("SELECT * FROM email_reports")) {
        if (!analytics.sites().some((s) => s.name === r.site)) continue;
        const d = due(r.every as Every, (r.last_period as string | null) ?? null, clock(), timeZone());
        if (!d.due) continue;
        await send(r, d.period).catch((err) => log("warn", "email report not sent", { report: r.id, error: String(err) }));
        n++;
      }
      return n;
    },
    /** A recipient stops a report from the link in its email. */
    unsubscribe(token: string): boolean {
      const [v, sig] = token.split(".");
      if (!v || !sig || !verify(`unsubscribe:${v}`, sig)) return false;
      const [rid, to] = Buffer.from(v, "base64url").toString("utf8").split("\n");
      const r = one("SELECT recipients FROM email_reports WHERE id = ?", rid ?? "");
      if (!r) return true;
      const left = (JSON.parse(r.recipients as string) as string[]).filter((x) => x !== to);
      if (left.length) db.prepare("UPDATE email_reports SET recipients = ? WHERE id = ?").run(JSON.stringify(left), rid!);
      else db.prepare("DELETE FROM email_reports WHERE id = ?").run(rid!);
      return true;
    },
  };

  /* --------------------------------------------------------------- alerts */

  const presentRule = (r: Row) => ({
    id: r.id as string,
    site: r.site as string,
    name: r.name as string,
    kind: r.kind as "drop" | "spike",
    ratio: r.ratio as number,
    recipients: JSON.parse(r.recipients as string) as string[],
    webhook: (r.webhook as string | null) ?? null,
    enabled: r.enabled === 1,
    createdBy: (r.created_by as string | null) ?? null,
    createdAt: r.created_at as string,
    open: r.open_alert != null,
  });
  const presentAlert = (a: Row) => ({
    id: a.id as number,
    rule: a.rule as string,
    name: (a.name as string | null) ?? null,
    site: a.site as string,
    hour: a.hour as string,
    startedAt: a.started_at as string,
    endedAt: (a.ended_at as string | null) ?? null,
    visits: a.visits as number,
    usual: a.usual as number,
    sent: (a.sent as string | null) ?? null,
  });
  /** Weeks of the same hour the usual is the median of, and the least the usual must be for a drop to mean anything. */
  const BASELINE_WEEKS = 8;
  const MIN_USUAL = 10;

  /** Visits that started in an hour (UTC) and the median of the same hour of the same weekday over the weeks before. */
  function hourly(site: string, hour: number) {
    const count = (t: number) =>
      one(
        "SELECT COUNT(*) AS n FROM sessions WHERE site = ? AND started_at >= ? AND started_at < ?",
        site,
        new Date(t).toISOString(),
        new Date(t + HOUR).toISOString(),
      )!.n as number;
    const oldest = one("SELECT MIN(started_at) AS t FROM sessions WHERE site = ?", site)?.t as string | null;
    const weeks = Array.from({ length: BASELINE_WEEKS }, (_, k) => hour - (k + 1) * 7 * DAY).filter((t) => oldest && t >= Date.parse(oldest) - HOUR);
    const past = weeks.map(count).sort((a, b) => a - b);
    const usual = past.length ? (past.length % 2 ? past[past.length >> 1]! : (past[past.length / 2 - 1]! + past[past.length / 2]!) / 2) : null;
    return { visits: count(hour), usual, weeks: past.length };
  }

  async function notify(rule: ReturnType<typeof presentRule>, alert: { hour: string; visits: number; usual: number }) {
    const smtp = analytics.smtp();
    const m = mailer();
    const ratio = alert.usual ? alert.visits / alert.usual : 0;
    const what = rule.kind === "drop" ? `Visits fell to ${Math.round(ratio * 100)}% of the usual` : `Visits were ${ratio.toFixed(1)} times the usual`;
    const text = `${what} on ${rule.site} in the hour from ${alert.hour.slice(11, 16)} UTC on ${alert.hour.slice(0, 10)}: ${alert.visits} against a usual ${alert.usual}, the median of the same hour of the week over the ${BASELINE_WEEKS} weeks before.`;
    const sent: string[] = [];
    if (m && smtp)
      for (const to of rule.recipients)
        try {
          await m.send({
            from: smtp.from,
            to,
            subject: `${rule.name}: ${rule.site}`,
            text: `${text}\n\n${publicUrl}/overview?site=${encodeURIComponent(rule.site)}\n`,
            html: `<p style="font:14px system-ui">${escape(text)}</p><p style="font:14px system-ui"><a href="${escape(`${publicUrl}/overview?site=${encodeURIComponent(rule.site)}`)}">Open the overview</a></p>`,
          });
          sent.push("email");
        } catch (err) {
          log("warn", "alert email not sent", { rule: rule.id, error: String(err) });
        }
    if (rule.webhook)
      try {
        const res = await doFetch(rule.webhook, {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": "OpenAsy-Analytics" },
          body: JSON.stringify({
            type: "analytics.alert",
            rule: { id: rule.id, name: rule.name, kind: rule.kind, ratio: rule.ratio },
            site: rule.site,
            hour: alert.hour,
            visits: alert.visits,
            usual: alert.usual,
            text,
            url: `${publicUrl}/overview?site=${encodeURIComponent(rule.site)}`,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) sent.push("webhook");
        else log("warn", "alert webhook refused", { rule: rule.id, status: res.status });
      } catch (err) {
        log("warn", "alert webhook not reached", { rule: rule.id, error: String(err) });
      }
    return sent;
  }

  const alerts = {
    rules(site?: string) {
      return all(`SELECT * FROM alert_rules${site ? " WHERE site = ?" : ""} ORDER BY name, id`, ...(site ? [site] : [])).map(presentRule);
    },
    history(site?: string) {
      return all(
        `SELECT a.*, r.name FROM alerts a LEFT JOIN alert_rules r ON r.id = a.rule${site ? " WHERE a.site = ?" : ""} ORDER BY a.started_at DESC LIMIT 100`,
        ...(site ? [site] : []),
      ).map(presentAlert);
    },
    create(who: Who, body: unknown) {
      const b = obj(body, "{ site, name, kind, ratio, recipients, webhook }");
      only(b, ["site", "name", "kind", "ratio", "recipients", "webhook", "enabled"]);
      const site = analytics.site(text(b.site, "site", 64));
      if (b.kind !== "drop" && b.kind !== "spike") throw bad("kind is drop (visits an hour fall below a share of the usual) or spike (above a multiple).");
      const ratio = b.ratio ?? (b.kind === "drop" ? 0.5 : 2);
      if (typeof ratio !== "number" || (b.kind === "drop" ? !(ratio > 0 && ratio < 1) : !(ratio > 1 && ratio <= 100)))
        throw bad(
          b.kind === "drop"
            ? "ratio of a drop is a share of the usual, more than 0 and less than 1, such as 0.5."
            : "ratio of a spike is a multiple of the usual, more than 1, such as 2.",
        );
      const to = b.recipients === undefined || (Array.isArray(b.recipients) && !b.recipients.length) ? [] : recipients(b.recipients);
      let webhook: string | null = null;
      if (b.webhook !== undefined && b.webhook !== null && b.webhook !== "") {
        const u = typeof b.webhook === "string" ? URL.parse(b.webhook) : null;
        if (!u || !(u.protocol === "https:" || (u.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(u.hostname))) || u.username || u.password)
          throw bad("webhook is an https:// address (http:// only for localhost), without a user or password in it.");
        webhook = u.href;
      }
      if (!to.length && !webhook) throw bad("An alert goes to recipients, a webhook or both.");
      if ((one("SELECT COUNT(*) AS n FROM alert_rules")!.n as number) >= 200) throw bad("The install keeps at most 200 alert rules.");
      const rid = id();
      db.prepare(
        "INSERT INTO alert_rules (id, site, name, kind, ratio, recipients, webhook, enabled, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(rid, site.name, text(b.name, "name", 80), b.kind, ratio, JSON.stringify(to), webhook, b.enabled === false ? 0 : 1, who.name, now());
      return presentRule(one("SELECT * FROM alert_rules WHERE id = ?", rid)!);
    },
    update(rid: string, body: unknown) {
      const b = obj(body, "{ enabled }");
      only(b, ["enabled"]);
      if (typeof b.enabled !== "boolean") throw bad("enabled is true or false.");
      if (!db.prepare("UPDATE alert_rules SET enabled = ? WHERE id = ?").run(b.enabled ? 1 : 0, rid).changes) throw notFound("The alert rule");
      return presentRule(one("SELECT * FROM alert_rules WHERE id = ?", rid)!);
    },
    remove(rid: string) {
      if (!db.prepare("DELETE FROM alert_rules WHERE id = ?").run(rid).changes) throw notFound("The alert rule");
    },
    /**
     * Checks each rule against the last whole hour: a drop when visits are under the rule's share of the usual (and the
     * usual is at least 10), a spike when they pass its multiple (and are at least 10). An alert is sent when it starts
     * and marked ended at the first hour back to normal.
     */
    async check() {
      const hour = Math.floor(clock() / HOUR) * HOUR - HOUR;
      const key = new Date(hour).toISOString();
      let started = 0;
      for (const r of all("SELECT * FROM alert_rules WHERE enabled = 1 AND (checked_hour IS NULL OR checked_hour < ?)", key)) {
        if (!analytics.sites().some((s) => s.name === r.site)) continue;
        db.prepare("UPDATE alert_rules SET checked_hour = ? WHERE id = ?").run(key, r.id as string);
        const h = hourly(r.site as string, hour);
        const odd =
          h.usual !== null &&
          h.weeks >= 2 &&
          (r.kind === "drop"
            ? h.usual >= MIN_USUAL && h.visits < h.usual * (r.ratio as number)
            : h.visits >= MIN_USUAL && h.visits > h.usual * (r.ratio as number));
        if (odd && r.open_alert == null) {
          const aid = Number(
            db
              .prepare("INSERT INTO alerts (rule, site, started_at, hour, visits, usual) VALUES (?, ?, ?, ?, ?, ?)")
              .run(r.id as string, r.site as string, now(), key, h.visits, h.usual!).lastInsertRowid,
          );
          db.prepare("UPDATE alert_rules SET open_alert = ? WHERE id = ?").run(aid, r.id as string);
          const sent = await notify(presentRule(r), { hour: key, visits: h.visits, usual: h.usual! });
          db.prepare("UPDATE alerts SET sent = ? WHERE id = ?").run(sent.join(", ") || null, aid);
          started++;
        } else if (!odd && r.open_alert != null) {
          db.prepare("UPDATE alerts SET ended_at = ? WHERE id = ?").run(now(), r.open_alert as number);
          db.prepare("UPDATE alert_rules SET open_alert = NULL WHERE id = ?").run(r.id as string);
        }
      }
      return started;
    },
  };

  return { segments, shares, reports, alerts };
}

export type Sharing = ReturnType<typeof createSharing>;
