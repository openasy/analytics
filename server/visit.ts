// What a page sends, checked and cleaned before anything is stored. The schema decides what can be kept: form values,
// names, emails and addresses are not part of it, query strings are dropped but for utm_* and the site's own list,
// and emails, tokens and keys in addresses and texts are masked (the same rules as Errors).
import { pathPattern, type Site } from "./config.ts";

export class VisitError extends Error {}
const bad = (m: string) => new VisitError(m);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

/** Ids the script makes: random, per site, never derived from the person or the device. */
const ID = /^[A-Za-z0-9_-]{8,64}$/;
const EVENT_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const HAS_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE = /^\+?[\d\s().-]{7,20}$/;
export const TYPES = ["pageview", "leave", "click", "event", "forget"] as const;
export type EventType = (typeof TYPES)[number];
export const MAX_EVENTS = 50;

/** Passwords, tokens, keys and email addresses in text a page sent are replaced before anything is stored. */
export function mask(value: string): string {
  return value
    .replace(/((?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|private[_-]?key|session(?:id)?)["']?\s*[=:]\s*["']?)[^\s&"',;/]+/gi, "$1***")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, "Bearer ***")
    .replace(/\b(?:AKIA|ASIA|ghp_|gho_|ghs_|glpat-|xox[abp]-|sk_live_|sk-)[A-Za-z0-9_-]{8,}/g, "***")
    .replace(EMAIL, "***");
}

/** A path as it is kept: emails and long tokens in a segment are masked, so /reset/9f2c... is not a key to an account. */
export function cleanPath(pathname: string): string {
  const path = pathname
    .split("/")
    .map((seg) => {
      let s: string;
      try {
        s = decodeURIComponent(seg);
      } catch {
        s = seg;
      }
      if (HAS_EMAIL.test(s)) return "***";
      // A segment of 24 or more letters and digits with both in it is a token or a key, not a word.
      if (/^[A-Za-z0-9_-]{24,}$/.test(s) && /\d/.test(s) && /[A-Za-z]/.test(s)) return "***";
      return encodeURIComponent(s).replace(/%2C/g, ",").replace(/%40/g, "@");
    })
    .join("/");
  return path.slice(0, 512) || "/";
}

export interface Address {
  origin: string;
  path: string;
  /** The query parameters that are kept, as `?a=1&b=2`, or null. */
  query: string | null;
  utm: { source: string | null; medium: string | null; campaign: string | null };
}

/** Splits an address into what is kept of it. */
export function cleanUrl(raw: string, keep: string[] = []): Address | null {
  const url = URL.parse(raw);
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return null;
  const kept = new URLSearchParams();
  const utm = { source: null as string | null, medium: null as string | null, campaign: null as string | null };
  for (const [k, v] of url.searchParams) {
    const value = mask(v).slice(0, 200);
    if (k === "utm_source" || k === "utm_medium" || k === "utm_campaign") utm[k.slice(4) as keyof typeof utm] = value || null;
    if (k.startsWith("utm_") || keep.includes(k)) kept.append(k, value);
  }
  const query = kept.size ? `?${kept}` : null;
  return { origin: url.origin, path: cleanPath(url.pathname), query, utm };
}

/** The referring site's host without www., or null when the visit came from the site itself or from nowhere. */
export function sourceOf(referrer: string | null, site: Pick<Site, "domains">): string | null {
  const url = referrer ? URL.parse(referrer) : null;
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return null;
  if (site.domains.includes(url.origin)) return null;
  return url.hostname.replace(/^www\./, "").slice(0, 253);
}

/** Crawlers, previews and scripts: their visits are not people's. */
export function isBot(ua: string): boolean {
  return (
    !ua ||
    /bot\b|bot\/|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|prerender|facebookexternalhit|curl\/|wget\/|python-|httpclient|okhttp|go-http|java\//i.test(
      ua,
    )
  );
}

export interface Agent {
  browser: string;
  os: string;
  device: "desktop" | "mobile" | "tablet";
}

/** Browser, system and kind of device from the user agent. The user agent itself is not kept. */
export function agentOf(ua: string): Agent {
  const browser = /Edg(e|A|iOS)?\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /SamsungBrowser\//.test(ua)
        ? "Samsung Internet"
        : /YaBrowser\//.test(ua)
          ? "Yandex"
          : /Firefox\/|FxiOS\//.test(ua)
            ? "Firefox"
            : /Chrome\/|CriOS\//.test(ua)
              ? "Chrome"
              : /Safari\//.test(ua)
                ? "Safari"
                : "Other";
  const os = /iPad|iPhone|iPod/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Windows/.test(ua)
        ? "Windows"
        : /CrOS/.test(ua)
          ? "ChromeOS"
          : /Mac OS X|Macintosh/.test(ua)
            ? "macOS"
            : /Linux/.test(ua)
              ? "Linux"
              : "Other";
  const device = /iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua)) ? "tablet" : /Mobi|iPhone|iPod|Android/.test(ua) ? "mobile" : "desktop";
  return { browser, os, device };
}

export interface PageEvent {
  type: EventType;
  /** ISO 8601, set from the page's clock when it is within a day of the server's. */
  at: string;
  address: Address | null;
  title: string | null;
  referrer: string | null;
  /** click: a short selector, the element's text and the link it follows. */
  target: string | null;
  text: string | null;
  href: string | null;
  /** event: its name and properties. */
  name: string | null;
  props: Record<string, string | number | boolean> | null;
  /** leave: milliseconds on the page and how far down it was read, 0 to 100. */
  duration: number | null;
  scroll: number | null;
}

export interface Batch {
  site: string;
  visitor: string;
  session: string;
  user: string | null;
  events: PageEvent[];
}

function str(v: unknown, name: string, max: number): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw bad(`${name} must be a string.`);
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function int(v: unknown, name: string, max: number): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw bad(`${name} must be a number of 0 or more.`);
  return Math.min(Math.round(v), max);
}

/**
 * Checks a batch of the schema in openapi.json and cleans what it holds. `query` gives the parameters a site keeps
 * besides utm_*.
 */
export function parseBatch(body: unknown, now: () => number, query: (site: string) => string[] = () => []): Batch {
  if (!isObj(body)) throw bad("The body must be a JSON object.");
  for (const k of Object.keys(body)) if (!["site", "visitor", "session", "user", "events"].includes(k)) throw bad(`${k} is not part of a batch.`);
  if (typeof body.site !== "string" || !body.site) throw bad("site is required.");
  if (typeof body.visitor !== "string" || !ID.test(body.visitor)) throw bad("visitor is an id of 8 to 64 letters, digits, _ and -.");
  if (typeof body.session !== "string" || !ID.test(body.session)) throw bad("session is an id of 8 to 64 letters, digits, _ and -.");
  let user: string | null = null;
  if (body.user !== undefined && body.user !== null) {
    user = str(body.user, "user", 128);
    // The site's own id for a person, opaque. An email address or a phone number would make this a list of people.
    if (user && (HAS_EMAIL.test(user) || PHONE.test(user))) throw bad("user is the site's own opaque id: email addresses and phone numbers are not kept.");
  }
  if (!Array.isArray(body.events) || body.events.length < 1 || body.events.length > MAX_EVENTS) throw bad(`events is a list of 1 to ${MAX_EVENTS} events.`);

  const t = now();
  const keep = query(body.site);
  const events = body.events.map((e, i): PageEvent => {
    const at = `events[${i}]`;
    if (!isObj(e)) throw bad(`${at} must be an object.`);
    const allowed = ["type", "at", "url", "title", "referrer", "target", "text", "href", "name", "props", "duration", "scroll"];
    for (const k of Object.keys(e)) if (!allowed.includes(k)) throw bad(`${at}.${k} is not part of an event.`);
    if (!TYPES.includes(e.type as EventType)) throw bad(`${at}.type is one of ${TYPES.join(", ")}.`);
    let when = t;
    if (e.at !== undefined) {
      if (typeof e.at !== "number" || !Number.isFinite(e.at)) throw bad(`${at}.at is milliseconds since 1970.`);
      // A page's clock can be wrong; within a day it is trusted, so a batch sent late keeps the order of what happened.
      if (Math.abs(e.at - t) < 86_400_000) when = e.at;
    }
    const url = str(e.url, `${at}.url`, 2048);
    const type = e.type as EventType;
    if (type !== "forget" && !url) throw bad(`${at}.url is required.`);
    let name: string | null = null;
    let props: PageEvent["props"] = null;
    if (type === "event") {
      if (typeof e.name !== "string" || !EVENT_NAME.test(e.name)) throw bad(`${at}.name is up to 64 letters, digits and _ . : -.`);
      name = e.name;
      if (e.props !== undefined && e.props !== null) {
        if (!isObj(e.props) || Object.keys(e.props).length > 20) throw bad(`${at}.props is an object with at most 20 entries.`);
        props = {};
        for (const [k, v] of Object.entries(e.props)) {
          if (!EVENT_NAME.test(k) || (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean"))
            throw bad(`${at}.props: names are up to 64 letters, digits and _ . : -, values are strings, numbers or booleans.`);
          props[k] = /pass|secret|token|card|iban|email|phone/i.test(k) ? "***" : typeof v === "string" ? mask(v.slice(0, 200)) : v;
        }
      }
    }
    const text = str(e.text, `${at}.text`, 80);
    const title = type === "pageview" ? str(e.title, `${at}.title`, 300) : null;
    return {
      type,
      at: new Date(when).toISOString(),
      address: url ? cleanUrl(url, keep) : null,
      title: title && mask(title),
      referrer: type === "pageview" ? str(e.referrer, `${at}.referrer`, 2048) : null,
      target: type === "click" ? str(e.target, `${at}.target`, 200) : null,
      text: type === "click" && text ? mask(text) : null,
      href: type === "click" ? str(e.href, `${at}.href`, 2048) : null,
      name,
      props,
      duration: type === "leave" ? int(e.duration, `${at}.duration`, 86_400_000) : null,
      scroll: type === "leave" ? int(e.scroll, `${at}.scroll`, 100) : null,
    };
  });
  return { site: body.site, visitor: body.visitor, session: body.session, user, events };
}

/** Whether a path is one the site does not want recorded. */
export function ignored(site: Pick<Site, "ignore">, path: string): boolean {
  return site.ignore.some((p) => pathPattern(p).test(path));
}
