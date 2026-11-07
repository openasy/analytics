import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createAuth, oidcFromEnv, readSecretsKey } from "@openasy/auth";
import { createAnalytics } from "./analytics.ts";
import { createApp, createMetricsHandler } from "./app.ts";
import { watchConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { log } from "./log.ts";
import { parseProducts } from "./products.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const port = Number(process.env.PORT ?? 8080);
const dbPath = process.env.ANALYTICS_DB ?? "/data/analytics.db";
const configPath = process.env.ANALYTICS_CONFIG?.trim() || "/config/analytics.yaml";
const defaultRate = Number(process.env.ANALYTICS_RATE_LIMIT ?? 6000);
const webDir = new URL("../dist/web", import.meta.url).pathname;
const docsDir = new URL("../dist/docs", import.meta.url).pathname;
const trackerFile = new URL("../dist/tracker/a.js", import.meta.url).pathname;
const scriptFile = (name: string) => {
  const file = new URL(`../dist/tracker/${name}.js`, import.meta.url).pathname;
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
};
const openapi = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Record<string, unknown>;
const headless = process.env.ANALYTICS_HEADLESS === "true";
// Set it to keep /metrics off the port that is published or behind an ingress (ADR 0026).
const metricsPort = process.env.ANALYTICS_METRICS_PORT ? Number(process.env.ANALYTICS_METRICS_PORT) : undefined;

if (!Number.isInteger(defaultRate) || defaultRate < 1) throw new Error("ANALYTICS_RATE_LIMIT must be events per minute, 1 or more");

const db = openDb(dbPath);
// The address people open analytics at, behind the TLS proxy (ADR 0026). Cookies, passkeys, OIDC redirects and the
// script on the sites use it.
const publicUrl = (process.env.ANALYTICS_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const secretsKeyFile = process.env.ANALYTICS_SECRETS_KEY_FILE ?? "/run/secrets/openasy-kek";
const auth = createAuth({
  db,
  product: "analytics",
  productName: "OpenAsy Analytics",
  origin: publicUrl,
  // Locally the same analytics is often opened as 127.0.0.1 too.
  trustedOrigins: publicUrl.startsWith("http://localhost:") ? [publicUrl.replace("localhost", "127.0.0.1")] : [],
  passwords: process.env.ANALYTICS_PASSWORD_SIGN_IN !== "false",
  oidc: oidcFromEnv(process.env, "ANALYTICS_"),
  secretsKey: readSecretsKey(secretsKeyFile),
  // Audit log (ADR 0013): every sign-in, failure and change to members and tokens.
  onEvent: (event) => log(event.type === "sign-in-failed" ? "warn" : "info", "auth", { event }),
});
let file: ReturnType<typeof watchConfig> | undefined;
const analytics = createAnalytics(db, { defaultRate, fileState: () => file?.state ?? null });
// The sites come from the file and only from it; a file with a mistake keeps the last good one in place.
file = watchConfig(configPath, (sites) => analytics.setSites(sites), {
  onChange: (state) =>
    state.error
      ? log("warn", "sites file not applied: the last good version stays until it is fixed", { file: state.path, error: state.error })
      : log("info", "sites file applied", { file: state.path, sites: state.sites, warnings: state.warnings }),
});
const products = parseProducts(process.env.OPENASY_PRODUCTS);
if (products.invalid.length) log("warn", "OPENASY_PRODUCTS: left out entries that are not id=https://address", { entries: products.invalid });
const server = createServer(
  createApp({
    db,
    analytics,
    version,
    publicUrl,
    auth,
    tracker: existsSync(trackerFile) ? readFileSync(trackerFile, "utf8") : undefined,
    replayScript: scriptFile("replay"),
    heatmapScript: scriptFile("heatmap"),
    webDir: !headless && existsSync(webDir) ? webDir : undefined,
    docsDir: existsSync(docsDir) ? docsDir : undefined,
    openapi,
    serveMetrics: metricsPort === undefined,
    products: products.products,
  }),
);
const metricsServer = metricsPort !== undefined ? createServer(createMetricsHandler(analytics, version)) : undefined;
metricsServer?.listen(metricsPort, () => log("info", "metrics on their own port", { port: metricsPort }));

server.listen(port, () => log("info", "analytics started", { version, port, db: dbPath, config: configPath, headless }));
if (!publicUrl.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(publicUrl)) {
  log(
    "warn",
    "ANALYTICS_PUBLIC_URL is not https: browsers will not keep secure cookies or allow passkeys, and https sites cannot load the script. Put analytics behind TLS (ADR 0026)",
    {
      url: publicUrl,
    },
  );
}
if (auth.secretsInClear)
  log("warn", "no secrets key: TOTP secrets are stored unencrypted. Mount a 32-byte key (openssl rand -hex 32)", { file: secretsKeyFile });
const setup = auth.setupLink();
// No default password (ADR 0013): the first person to open this link becomes the owner.
if (setup) log("info", "no owner yet: open this link once to create the owner account", { url: setup });

analytics.purge();
const timers: NodeJS.Timeout[] = [setInterval(() => auth.purge(), 5 * 60_000), setInterval(() => analytics.purge(), 3_600_000)];

function shutdown(signal: string) {
  log("info", "shutting down", { signal });
  for (const t of timers) clearInterval(t);
  file?.stop();
  metricsServer?.close();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
