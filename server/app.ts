import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createGunzip } from "node:zlib";
import { AuthError, identityOrigin, mergeOpenApi, sendProblem, type Auth, type Role } from "@openasy/auth";
import { log } from "./log.ts";
import { countRequest, renderMetrics } from "./metrics.ts";
import type { ProductLink } from "./products.ts";
import {
  AnalyticsError,
  BREAKDOWNS,
  CHUNK_LIMIT,
  parseLimit,
  parseRange,
  type Analytics,
  type Breakdown,
  type ProblemCode,
  type ReportQuery,
} from "./analytics.ts";
import { clientIp } from "./geo.ts";
import { parseCompare, parseFilters, QueryError } from "./query.ts";
import { ENGINES, type EngineId } from "./searchconsole.ts";
import type { Sharing, Who } from "./sharing.ts";

export interface AppOptions {
  db: DatabaseSync;
  analytics: Analytics;
  version: string;
  /** The address people and pages reach the product at; the script sends to it. */
  publicUrl: string;
  /** Sign-in, sessions, members and API tokens (ADR 0002, 0003). */
  auth: Auth;
  /** For tests and local scripts: one shared token with the admin role. main.ts never sets it. */
  adminToken?: string;
  /** The built tracker (dist/tracker/a.js), wrapped per site at /s/<site>.js. */
  tracker?: string;
  /** The replay recorder and the heatmap overlay (dist/tracker/replay.js, heatmap.js), at /s/replay.js and /s/heatmap.js. */
  replayScript?: string;
  heatmapScript?: string;
  /** Built web UI; omit to run headless (ADR 0018). */
  webDir?: string;
  /** Built API reference (Swagger UI), served at /api/docs. */
  docsDir?: string;
  /** The OpenAPI description, served at /api/openapi.json with this release's version. */
  openapi?: Record<string, unknown>;
  /** false when /metrics is served on its own port instead (ADR 0026). */
  serveMetrics?: boolean;
  /** The install's OpenAsy products and their addresses, from OPENASY_PRODUCTS, for the product switcher. */
  products?: ProductLink[];
  /** Proxies whose X-Forwarded-For is believed, from ANALYTICS_TRUSTED_PROXIES; the sites file can add more. */
  trustedProxies?: string[];
  /** Segments, email reports, shared links and alerts. */
  sharing: Sharing;
}

function metricsText(analytics: Analytics, version: string) {
  return renderMetrics(version, { ...analytics.gauges(), fileError: !!analytics.summary().file?.error });
}

/** Serves only /metrics, for a port that is not exposed with the rest (ANALYTICS_METRICS_PORT). */
export function createMetricsHandler(analytics: Analytics, version: string) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/metrics") return problem(res, 404, "not-found");
    send(res, 200, metricsText(analytics, version), "text/plain; version=0.0.4");
  };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// Identity keeps people's theme and language when they sign in through it; the pages read them there (ADR 0033).
const IDENTITY = identityOrigin(process.env);

/**
 * The pages run nothing from elsewhere. The sites' own origins are allowed only where the heatmap and the replays need
 * them: the heatmap frames a site's page, and a replay shows the page's images, styles and fonts as they were.
 */
function securityHeaders(sites: string[] = []) {
  const s = sites.length ? ` ${sites.join(" ")}` : "";
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "content-security-policy": `default-src 'self'; connect-src 'self'${IDENTITY ? ` ${IDENTITY}` : ""}; img-src 'self' data: blob:${s}; style-src 'self' 'unsafe-inline'${s}; font-src 'self' data:${s}; frame-src 'self'${s}; frame-ancestors 'none'`,
  };
}
let SECURITY_HEADERS = securityHeaders();

/** Largest batch accepted, after decompression. Fifty events with their addresses are a few KiB. */
const BATCH_LIMIT = 64 * 1024;

function send(res: ServerResponse, status: number, body: string | Buffer, type = "application/json", headers: Record<string, string> = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers, "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const json = (res: ServerResponse, status: number, data: unknown, headers?: Record<string, string>) =>
  send(res, status, JSON.stringify(data), "application/json", headers);

const TITLES: Record<ProblemCode, string> = {
  "invalid-token": "Invalid token",
  "invalid-json": "Invalid JSON",
  "invalid-body": "Invalid request body",
  "invalid-batch": "Invalid batch",
  "forbidden-origin": "Origin not allowed",
  "not-found": "Not found",
  "rate-limited": "Too many events",
  "payload-too-large": "Payload too large",
  "internal-error": "Internal error",
};

/** RFC 9457 Problem Details (ADR 0024). `code` is the stable part clients match on. */
function problem(res: ServerResponse, status: number, code: ProblemCode, detail?: string, headers: Record<string, string> = {}) {
  const body = { type: `https://openasy.github.io/problems/${code}`, title: TITLES[code], status, code, ...(detail && { detail }) };
  send(res, status, JSON.stringify(body), "application/problem+json", headers);
}

/** Serves a file from dir, or returns false when the path is outside it or missing. */
async function serveFile(res: ServerResponse, dir: string, relative: string): Promise<boolean> {
  const file = normalize(join(dir, relative));
  if (!file.startsWith(normalize(dir)) || !extname(file)) return false;
  try {
    send(res, 200, await readFile(file), TYPES[extname(file)] ?? "application/octet-stream");
    return true;
  } catch {
    return false;
  }
}

/** Reads the whole body, gunzipping it when sent with `Content-Encoding: gzip`, up to limit bytes. */
async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const encoding = req.headers["content-encoding"];
  if (encoding && encoding !== "gzip" && encoding !== "identity") throw new AnalyticsError(400, "invalid-body", "Content-Encoding must be gzip or absent.");
  const source = encoding === "gzip" ? req.pipe(createGunzip()) : req;
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of source as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > limit) throw new AnalyticsError(413, "payload-too-large", `The body must be at most ${Math.round(limit / 1024)} KiB.`);
      chunks.push(chunk);
    }
  } catch (err) {
    if (err instanceof AnalyticsError) throw err;
    throw new AnalyticsError(400, "invalid-body", "The gzip body could not be read.");
  }
  return Buffer.concat(chunks);
}

/** A small JSON body, such as an annotation. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const raw = await readBody(req, 16 * 1024);
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new AnalyticsError(400, "invalid-json", "The body must be a JSON object.");
  }
}

function tokenMatches(header: string | undefined, expected: string | undefined): boolean {
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The role a route needs (ADR 0003); "none" for the version and for batches, which check their own origin or key. */
type Access = "none" | Role;
interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
  /** Who is asking: a member's name or email, or an API token's name; null for the shared test token. */
  who: string | null;
  /** The member or token asking, for what is theirs, such as their segments. */
  user: Who;
}
interface Route {
  method: string;
  /** Path pattern; each `:name` matches one segment. */
  path: string;
  auth: Access;
  handle: (ctx: Ctx) => unknown;
}

/** A query parameter of 1 to 128 characters, or undefined. */
function param(url: URL, name: string, required = false): string | undefined {
  const v = url.searchParams.get(name);
  if (v === null && !required) return undefined;
  if (v === null || v.length < 1 || v.length > 128)
    throw new AnalyticsError(422, "invalid-body", `${name} is ${required ? "required: " : ""}1 to 128 characters.`);
  return v;
}

export function createApp({
  db,
  analytics,
  version,
  publicUrl,
  auth,
  adminToken,
  tracker,
  replayScript,
  heatmapScript,
  webDir,
  docsDir,
  openapi,
  serveMetrics = true,
  products = [],
  trustedProxies = [],
  sharing,
}: AppOptions) {
  // The served description includes /api/v1/auth from @openasy/auth, so the API reference documents sign-in too.
  const spec = openapi && JSON.stringify({ ...mergeOpenApi(openapi), info: { ...(openapi.info as object), version } });
  const noContent = (res: ServerResponse) => {
    res.writeHead(204, SECURITY_HEADERS).end();
  };
  const cursor = (url: URL) => url.searchParams.get("cursor") ?? undefined;
  const limit = (url: URL) => parseLimit(url.searchParams.get("limit"));
  /** The period, filters and comparison of a report request. */
  const reportQuery = (url: URL): ReportQuery => {
    try {
      return {
        range: parseRange(url.searchParams.get("days")),
        filters: parseFilters(url.searchParams.getAll("filter")),
        compare: parseCompare(url.searchParams.get("compare")),
      };
    } catch (err) {
      if (err instanceof QueryError) throw new AnalyticsError(422, "invalid-body", err.message);
      throw err;
    }
  };
  const filters = (url: URL) => {
    try {
      return parseFilters(url.searchParams.getAll("filter"));
    } catch (err) {
      if (err instanceof QueryError) throw new AnalyticsError(422, "invalid-body", err.message);
      throw err;
    }
  };
  const site = (url: URL) => param(url, "site", true)!;
  /** A whole number query parameter between min and max, or its default. */
  const int = (url: URL, name: string, min: number, max: number, fallback: number) => {
    const v = url.searchParams.get(name);
    if (v === null) return fallback;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new AnalyticsError(422, "invalid-body", `${name} is a whole number from ${min} to ${max}.`);
    return n;
  };
  const oneOf = <T extends string>(url: URL, name: string, values: readonly T[], fallback: T): T => {
    const v = url.searchParams.get(name);
    if (v === null) return fallback;
    if (!values.includes(v as T)) throw new AnalyticsError(422, "invalid-body", `${name} is one of ${values.join(", ")}.`);
    return v as T;
  };
  const pagePath = (url: URL) => {
    const p = url.searchParams.get("page");
    if (!p || !p.startsWith("/") || p.length > 512)
      throw new AnalyticsError(422, "invalid-body", "page is a page's path, such as /pricing; * matches any characters.");
    return p;
  };
  const page = <K extends string, T>(key: K, p: { items: T[]; nextCursor?: string }) =>
    ({ [key]: p.items, ...(p.nextCursor && { nextCursor: p.nextCursor }) }) as Record<K, T[]> & { nextCursor?: string };

  const routes: Route[] = [
    { method: "GET", path: "/api/v1/version", auth: "none", handle: () => ({ product: "analytics", version }) },
    { method: "GET", path: "/api/v1/products", auth: "viewer", handle: () => ({ products }) },
    { method: "GET", path: "/api/v1/summary", auth: "viewer", handle: () => analytics.summary() },

    // The sites, as the file sets them. There is no route that adds, changes or removes one.
    { method: "GET", path: "/api/v1/sites", auth: "viewer", handle: () => ({ sites: analytics.siteList(publicUrl), file: analytics.summary().file }) },
    { method: "GET", path: "/api/v1/settings", auth: "viewer", handle: () => analytics.settingsFile() },

    // Reports.
    { method: "GET", path: "/api/v1/report", auth: "viewer", handle: ({ url }) => analytics.report(site(url), reportQuery(url)) },
    {
      method: "GET",
      path: "/api/v1/breakdown",
      auth: "viewer",
      handle: ({ url }) => {
        const dimension = url.searchParams.get("dimension") as Breakdown | null;
        if (!dimension || !BREAKDOWNS.includes(dimension)) throw new AnalyticsError(422, "invalid-body", `dimension is one of ${BREAKDOWNS.join(", ")}.`);
        return analytics.breakdown(site(url), dimension, reportQuery(url), parseLimit(url.searchParams.get("limit"), 500, 50));
      },
    },
    { method: "GET", path: "/api/v1/realtime", auth: "viewer", handle: ({ url }) => analytics.realtime(site(url), filters(url)) },
    { method: "GET", path: "/api/v1/vitals", auth: "viewer", handle: ({ url }) => analytics.vitals(site(url), reportQuery(url)) },
    { method: "GET", path: "/api/v1/frustration", auth: "viewer", handle: ({ url }) => analytics.frustration(site(url), reportQuery(url)) },
    {
      method: "GET",
      path: "/api/v1/annotations",
      auth: "viewer",
      handle: ({ url }) => analytics.annotations(site(url), url.searchParams.has("days") ? parseRange(url.searchParams.get("days")) : undefined),
    },
    {
      method: "POST",
      path: "/api/v1/annotations",
      auth: "editor",
      handle: async ({ req, res, url, who }) => json(res, 201, analytics.addAnnotation(site(url), await readJson(req), who)),
    },
    {
      method: "DELETE",
      path: "/api/v1/annotations/:id",
      auth: "editor",
      handle: ({ res, url, params }) => (analytics.deleteAnnotation(site(url), params[0]!), noContent(res)),
    },
    {
      method: "GET",
      path: "/api/v1/visits",
      auth: "viewer",
      handle: ({ url }) =>
        page(
          "visits",
          analytics.visits(
            {
              site: site(url),
              visitor: param(url, "visitor"),
              user: param(url, "user"),
              range: url.searchParams.has("days") ? parseRange(url.searchParams.get("days")) : undefined,
              filters: filters(url),
            },
            cursor(url),
            limit(url),
          ),
        ),
    },
    { method: "GET", path: "/api/v1/visits/:id", auth: "viewer", handle: ({ url, params }) => analytics.visit(param(url, "site", true)!, params[0]!) },

    {
      method: "GET",
      path: "/api/v1/funnels",
      auth: "viewer",
      handle: ({ url }) => analytics.funnels(site(url), reportQuery(url)),
    },
    {
      method: "GET",
      path: "/api/v1/forms",
      auth: "viewer",
      handle: ({ url }) => analytics.forms(site(url), reportQuery(url)),
    },
    {
      method: "GET",
      path: "/api/v1/heatmap",
      auth: "viewer",
      handle: ({ url }) => {
        const path = url.searchParams.get("path") ?? "/";
        if (!path.startsWith("/") || path.length > 512) throw new AnalyticsError(422, "invalid-body", "path is a page's path, such as /pricing.");
        const device = param(url, "device");
        if (device && !["desktop", "mobile", "tablet"].includes(device)) throw new AnalyticsError(422, "invalid-body", "device is desktop, mobile or tablet.");
        return analytics.heatmap(site(url), path, reportQuery(url), device);
      },
    },
    {
      method: "GET",
      path: "/api/v1/replays",
      auth: "viewer",
      handle: ({ url }) => page("replays", analytics.replays(site(url), parseRange(url.searchParams.get("days")), cursor(url), limit(url), filters(url))),
    },
    { method: "GET", path: "/api/v1/replays/:id", auth: "viewer", handle: ({ url, params }) => analytics.recording(param(url, "site", true)!, params[0]!) },

    // Ecommerce, attribution, paths, retention, site search and the search engines.
    { method: "GET", path: "/api/v1/ecommerce", auth: "viewer", handle: ({ url }) => analytics.ecommerce(site(url), reportQuery(url)) },
    {
      method: "GET",
      path: "/api/v1/attribution",
      auth: "viewer",
      handle: ({ url }) =>
        analytics.attribution(
          site(url),
          param(url, "goal", true)!,
          reportQuery(url),
          int(url, "lookback", 1, 90, 30),
          oneOf(url, "by", ["channel", "source", "campaign"] as const, "channel"),
        ),
    },
    {
      method: "GET",
      path: "/api/v1/paths",
      auth: "viewer",
      handle: ({ url }) =>
        analytics.paths(site(url), pagePath(url), oneOf(url, "direction", ["from", "to"] as const, "from"), int(url, "steps", 1, 5, 3), reportQuery(url)),
    },
    {
      method: "GET",
      path: "/api/v1/retention",
      auth: "viewer",
      handle: ({ url }) => analytics.retention(site(url), int(url, "weeks", 2, 26, 8), parseRange(url.searchParams.get("days") ?? "30"), filters(url)),
    },
    { method: "GET", path: "/api/v1/sitesearch", auth: "viewer", handle: ({ url }) => analytics.siteSearch(site(url), reportQuery(url)) },
    {
      method: "GET",
      path: "/api/v1/search-console",
      auth: "viewer",
      handle: ({ url }) => analytics.searchConsole(site(url), oneOf<EngineId>(url, "engine", ENGINES, "google"), reportQuery(url)),
    },

    // Saved segments: a member's own, and the team's.
    { method: "GET", path: "/api/v1/segments", auth: "viewer", handle: ({ user }) => ({ segments: sharing.segments.list(user) }) },
    {
      method: "POST",
      path: "/api/v1/segments",
      auth: "viewer",
      handle: async ({ req, res, user }) => json(res, 201, sharing.segments.create(user, await readJson(req))),
    },
    {
      method: "DELETE",
      path: "/api/v1/segments/:id",
      auth: "viewer",
      handle: ({ res, params, user }) => (sharing.segments.remove(user, params[0]!), noContent(res)),
    },

    // Email reports, shared links and alerts.
    {
      method: "GET",
      path: "/api/v1/email-reports",
      auth: "viewer",
      handle: ({ url }) => ({ reports: sharing.reports.list(param(url, "site")), smtp: !!analytics.smtp() }),
    },
    {
      method: "POST",
      path: "/api/v1/email-reports",
      auth: "editor",
      handle: async ({ req, res, user }) => json(res, 201, sharing.reports.create(user, await readJson(req))),
    },
    { method: "POST", path: "/api/v1/email-reports/:id/send", auth: "editor", handle: ({ params }) => sharing.reports.sendNow(params[0]!) },
    {
      method: "DELETE",
      path: "/api/v1/email-reports/:id",
      auth: "editor",
      handle: ({ res, params }) => (sharing.reports.remove(params[0]!), noContent(res)),
    },
    { method: "GET", path: "/api/v1/shares", auth: "viewer", handle: ({ url }) => ({ shares: sharing.shares.list(param(url, "site")) }) },
    {
      method: "POST",
      path: "/api/v1/shares",
      auth: "editor",
      handle: async ({ req, res, user }) => json(res, 201, await sharing.shares.create(user, await readJson(req))),
    },
    { method: "DELETE", path: "/api/v1/shares/:id", auth: "editor", handle: ({ res, params }) => (sharing.shares.revoke(params[0]!), noContent(res)) },
    {
      method: "GET",
      path: "/api/v1/alerts",
      auth: "viewer",
      handle: ({ url }) => ({ rules: sharing.alerts.rules(param(url, "site")), alerts: sharing.alerts.history(param(url, "site")), smtp: !!analytics.smtp() }),
    },
    {
      method: "POST",
      path: "/api/v1/alerts",
      auth: "editor",
      handle: async ({ req, res, user }) => json(res, 201, sharing.alerts.create(user, await readJson(req))),
    },
    { method: "PATCH", path: "/api/v1/alerts/:id", auth: "editor", handle: async ({ req, params }) => sharing.alerts.update(params[0]!, await readJson(req)) },
    { method: "DELETE", path: "/api/v1/alerts/:id", auth: "editor", handle: ({ res, params }) => (sharing.alerts.remove(params[0]!), noContent(res)) },

    // A shared link, for people without an account: read-only totals, never a visit.
    {
      method: "GET",
      path: "/api/v1/shared/:token",
      auth: "none",
      handle: ({ req, params }) => sharing.shares.open(params[0]!, header(req, "x-share-access")),
    },
    {
      method: "POST",
      path: "/api/v1/shared/:token/unlock",
      auth: "none",
      handle: async ({ req, params }) => sharing.shares.unlock(params[0]!, await readJson(req)),
    },
    {
      method: "GET",
      path: "/api/v1/shared/:token/report",
      auth: "none",
      handle: ({ req, url, params }) =>
        sharing.shares.section(params[0]!, header(req, "x-share-access"), url.searchParams.get("section") ?? "overview", reportQuery(url)),
    },
    {
      method: "GET",
      path: "/api/v1/unsubscribe",
      auth: "none",
      handle: ({ res, url }) => {
        const ok = sharing.reports.unsubscribe(url.searchParams.get("token") ?? "");
        send(
          res,
          ok ? 200 : 404,
          `<!doctype html><meta charset="utf-8"><title>OpenAsy Analytics</title><p style="font:16px system-ui;margin:3rem auto;max-width:32rem">${
            ok ? "You will not get this report any more." : "This link is not one Analytics sent."
          }</p>`,
          "text/html; charset=utf-8",
        );
      },
    },

    // A visitor's data, for requests under GDPR and KVKK (ADR 0015).
    { method: "GET", path: "/api/v1/visitors/:id", auth: "admin", handle: ({ url, params }) => analytics.visitor(param(url, "site", true)!, params[0]!) },
    {
      method: "DELETE",
      path: "/api/v1/visitors/:id",
      auth: "admin",
      handle: ({ res, url, params }) => (analytics.deleteVisitor(param(url, "site", true)!, params[0]!), noContent(res)),
    },
  ];

  const compiled = routes.map((r) => ({ ...r, re: new RegExp(`^${r.path.replace(/:[a-z]+/g, "([^/]+)")}$`) }));

  /** The page's origin, echoed back when it is one of a site's, so fetch() from that page may read the answer. */
  function cors(req: IncomingMessage): Record<string, string> {
    const origin = req.headers.origin;
    if (!origin || !analytics.sites().some((s) => s.domains.includes(origin))) return { vary: "Origin" };
    return { "access-control-allow-origin": origin, vary: "Origin" };
  }

  /** A batch from a page (text/plain, as navigator.sendBeacon sends it, or JSON) or from a site's servers with its key. */
  async function collect(req: IncomingMessage, res: ServerResponse) {
    const headers = cors(req);
    try {
      const raw = await readBody(req, BATCH_LIMIT);
      let body: unknown;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        throw new AnalyticsError(400, "invalid-json", "The body must be a JSON object.");
      }
      const key = req.headers["x-analytics-key"];
      const result = analytics.ingest({
        body,
        origin: req.headers.origin,
        key: typeof key === "string" ? key : undefined,
        userAgent: req.headers["user-agent"],
        // Only to find the visit's place when it starts; it is not stored or logged.
        ip: clientIp(req.socket.remoteAddress, req.headers["x-forwarded-for"], [...trustedProxies, ...analytics.trustedProxies()]),
      });
      json(res, 202, result, headers);
    } catch (err) {
      if (!(err instanceof AnalyticsError)) throw err;
      problem(res, err.status, err.code, err.message, { ...headers, ...(err.retryAfter ? { "retry-after": String(err.retryAfter) } : {}) });
      if (!req.complete) req.resume();
    }
  }

  /** A chunk of a visit's replay, gzipped, with the visit's ids in the query, from one of the site's pages. */
  async function replayChunk(req: IncomingMessage, res: ServerResponse, url: URL) {
    const headers = cors(req);
    try {
      // The body is the gzipped chunk itself, sent as text/plain so the page needs no preflight; it is not unpacked here.
      if (req.headers["content-encoding"]) throw new AnalyticsError(400, "invalid-body", "Send the gzipped chunk as the body, without Content-Encoding.");
      const data = await readBody(req, CHUNK_LIMIT);
      const id = (n: string) => {
        const v = url.searchParams.get(n);
        if (!v || !/^[A-Za-z0-9_-]{8,64}$/.test(v)) throw new AnalyticsError(422, "invalid-batch", `${n} is an id of 8 to 64 letters, digits, _ and -.`);
        return v;
      };
      const seq = Number(url.searchParams.get("seq"));
      if (!Number.isInteger(seq) || seq < 0 || seq > 100_000) throw new AnalyticsError(422, "invalid-batch", "seq is the chunk's number in the visit, from 0.");
      const result = analytics.replay({
        site: param(url, "site", true)!,
        visitor: id("visitor"),
        session: id("session"),
        seq,
        data,
        origin: req.headers.origin,
        userAgent: req.headers["user-agent"],
      });
      json(res, 202, result, headers);
    } catch (err) {
      if (!(err instanceof AnalyticsError)) throw err;
      problem(res, err.status, err.code, err.message, { ...headers, ...(err.retryAfter ? { "retry-after": String(err.retryAfter) } : {}) });
      if (!req.complete) req.resume();
    }
  }

  /** The tracker with the site's settings, for one script tag on the site's pages. */
  function script(res: ServerResponse, name: string) {
    const headers = { "cache-control": "public, max-age=300" };
    if (name === "replay" || name === "heatmap") {
      const body = name === "replay" ? replayScript : heatmapScript;
      if (!body) return send(res, 503, `/* OpenAsy Analytics: the ${name} script is not built. */\n`, "text/javascript", headers);
      return send(res, 200, body, "text/javascript", headers);
    }
    const site = analytics.sites().find((s) => s.name === name);
    if (!site) return send(res, 404, `/* OpenAsy Analytics: no site named ${JSON.stringify(name)} in the sites file. */\n`, "text/javascript", headers);
    if (!tracker) return send(res, 503, "/* OpenAsy Analytics: the tracker is not built. */\n", "text/javascript", headers);
    const config = {
      site: site.name,
      endpoint: `${publicUrl}/api/v1/collect`,
      consent: site.consent,
      forms: site.forms,
      vitals: site.vitals,
      ecommerce: site.ecommerce,
      replay: site.replays ? { sample: site.replays.sample, script: `${publicUrl}/s/replay.js`, endpoint: `${publicUrl}/api/v1/replay` } : null,
      heatmap: `${publicUrl}/s/heatmap.js`,
    };
    send(res, 200, `/* OpenAsy Analytics */\n(function(){\n${tracker}\nOAT.start(${JSON.stringify(config)});\n})();\n`, "text/javascript", headers);
  }

  /** Checks the role a route needs, and says who is asking. */
  function authorize(req: IncomingMessage, access: Access): { who: string | null; user: Who } {
    const nobody: Who = { id: "", name: null, role: "viewer" };
    if (access === "none") return { who: null, user: nobody };
    if (tokenMatches(req.headers.authorization, adminToken)) return { who: null, user: { id: "admin-token", name: null, role: "admin" } };
    const p = auth.authorize(req, access);
    if (p.kind === "session") {
      const name = p.user.name || p.user.email || null;
      return { who: name, user: { id: `user:${p.user.id}`, name, role: p.role as Who["role"] } };
    }
    return { who: `token ${p.name}`, user: { id: `token:${p.tokenId}`, name: `token ${p.name}`, role: p.role as Who["role"] } };
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<string> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/healthz") return (json(res, 200, { status: "ok" }), "/healthz");

    if (path === "/readyz") {
      // Ready to take events as long as the database answers.
      try {
        db.prepare("SELECT 1").get();
        json(res, 200, { status: "ready" });
      } catch {
        json(res, 503, { status: "database unavailable" });
      }
      return "/readyz";
    }

    if (path === "/metrics") {
      // Not even the web UI's fallback answers here when metrics have their own port.
      if (serveMetrics) send(res, 200, metricsText(analytics, version), "text/plain; version=0.0.4");
      else problem(res, 404, "not-found");
      return "/metrics";
    }

    const site = /^\/s\/([a-z0-9-]{1,32})\.js$/.exec(path);
    if (site && (req.method === "GET" || req.method === "HEAD")) return (script(res, site[1]!), "/s/{site}.js");

    if (path === "/api/v1/collect" && req.method === "POST") return (await collect(req, res), "/api/v1/collect");
    if (path === "/api/v1/replay" && req.method === "POST") return (await replayChunk(req, res, url), "/api/v1/replay");

    if (path === "/api/openapi.json" && spec) return (send(res, 200, spec), "/api/openapi.json");

    if (docsDir && (path === "/api/docs" || path.startsWith("/api/docs/"))) {
      if (path === "/api/docs") {
        res.writeHead(301, { ...SECURITY_HEADERS, location: "/api/docs/" }).end();
        return "/api/docs";
      }
      const relative = path.slice("/api/docs/".length) || "index.html";
      if (!(await serveFile(res, docsDir, relative))) problem(res, 404, "not-found");
      return "/api/docs";
    }

    if (await auth.handle(req, res)) return auth.routeName(req) ?? "/api/v1/auth/*";

    for (const r of compiled) {
      const m = path.match(r.re);
      if (!m || r.method !== req.method) continue;
      try {
        const { who, user } = authorize(req, r.auth);
        const params = m.slice(1).map(decodeURIComponent);
        const result = await r.handle({ req, res, url, params, who, user });
        if (!res.headersSent && result !== undefined) json(res, 200, result);
      } catch (err) {
        if (err instanceof AuthError) {
          sendProblem(res, err);
          if (!req.complete) req.resume();
          return r.path;
        }
        if (!(err instanceof AnalyticsError)) throw err;
        problem(res, err.status, err.code, err.message, err.retryAfter ? { "retry-after": String(err.retryAfter) } : {});
        // Unread request bodies would otherwise hold the connection.
        if (!req.complete) req.resume();
      }
      return r.path;
    }

    if (path.startsWith("/api/")) return (problem(res, 404, "not-found"), "/api/*");

    if (webDir && (req.method === "GET" || req.method === "HEAD")) {
      // Unknown paths fall back to the single-page app.
      if (!(await serveFile(res, webDir, path === "/" ? "index.html" : path))) send(res, 200, await readFile(join(webDir, "index.html")), TYPES[".html"]);
      return "/web";
    }

    problem(res, 404, "not-found");
    return "unmatched";
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    const started = performance.now();
    SECURITY_HEADERS = securityHeaders([...new Set(analytics.sites().flatMap((s) => s.domains))]);
    let routeName = "error";
    try {
      routeName = await route(req, res);
    } catch (err) {
      log("error", "request failed", { error: String(err), path: req.url });
      if (!res.headersSent) problem(res, 500, "internal-error");
    }
    countRequest(req.method ?? "GET", routeName, res.statusCode);
    // Batches arrive with every page view; logging each would put the sites' traffic in the logs.
    if (!["/healthz", "/metrics", "/api/v1/collect", "/api/v1/replay", "/s/{site}.js"].includes(routeName)) {
      log("info", "request", { method: req.method, path: url(req), status: res.statusCode, ms: Math.round(performance.now() - started) });
    }
  };
}

/** The path without the query string, which may name visitors, and without a shared link's token. */
const url = (req: IncomingMessage) => (req.url ?? "/").split("?")[0]!.replace(/^\/(api\/v1\/)?shared\/[^/]+/, "/$1shared/***");

const header = (req: IncomingMessage, name: string) => {
  const v = req.headers[name];
  return typeof v === "string" ? v : undefined;
};
