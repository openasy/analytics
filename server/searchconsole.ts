// What people searched before they came, from each search engine's own tools: Google Search Console, Bing Webmaster
// Tools and Yandex Webmaster, behind one interface. A site names its property in each under searchConsole in the sites
// file; the keys are in the environment, never in the file:
//
//   Google  ANALYTICS_GOOGLE_SERVICE_ACCOUNT  the path of a service account's JSON key, the account added as a user of
//                                             the property; or ANALYTICS_GOOGLE_CLIENT_ID, _CLIENT_SECRET and
//                                             _REFRESH_TOKEN of an OAuth client with the webmasters.readonly scope
//   Bing    ANALYTICS_BING_API_KEY            an API key from Bing Webmaster Tools, Settings, API access
//   Yandex  ANALYTICS_YANDEX_TOKEN            an OAuth token with the webmaster:hostinfo permission
//
// Each is imported once a day: every day not yet imported, up to 30 days back the first time, and the last three days
// again, since the engines settle their numbers a few days late. Queries and pages are kept a row a day with their
// impressions, clicks and average position.
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { Site } from "./config.ts";

export const ENGINES = ["google", "bing", "yandex"] as const;
export type EngineId = (typeof ENGINES)[number];

export interface SearchRow {
  day: string;
  kind: "query" | "page" | "total";
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  position: number | null;
}

/** One search engine's API: whether its key is set, and its rows for a property over whole days (UTC dates). */
export interface Engine {
  id: EngineId;
  /** Null when its key is set; otherwise what to set. */
  missing(): string | null;
  rows(property: string, from: string, to: string): Promise<SearchRow[]>;
}

type Fetch = typeof fetch;
type Env = Record<string, string | undefined>;
const DAY = 86_400_000;

function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

async function json(res: Response, what: string): Promise<any> {
  const text = await res.text();
  if (!res.ok) throw new Error(`${what} answered ${res.status}: ${text.replace(/\s+/g, " ").slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what} did not answer JSON.`);
  }
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString("base64url");

/**
 * Google Search Console's searchAnalytics.query, day by day, for queries with their page, for pages, and for the
 * day's totals (which include the queries Google keeps private). The token is a service account's signed JWT
 * exchanged at oauth2.googleapis.com, or an OAuth refresh token.
 */
export function google(env: Env, doFetch: Fetch = fetch, now = Date.now): Engine {
  let token: { value: string; until: number } | null = null;
  const scope = "https://www.googleapis.com/auth/webmasters.readonly";
  async function accessToken(): Promise<string> {
    if (token && token.until > now() + 60_000) return token.value;
    let body: URLSearchParams;
    if (env.ANALYTICS_GOOGLE_SERVICE_ACCOUNT) {
      const key = JSON.parse(readFileSync(env.ANALYTICS_GOOGLE_SERVICE_ACCOUNT, "utf8")) as { client_email: string; private_key: string; token_uri?: string };
      const iat = Math.floor(now() / 1000);
      const claims = { iss: key.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 };
      const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}`;
      const signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key).toString("base64url");
      body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` });
    } else {
      body = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: env.ANALYTICS_GOOGLE_CLIENT_ID ?? "",
        client_secret: env.ANALYTICS_GOOGLE_CLIENT_SECRET ?? "",
        refresh_token: env.ANALYTICS_GOOGLE_REFRESH_TOKEN ?? "",
      });
    }
    const r = await json(
      await doFetch("https://oauth2.googleapis.com/token", { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } }),
      "Google's token endpoint",
    );
    if (typeof r.access_token !== "string") throw new Error("Google's token endpoint gave no access_token.");
    token = { value: r.access_token, until: now() + (Number(r.expires_in) || 3600) * 1000 };
    return token.value;
  }
  async function query(property: string, day: string, dimensions: string[]) {
    const out: Array<{ keys?: string[]; clicks: number; impressions: number; position?: number }> = [];
    for (let startRow = 0; ; startRow += 25_000) {
      const r = await json(
        await doFetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`, {
          method: "POST",
          headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json" },
          body: JSON.stringify({ startDate: day, endDate: day, dimensions, type: "web", rowLimit: 25_000, startRow, dataState: "all" }),
        }),
        "Google Search Console",
      );
      const rows = Array.isArray(r.rows) ? r.rows : [];
      out.push(...rows);
      if (rows.length < 25_000 || startRow >= 100_000) return out;
    }
  }
  return {
    id: "google",
    missing: () =>
      env.ANALYTICS_GOOGLE_SERVICE_ACCOUNT || (env.ANALYTICS_GOOGLE_CLIENT_ID && env.ANALYTICS_GOOGLE_CLIENT_SECRET && env.ANALYTICS_GOOGLE_REFRESH_TOKEN)
        ? null
        : "ANALYTICS_GOOGLE_SERVICE_ACCOUNT, or ANALYTICS_GOOGLE_CLIENT_ID, ANALYTICS_GOOGLE_CLIENT_SECRET and ANALYTICS_GOOGLE_REFRESH_TOKEN",
    async rows(property, from, to) {
      const out: SearchRow[] = [];
      for (const day of daysBetween(from, to)) {
        const row = (kind: SearchRow["kind"], query: string, page: string, r: { clicks: number; impressions: number; position?: number }) =>
          out.push({ day, kind, query, page, clicks: Math.round(r.clicks), impressions: Math.round(r.impressions), position: r.position ?? null });
        for (const r of await query(property, day, [])) row("total", "", "", r);
        for (const r of await query(property, day, ["query", "page"])) row("query", r.keys?.[0] ?? "", r.keys?.[1] ?? "", r);
        for (const r of await query(property, day, ["page"])) row("page", "", r.keys?.[0] ?? "", r);
      }
      return out;
    },
  };
}

/** A WCF date, /Date(1316156400000-0700)/, as the UTC day it starts in the offset it gives. */
export function wcfDay(v: string): string | null {
  const m = /\/Date\((-?\d+)([+-]\d{4})?\)\//.exec(v);
  if (!m) return null;
  let t = Number(m[1]);
  if (m[2]) t += (m[2][0] === "-" ? -1 : 1) * (Number(m[2].slice(1, 3)) * 60 + Number(m[2].slice(3))) * 60_000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Bing Webmaster Tools' GetQueryStats and GetPageStats (JSON). Each gives the whole history it keeps in one answer, a
 * row for each query or page and date, updated weekly; the days asked for are kept. Bing gives no totals, so the
 * day's totals are the sum of its queries.
 */
export function bing(env: Env, doFetch: Fetch = fetch): Engine {
  const call = async (method: string, property: string) => {
    const url = `https://ssl.bing.com/webmaster/api.svc/json/${method}?${new URLSearchParams({ siteUrl: property, apikey: env.ANALYTICS_BING_API_KEY ?? "" })}`;
    const r = await json(await doFetch(url, { headers: { accept: "application/json" } }), "Bing Webmaster Tools");
    return (Array.isArray(r.d) ? r.d : []) as Array<{ Query: string; Date: string; Clicks: number; Impressions: number; AvgImpressionPosition?: number }>;
  };
  return {
    id: "bing",
    missing: () => (env.ANALYTICS_BING_API_KEY ? null : "ANALYTICS_BING_API_KEY"),
    async rows(property, from, to) {
      const out: SearchRow[] = [];
      const totals = new Map<string, { clicks: number; impressions: number; weighted: number }>();
      for (const [method, kind] of [
        ["GetQueryStats", "query"],
        ["GetPageStats", "page"],
      ] as const) {
        for (const r of await call(method, property)) {
          const day = wcfDay(r.Date);
          if (!day || day < from || day > to) continue;
          const position = r.AvgImpressionPosition && r.AvgImpressionPosition > 0 ? r.AvgImpressionPosition : null;
          out.push({
            day,
            kind,
            query: kind === "query" ? r.Query : "",
            page: kind === "page" ? r.Query : "",
            clicks: r.Clicks,
            impressions: r.Impressions,
            position,
          });
          if (kind === "query") {
            const t = totals.get(day) ?? { clicks: 0, impressions: 0, weighted: 0 };
            t.clicks += r.Clicks;
            t.impressions += r.Impressions;
            t.weighted += (position ?? 0) * r.Impressions;
            totals.set(day, t);
          }
        }
      }
      for (const [day, t] of totals)
        out.push({
          day,
          kind: "total",
          query: "",
          page: "",
          clicks: t.clicks,
          impressions: t.impressions,
          position: t.impressions ? t.weighted / t.impressions : null,
        });
      return out;
    },
  };
}

/**
 * Yandex Webmaster's API v4: the token's user id from /v4/user, then the host's popular search queries a day at a
 * time, with shows, clicks and average show position. Yandex gives queries only, not pages; the day's totals are the
 * sum of its queries.
 */
export function yandex(env: Env, doFetch: Fetch = fetch): Engine {
  let user: string | null = null;
  const get = async (path: string) =>
    json(
      await doFetch(`https://api.webmaster.yandex.net/v4${path}`, {
        headers: { authorization: `OAuth ${env.ANALYTICS_YANDEX_TOKEN ?? ""}`, accept: "application/json" },
      }),
      "Yandex Webmaster",
    );
  return {
    id: "yandex",
    missing: () => (env.ANALYTICS_YANDEX_TOKEN ? null : "ANALYTICS_YANDEX_TOKEN"),
    async rows(property, from, to) {
      if (!user) user = String((await get("/user")).user_id);
      const out: SearchRow[] = [];
      for (const day of daysBetween(from, to)) {
        let clicks = 0;
        let impressions = 0;
        let weighted = 0;
        for (let offset = 0; offset < 3000; offset += 500) {
          const q = new URLSearchParams({ order_by: "TOTAL_SHOWS", date_from: day, date_to: day, offset: String(offset), limit: "500" });
          for (const i of ["TOTAL_SHOWS", "TOTAL_CLICKS", "AVG_SHOW_POSITION"]) q.append("query_indicator", i);
          const r = await get(`/user/${encodeURIComponent(user)}/hosts/${encodeURIComponent(property)}/search-queries/popular?${q}`);
          const queries = (Array.isArray(r.queries) ? r.queries : []) as Array<{ query_text: string; indicators?: Record<string, number> }>;
          for (const x of queries) {
            const shows = Math.round(x.indicators?.TOTAL_SHOWS ?? 0);
            const c = Math.round(x.indicators?.TOTAL_CLICKS ?? 0);
            const position = x.indicators?.AVG_SHOW_POSITION ?? null;
            out.push({ day, kind: "query", query: x.query_text, page: "", clicks: c, impressions: shows, position });
            clicks += c;
            impressions += shows;
            weighted += (position ?? 0) * shows;
          }
          if (queries.length < 500) break;
        }
        if (impressions) out.push({ day, kind: "total", query: "", page: "", clicks, impressions, position: weighted / impressions });
      }
      return out;
    },
  };
}

export function engines(env: Env, doFetch: Fetch = fetch, now = Date.now): Record<EngineId, Engine> {
  return { google: google(env, doFetch, now), bing: bing(env, doFetch), yandex: yandex(env, doFetch) };
}

/** Imports what each site's search engines have that is not kept yet. Errors are kept per site and engine, for the page. */
export function searchImporter(db: DatabaseSync, list: Record<EngineId, Engine>, now = Date.now) {
  const insert = db.prepare(
    `INSERT INTO search_console (site, engine, day, kind, query, page, clicks, impressions, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (site, engine, kind, day, query, page) DO UPDATE SET clicks = excluded.clicks, impressions = excluded.impressions, position = excluded.position`,
  );
  const state = db.prepare(
    `INSERT INTO search_console_imports (site, engine, property, last_day, last_at, error) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (site, engine) DO UPDATE SET property = excluded.property, last_day = COALESCE(excluded.last_day, last_day), last_at = excluded.last_at, error = excluded.error`,
  );
  return {
    async run(sites: Site[]) {
      const today = Math.floor(now() / DAY) * DAY;
      const to = new Date(today - DAY).toISOString().slice(0, 10);
      for (const site of sites)
        for (const id of ENGINES) {
          const property = site.searchConsole[id];
          const engine = list[id];
          if (!property || engine.missing()) continue;
          const last = db.prepare("SELECT last_day, property FROM search_console_imports WHERE site = ? AND engine = ?").get(site.name, id) as
            { last_day: string | null; property: string } | undefined;
          // Another property starts over; otherwise the last three days are asked again, as the engines settle them late.
          const fresh = !last?.last_day || last.property !== property;
          const from = new Date(fresh ? today - 30 * DAY : Math.min(Date.parse(`${last.last_day}T00:00:00Z`) + DAY, today - 3 * DAY))
            .toISOString()
            .slice(0, 10);
          try {
            const rows = await engine.rows(property, from, to);
            db.exec("BEGIN");
            try {
              if (fresh) db.prepare("DELETE FROM search_console WHERE site = ? AND engine = ?").run(site.name, id);
              db.prepare("DELETE FROM search_console WHERE site = ? AND engine = ? AND day >= ? AND day <= ?").run(site.name, id, from, to);
              for (const r of rows) insert.run(site.name, id, r.day, r.kind, r.query.slice(0, 500), r.page.slice(0, 1000), r.clicks, r.impressions, r.position);
              state.run(site.name, id, property, to, new Date(now()).toISOString(), null);
              db.exec("COMMIT");
            } catch (err) {
              db.exec("ROLLBACK");
              throw err;
            }
          } catch (err) {
            state.run(site.name, id, property, null, new Date(now()).toISOString(), (err as Error).message.slice(0, 500));
          }
        }
    },
  };
}

/** The search report of a site over a window: totals, queries with their page, and pages, from one engine. */
export function searchReportOf(db: DatabaseSync, site: Site, engine: EngineId, from: string, to: string) {
  const all = (sql: string, ...args: Array<string | number>) => db.prepare(sql).all(...args) as Array<Record<string, any>>;
  const where = "site = ? AND engine = ? AND day >= ? AND day <= ?";
  const args = [site.name, engine, from, to];
  const t = db
    .prepare(
      `SELECT COALESCE(SUM(clicks), 0) AS clicks, COALESCE(SUM(impressions), 0) AS impressions, SUM(position * impressions) AS weighted
       FROM search_console WHERE ${where} AND kind = 'total'`,
    )
    .get(...args) as Record<string, number | null>;
  const group = (kind: "query" | "page", cols: string) =>
    all(
      `SELECT ${cols}, SUM(clicks) AS clicks, SUM(impressions) AS impressions, SUM(position * impressions) / NULLIF(SUM(impressions), 0) AS position
       FROM search_console WHERE ${where} AND kind = ? GROUP BY ${cols} ORDER BY clicks DESC, impressions DESC LIMIT 1000`,
      ...args,
      kind,
    ).map((r) => ({
      ...(kind === "query" ? { query: r.query as string, page: (r.page as string) || null } : { page: r.page as string }),
      clicks: r.clicks as number,
      impressions: r.impressions as number,
      ctr: r.impressions ? (r.clicks as number) / (r.impressions as number) : 0,
      position: r.position == null ? null : Math.round((r.position as number) * 10) / 10,
    }));
  const queries = group("query", "query, page");
  const clicks = t.clicks ?? 0;
  const impressions = t.impressions ?? 0;
  const shown = (db.prepare(`SELECT COALESCE(SUM(clicks), 0) AS n FROM search_console WHERE ${where} AND kind = 'query'`).get(...args) as { n: number }).n;
  return {
    totals: {
      clicks,
      impressions,
      ctr: impressions ? clicks / impressions : 0,
      position: impressions && t.weighted ? Math.round((t.weighted / impressions) * 10) / 10 : null,
    },
    /** Clicks from queries the engine keeps private, too rare to show: the day's total less its listed queries. */
    hidden: Math.max(0, clicks - shown),
    queries,
    pages: group("page", "page"),
  };
}
