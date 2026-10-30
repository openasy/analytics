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
import { AnalyticsError, parseLimit, parseRange, type Analytics, type ProblemCode } from "./analytics.ts";

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

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": `default-src 'self'; connect-src 'self'${IDENTITY ? ` ${IDENTITY}` : ""}; img-src 'self' data:; style-src 'self' 'unsafe-inline'`,
};

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
  webDir,
  docsDir,
  openapi,
  serveMetrics = true,
  products = [],
}: AppOptions) {
  // The served description includes /api/v1/auth from @openasy/auth, so the API reference documents sign-in too.
  const spec = openapi && JSON.stringify({ ...mergeOpenApi(openapi), info: { ...(openapi.info as object), version } });
  const noContent = (res: ServerResponse) => {
    res.writeHead(204, SECURITY_HEADERS).end();
  };
  const cursor = (url: URL) => url.searchParams.get("cursor") ?? undefined;
  const limit = (url: URL) => parseLimit(url.searchParams.get("limit"));
  const page = <K extends string, T>(key: K, p: { items: T[]; nextCursor?: string }) =>
    ({ [key]: p.items, ...(p.nextCursor && { nextCursor: p.nextCursor }) }) as Record<K, T[]> & { nextCursor?: string };

  const routes: Route[] = [
    { method: "GET", path: "/api/v1/version", auth: "none", handle: () => ({ product: "analytics", version }) },
    { method: "GET", path: "/api/v1/products", auth: "viewer", handle: () => ({ products }) },
    { method: "GET", path: "/api/v1/summary", auth: "viewer", handle: () => analytics.summary() },

    // The sites, as the file sets them. There is no route that adds, changes or removes one.
    { method: "GET", path: "/api/v1/sites", auth: "viewer", handle: () => ({ sites: analytics.siteList(publicUrl), file: analytics.summary().file }) },

    // Reports.
    {
      method: "GET",
      path: "/api/v1/report",
      auth: "viewer",
      handle: ({ url }) => analytics.report(param(url, "site", true)!, parseRange(url.searchParams.get("days"))),
    },
    {
      method: "GET",
      path: "/api/v1/visits",
      auth: "viewer",
      handle: ({ url }) =>
        page(
          "visits",
          analytics.visits({ site: param(url, "site", true)!, visitor: param(url, "visitor"), user: param(url, "user") }, cursor(url), limit(url)),
        ),
    },
    { method: "GET", path: "/api/v1/visits/:id", auth: "viewer", handle: ({ url, params }) => analytics.visit(param(url, "site", true)!, params[0]!) },

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
    const site = analytics.sites().find((s) => s.name === name);
    const headers = { "cache-control": "public, max-age=300" };
    if (!site) return send(res, 404, `/* OpenAsy Analytics: no site named ${JSON.stringify(name)} in the sites file. */\n`, "text/javascript", headers);
    if (!tracker) return send(res, 503, "/* OpenAsy Analytics: the tracker is not built. */\n", "text/javascript", headers);
    const config = { site: site.name, endpoint: `${publicUrl}/api/v1/collect`, consent: site.consent };
    send(res, 200, `/* OpenAsy Analytics */\n(function(){\n${tracker}\nOAT.start(${JSON.stringify(config)});\n})();\n`, "text/javascript", headers);
  }

  function authorize(req: IncomingMessage, access: Access) {
    if (access === "none") return;
    if (tokenMatches(req.headers.authorization, adminToken)) return;
    auth.authorize(req, access);
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
        authorize(req, r.auth);
        const params = m.slice(1).map(decodeURIComponent);
        const result = await r.handle({ req, res, url, params });
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
    let routeName = "error";
    try {
      routeName = await route(req, res);
    } catch (err) {
      log("error", "request failed", { error: String(err), path: req.url });
      if (!res.headersSent) problem(res, 500, "internal-error");
    }
    countRequest(req.method ?? "GET", routeName, res.statusCode);
    // Batches arrive with every page view; logging each would put the sites' traffic in the logs.
    if (routeName !== "/healthz" && routeName !== "/metrics" && routeName !== "/api/v1/collect" && routeName !== "/s/{site}.js") {
      log("info", "request", { method: req.method, path: url(req), status: res.statusCode, ms: Math.round(performance.now() - started) });
    }
  };
}

/** The path without the query string, which may name visitors. */
const url = (req: IncomingMessage) => (req.url ?? "/").split("?")[0];
