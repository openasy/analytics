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
export const TYPES = ["pageview", "leave", "click", "event", "form", "forget"] as const;
/** What a form event says: a field was entered first (start), left, or the form was sent or given up. */
export const FORM_ACTIONS = ["start", "leave", "submit", "abandon"] as const;
export type FormAction = (typeof FORM_ACTIONS)[number];
/** Kinds of form fields; anything else is other. */
export const FIELD_KINDS = ["text", "email", "password", "tel", "number", "url", "search", "date", "select", "textarea", "checkbox", "radio", "file", "other"];
const FIELD = /^[A-Za-z0-9_.:[\]-]{1,64}$/;
/** Field names that say what a field holds too plainly: they are kept as their kind only. */
const SENSITIVE_FIELD = /pass|pwd|secret|token|card|cc-?(num|csc|exp)|cvc|cvv|iban|ssn|tckn|kimlik|account|routing/i;
export type EventType = (typeof TYPES)[number];
/** The ecommerce events a site sends with openasy.ecommerce(), by GA4's names, and a refund of an order. */
export const COMMERCE = ["view_item", "add_to_cart", "begin_checkout", "purchase", "refund"] as const;
export type CommerceName = (typeof COMMERCE)[number];
/** A product in an ecommerce event: what it is and what it cost, never who bought it. */
export interface Item {
  sku: string;
  name: string | null;
  category: string | null;
  price: number | null;
  quantity: number;
}
export const MAX_ITEMS = 50;
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

export interface Utm {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  term: string | null;
  content: string | null;
}

export interface Address {
  origin: string;
  path: string;
  /** The query parameters that are kept, as `?a=1&b=2`, or null. */
  query: string | null;
  utm: Utm;
  /** The address carried an ad click id, so the visit came from a paid search ad. The id itself is not kept. */
  paidClick: boolean;
  /** What was searched on the site, from one of its search parameters, masked; or null. */
  search: string | null;
}

const UTM = ["source", "medium", "campaign", "term", "content"] as const;
/** Ad click ids that say a visit came from a paid search ad. */
const CLICK_IDS = ["gclid", "gbraid", "wbraid", "msclkid", "dclid"];

/** Splits an address into what is kept of it. `search` names the site's search parameters, and the pages they are on. */
export function cleanUrl(raw: string, keep: string[] = [], site: Pick<Site, "search">["search"] | string[] = null): Address | null {
  const url = URL.parse(raw);
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return null;
  const path = cleanPath(url.pathname);
  const s = Array.isArray(site) ? { path: null, params: site } : site;
  const search = s && (!s.path || pathPattern(s.path).test(path)) ? s.params : [];
  const kept = new URLSearchParams();
  const utm: Utm = { source: null, medium: null, campaign: null, term: null, content: null };
  let term: string | null = null;
  for (const [k, v] of url.searchParams) {
    const value = mask(v).slice(0, 200);
    const u = k.startsWith("utm_") ? (k.slice(4) as (typeof UTM)[number]) : null;
    if (u && UTM.includes(u)) utm[u] = value || null;
    if (k.startsWith("utm_") || keep.includes(k)) kept.append(k, value);
    if (term === null && search.includes(k)) term = cleanTerm(v);
  }
  const query = kept.size ? `?${kept}` : null;
  const paidClick = CLICK_IDS.some((k) => url.searchParams.has(k));
  return { origin: url.origin, path, query, utm, paidClick, search: term };
}

/** A search term as it is kept: trimmed, lower case, up to 100 characters, with emails, tokens and keys masked. */
export function cleanTerm(raw: string): string | null {
  const t = mask(raw.replace(/\s+/g, " ").trim()).toLowerCase().slice(0, 100);
  // A long run of digits is a phone, card or order number rather than a search.
  return t ? t.replace(/\d[\d\s-]{7,}\d/g, "***") : null;
}

/**
 * Where a visit came from as it is kept: the referring page's address without its query string or fragment, with
 * emails and tokens in its path masked as a page's are. Null when it is not an http(s) address.
 */
export function cleanReferrer(raw: string | null): string | null {
  const url = raw ? URL.parse(raw) : null;
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return null;
  const path = cleanPath(url.pathname);
  return (url.origin + (path === "/" ? "" : path)).slice(0, 512);
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
  /** The browser's major version, such as 141, or null when the user agent does not say. */
  browserVersion: string | null;
  /** The system's version as its user agent gives it, such as 14 for Android or 18.1 for iOS, or null. */
  osVersion: string | null;
}

/** Windows NT versions by the name people know them by. Windows 11 still says NT 10.0. */
const WINDOWS: Record<string, string> = { "10.0": "10", "6.3": "8.1", "6.2": "8", "6.1": "7", "6.0": "Vista", "5.1": "XP" };

function browserVersion(browser: string, ua: string): string | null {
  const re: Record<string, RegExp> = {
    Edge: /Edg(?:e|A|iOS)?\/(\d+)/,
    Opera: /(?:OPR|Opera)\/(\d+)/,
    "Samsung Internet": /SamsungBrowser\/(\d+)/,
    Yandex: /YaBrowser\/(\d+)/,
    Firefox: /(?:Firefox|FxiOS)\/(\d+)/,
    Chrome: /(?:Chrome|CriOS)\/(\d+)/,
    Safari: /Version\/(\d+)/,
  };
  return re[browser]?.exec(ua)?.[1] ?? null;
}

function osVersion(os: string, ua: string): string | null {
  const two = (v: string | undefined) => (v ? v.replace(/_/g, ".").split(".").slice(0, 2).join(".") : null);
  if (os === "iOS") return two(/OS (\d+(?:_\d+)?)/.exec(ua)?.[1]);
  if (os === "Android") return /Android (\d+)/.exec(ua)?.[1] ?? null;
  if (os === "Windows") {
    const nt = /Windows NT (\d+\.\d+)/.exec(ua)?.[1];
    return nt ? (WINDOWS[nt] ?? nt) : null;
  }
  if (os === "macOS") return two(/Mac OS X (\d+[._]\d+)/.exec(ua)?.[1]);
  if (os === "ChromeOS") return /CrOS \S+ (\d+)/.exec(ua)?.[1] ?? null;
  return null;
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
  return { browser, os, device, browserVersion: browserVersion(browser, ua), osVersion: osVersion(os, ua) };
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
  /** leave: milliseconds on the page and how far down it was read, 0 to 100. form: milliseconds in the field. */
  duration: number | null;
  scroll: number | null;
  /** click: where in the element it landed, in thousandths of its width and height. */
  x: number | null;
  y: number | null;
  /** form: the form's selector, the field's name and kind, and what happened; never what the field holds. */
  form: string | null;
  field: string | null;
  kind: string | null;
  action: FormAction | null;
  /** form, leave: whether the field had anything in it, and whether it was entered before in this form. */
  filled: boolean | null;
  again: boolean | null;
  /** pageview: the browser's language (en-US), time zone (Europe/Istanbul) and screen size (1920x1080). */
  language: string | null;
  timezone: string | null;
  screen: string | null;
  /** pageview, leave: the site marked the page as not found. */
  notFound: boolean;
  /** click: nothing happened on the page within a second of it. */
  dead: boolean;
  /** leave: Core Web Vitals of the page: LCP and INP in milliseconds, CLS as a score. */
  lcp: number | null;
  inp: number | null;
  cls: number | null;
  /** pageview, leave: the site's search found nothing on this page. */
  noResults: boolean;
  /** event, for the ecommerce names: the order's id, its value and currency, and the products. */
  commerce: { order: string | null; value: number | null; currency: string | null; items: Item[] } | null;
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
export function parseBatch(
  body: unknown,
  now: () => number,
  settings: (site: string) => { query: string[]; search?: Site["search"] } = () => ({ query: [] }),
): Batch {
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
  const { query: keep, search = null } = settings(body.site);
  const events = body.events.map((e, i): PageEvent => {
    const at = `events[${i}]`;
    if (!isObj(e)) throw bad(`${at} must be an object.`);
    const allowed = [
      "type",
      "at",
      "url",
      "title",
      "referrer",
      "target",
      "text",
      "href",
      "name",
      "props",
      "duration",
      "scroll",
      "x",
      "y",
      "form",
      "field",
      "kind",
      "action",
      "filled",
      "again",
      "language",
      "timezone",
      "screen",
      "notFound",
      "dead",
      "lcp",
      "inp",
      "cls",
      "noResults",
      "order",
      "value",
      "currency",
      "items",
    ];
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
    let form: Pick<PageEvent, "form" | "field" | "kind" | "action" | "filled" | "again"> = {
      form: null,
      field: null,
      kind: null,
      action: null,
      filled: null,
      again: null,
    };
    if (type === "form") {
      if (!FORM_ACTIONS.includes(e.action as FormAction)) throw bad(`${at}.action is one of ${FORM_ACTIONS.join(", ")}.`);
      const selector = str(e.form, `${at}.form`, 200);
      if (!selector) throw bad(`${at}.form is the form's selector.`);
      const kind = e.kind === undefined || e.kind === null ? null : FIELD_KINDS.includes(e.kind as string) ? (e.kind as string) : "other";
      let field = str(e.field, `${at}.field`, 64);
      if (field && !FIELD.test(field)) throw bad(`${at}.field is the field's name or id: up to 64 letters, digits and _ . : [ ] -.`);
      // A field named like a card number or a password is counted by its kind only.
      if (field && SENSITIVE_FIELD.test(field)) field = `(${kind ?? "other"})`;
      const flag = (v: unknown, n: string) => {
        if (v === undefined || v === null) return null;
        if (typeof v !== "boolean") throw bad(`${at}.${n} is true or false.`);
        return v;
      };
      form = { form: selector, field, kind, action: e.action as FormAction, filled: flag(e.filled, "filled"), again: flag(e.again, "again") };
    }
    let commerce: PageEvent["commerce"] = null;
    const sent = ["order", "value", "currency", "items"].filter((k) => e[k] !== undefined && e[k] !== null);
    if (type === "event" && COMMERCE.includes(name as CommerceName)) commerce = commerceOf(e, at);
    else if (sent.length) throw bad(`${at}.${sent[0]} is part of an ecommerce event only: ${COMMERCE.join(", ")}.`);
    const text = str(e.text, `${at}.text`, 80);
    const title = type === "pageview" ? str(e.title, `${at}.title`, 300) : null;
    const bool = (v: unknown, n: string) => {
      if (v === undefined || v === null) return false;
      if (typeof v !== "boolean") throw bad(`${at}.${n} is true or false.`);
      return v;
    };
    const pick = (v: unknown, n: string, re: RegExp, max: number) => {
      const t = str(v, `${at}.${n}`, max);
      return t && re.test(t) ? t : null;
    };
    const cls = type === "leave" && e.cls !== undefined && e.cls !== null ? Number(e.cls) : null;
    if (cls !== null && (!Number.isFinite(cls) || cls < 0)) throw bad(`${at}.cls must be a number of 0 or more.`);
    return {
      type,
      at: new Date(when).toISOString(),
      address: url ? cleanUrl(url, keep, type === "pageview" ? search : null) : null,
      title: title && mask(title),
      referrer: type === "pageview" ? str(e.referrer, `${at}.referrer`, 2048) : null,
      target: type === "click" ? str(e.target, `${at}.target`, 200) : null,
      text: type === "click" && text ? mask(text) : null,
      href: type === "click" ? str(e.href, `${at}.href`, 2048) : null,
      name,
      props,
      duration: type === "leave" || type === "form" ? int(e.duration, `${at}.duration`, 86_400_000) : null,
      scroll: type === "leave" ? int(e.scroll, `${at}.scroll`, 100) : null,
      x: type === "click" ? int(e.x, `${at}.x`, 1000) : null,
      y: type === "click" ? int(e.y, `${at}.y`, 1000) : null,
      ...form,
      language: type === "pageview" ? languageOf(str(e.language, `${at}.language`, 35)) : null,
      timezone: type === "pageview" ? pick(e.timezone, "timezone", TIME_ZONE, 64) : null,
      screen: type === "pageview" ? pick(e.screen, "screen", SCREEN, 11) : null,
      notFound: type === "pageview" || type === "leave" ? bool(e.notFound, "notFound") : false,
      dead: type === "click" ? bool(e.dead, "dead") : false,
      lcp: type === "leave" ? int(e.lcp, `${at}.lcp`, 120_000) : null,
      inp: type === "leave" ? int(e.inp, `${at}.inp`, 60_000) : null,
      cls: cls === null ? null : Math.round(Math.min(cls, 100) * 10_000) / 10_000,
      noResults: type === "pageview" || type === "leave" ? bool(e.noResults, "noResults") : false,
      commerce,
    };
  });
  return { site: body.site, visitor: body.visitor, session: body.session, user, events };
}

/** A short text of a product, masked like any other, and refused when it holds an email address or a phone number. */
function label(v: unknown, at: string, max: number): string | null {
  const t = str(v, at, max);
  if (t && (HAS_EMAIL.test(t) || PHONE.test(t))) throw bad(`${at} names a product: email addresses and phone numbers are not kept.`);
  return t && mask(t);
}

function money(v: unknown, at: string): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 1e9) throw bad(`${at} is an amount, such as 1840.5.`);
  return Math.round(v * 100) / 100;
}

/**
 * The order, value, currency and products of an ecommerce event. Products take a SKU, a name, a category, a price and
 * a quantity, and nothing else: there is no place for who bought them.
 */
function commerceOf(e: Obj, at: string): NonNullable<PageEvent["commerce"]> {
  const order = str(e.order, `${at}.order`, 64);
  if (order && (!/^[A-Za-z0-9_.:#/-]{1,64}$/.test(order) || PHONE.test(order)))
    throw bad(`${at}.order is the order's id: up to 64 letters, digits and _ . : # / -.`);
  if ((e.name === "purchase" || e.name === "refund") && !order) throw bad(`${at}.order is required for a ${e.name}.`);
  const currency = str(e.currency, `${at}.currency`, 3);
  if (currency && !/^[A-Z]{3}$/.test(currency)) throw bad(`${at}.currency is an ISO 4217 code, such as TRY.`);
  if (e.items !== undefined && e.items !== null && (!Array.isArray(e.items) || e.items.length > MAX_ITEMS))
    throw bad(`${at}.items is a list of up to ${MAX_ITEMS} products.`);
  const items = ((e.items as unknown[] | undefined) ?? []).map((raw, i): Item => {
    const iat = `${at}.items[${i}]`;
    if (!isObj(raw)) throw bad(`${iat} is a product: { sku, name, category, price, quantity }.`);
    for (const k of Object.keys(raw)) if (!["sku", "name", "category", "price", "quantity"].includes(k)) throw bad(`${iat}.${k} is not part of a product.`);
    const sku = label(raw.sku, `${iat}.sku`, 64);
    if (!sku) throw bad(`${iat}.sku is the product's code.`);
    const quantity = raw.quantity === undefined ? 1 : raw.quantity;
    if (!Number.isInteger(quantity) || (quantity as number) < 1 || (quantity as number) > 100_000) throw bad(`${iat}.quantity is a whole number from 1.`);
    return {
      sku,
      name: label(raw.name, `${iat}.name`, 120),
      category: label(raw.category, `${iat}.category`, 80),
      price: money(raw.price, `${iat}.price`),
      quantity: quantity as number,
    };
  });
  let value = money(e.value, `${at}.value`);
  // Without a value, the order is worth its products.
  if (value === null && items.length && items.every((x) => x.price !== null))
    value = Math.round(items.reduce((n, x) => n + x.price! * x.quantity, 0) * 100) / 100;
  return { order, value, currency, items };
}

const TIME_ZONE = /^(?:UTC|GMT|[A-Z][A-Za-z_-]+(?:\/[A-Za-z0-9_+-]+){1,2})$/;
const SCREEN = /^[1-9]\d{1,4}x[1-9]\d{1,4}$/;

/** A language tag as it is kept: the language and, when there is one, the region, such as en-US or tr. */
export function languageOf(tag: string | null): string | null {
  const m = tag ? /^([A-Za-z]{2,3})(?:-[A-Za-z]{4})?(?:-([A-Za-z]{2}|\d{3}))?(?:-|$)/.exec(tag) : null;
  if (!m) return null;
  return m[2] ? `${m[1]!.toLowerCase()}-${m[2].toUpperCase()}` : m[1]!.toLowerCase();
}

/** Whether a path is one the site does not want recorded. */
export function ignored(site: Pick<Site, "ignore">, path: string): boolean {
  return site.ignore.some((p) => pathPattern(p).test(path));
}
