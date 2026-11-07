// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fieldOf, randomId, selectorOf, start, textOf, type Config } from "./a.ts";
import { place } from "./heatmap.ts";

const config: Config = { site: "shop", endpoint: "https://analytics.example/api/v1/collect", consent: "none" };
let stop: AbortController;
let sent: Array<{ site: string; visitor: string; session: string; user?: string; events: Array<Record<string, any>> }>;

beforeEach(() => {
  stop = new AbortController();
  sent = [];
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = "";
  document.title = "Home";
  history.replaceState(null, "", "/");
  delete (window as { openasy?: unknown }).openasy;
  vi.useFakeTimers();
  // The script sends with sendBeacon; the body is read back as the server would.
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    value: (_url: string, blob: Blob) => {
      void blob.text().then((t) => sent.push(JSON.parse(t)));
      return true;
    },
  });
});
afterEach(() => (stop.abort(), vi.useRealTimers()));

/** Lets the timer flush the queue and the beacons be read. */
async function flushed() {
  vi.advanceTimersByTime(5_000);
  vi.useRealTimers();
  await new Promise((r) => setTimeout(r, 0));
  vi.useFakeTimers();
  return sent.flatMap((b) => b.events);
}

describe("the script", () => {
  it("sends a page view with random ids it keeps for the visitor and the visit", async () => {
    start(config, stop.signal);
    const events = await flushed();
    expect(events).toMatchObject([{ type: "pageview", url: "http://localhost:3000/", title: "Home" }]);
    expect(sent[0]!.site).toBe("shop");
    expect(sent[0]!.visitor).toBe(localStorage.getItem("openasy.visitor"));
    expect(sent[0]!.session).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(randomId()).not.toBe(randomId());
  });

  it("counts a single-page app's navigation as a page view, with the time spent on the page left", async () => {
    start(config, stop.signal);
    vi.advanceTimersByTime(3_000);
    history.pushState(null, "", "/pricing");
    const events = await flushed();
    expect(events.map((e) => e.type)).toEqual(["pageview", "leave", "pageview"]);
    expect(events[1]).toMatchObject({ url: "http://localhost:3000/", duration: 3_000 });
    expect(events[2]).toMatchObject({ url: "http://localhost:3000/pricing", referrer: "http://localhost:3000/" });
  });

  it("records clicks on links and buttons with what they say, and never what was typed", async () => {
    document.body.innerHTML = `
      <nav class="top main"><a id="buy" href="/checkout">Buy   now</a></nav>
      <form><input type="email" value="ali@example.com"><input type="submit" value="Send"></form>
      <div data-analytics-mask><button class="reveal">Balance 1200 TL</button></div>
      <p>plain text</p>`;
    start(config, stop.signal);
    for (const sel of ["#buy", "input[type=email]", "input[type=submit]", "button.reveal", "p"]) (document.querySelector(sel) as HTMLElement).click();
    const clicks = (await flushed()).filter((e) => e.type === "click");
    expect(clicks).toMatchObject([
      { target: "a#buy", text: "Buy now", href: "http://localhost:3000/checkout" },
      { target: "form > input:nth-of-type(2)", text: "Send" },
      { target: "div > button.reveal" },
    ]);
    // Where in the element: jsdom lays nothing out, so every click is in the middle.
    expect(clicks[0]).toMatchObject({ x: 500, y: 500 });
    expect(clicks[2]!.text).toBeUndefined();
    expect(JSON.stringify(sent)).not.toContain("ali@example.com");
  });

  it("sends the site's own events and user id, and takes calls made before it loaded", async () => {
    (window as unknown as { openasy: { q: unknown[][] } }).openasy = { q: [["identify", "u-42"]] };
    const api = start(config, stop.signal);
    api.track("signup", { plan: "pro" });
    const events = await flushed();
    expect(events.at(-1)).toMatchObject({ type: "event", name: "signup", props: { plan: "pro" } });
    expect(sent.at(-1)!.user).toBe("u-42");
    expect((window as unknown as { openasy: unknown }).openasy).toBe(api);
  });

  it("sends and stores nothing on a site that asks first, until consent is given", async () => {
    const api = start({ ...config, consent: "required" }, stop.signal);
    api.track("early");
    expect(await flushed()).toEqual([]);
    expect(localStorage.length + sessionStorage.length).toBe(0);
    expect(api.ids()).toBeNull();
    api.consent(true);
    expect((await flushed()).map((e) => e.type)).toEqual(["pageview"]);
    expect(localStorage.getItem("openasy.consent")).toBe("1");
  });

  it("asks the product to delete the visitor and forgets its ids when consent is withdrawn", async () => {
    const api = start(config, stop.signal);
    await flushed();
    const visitor = localStorage.getItem("openasy.visitor");
    api.consent(false);
    await flushed();
    expect(sent.at(-1)).toMatchObject({ visitor, events: [{ type: "forget" }] });
    expect(localStorage.getItem("openasy.visitor")).toBeNull();
    api.track("after");
    expect(await flushed()).toHaveLength(2);
  });

  it("starts a new visit after 30 minutes without activity", async () => {
    const api = start(config, stop.signal);
    const first = api.ids()!.session;
    vi.advanceTimersByTime(29 * 60_000);
    expect(api.ids()!.session).toBe(first);
    vi.setSystemTime(Date.now() + 31 * 60_000);
    expect(api.ids()!.session).not.toBe(first);
  });
});

describe("forms", () => {
  const focus = (el: Element) => el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  const blur = (el: Element) => el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));

  it("reports the fields entered and left, whether they were filled, and the form sent or given up, never a value", async () => {
    document.body.innerHTML = `
      <form id="signup"><input name="email" type="email"><input name="password" type="password"><select name="size"><option>-</option><option>5</option></select></form>
      <form class="newsletter"><input name="email" type="email"></form>`;
    start({ ...config, forms: true }, stop.signal);
    const [email, password, size] = [...document.querySelectorAll("#signup input, #signup select")] as HTMLInputElement[];
    focus(email!);
    email!.value = "ali@example.com";
    vi.advanceTimersByTime(1200);
    blur(email!);
    focus(password!);
    password!.value = "hunter2-secret";
    blur(password!);
    focus(email!);
    blur(email!);
    focus(size!);
    blur(size!);
    document.querySelector<HTMLFormElement>("#signup")!.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    const newsletter = document.querySelector(".newsletter input")!;
    focus(newsletter);
    blur(newsletter);
    window.dispatchEvent(new Event("pagehide"));
    const forms = (await flushed()).filter((e) => e.type === "form");
    expect(forms.map((e) => [e.form, e.action, e.field ?? null])).toEqual([
      ["form#signup", "start", "email"],
      ["form#signup", "leave", "email"],
      ["form#signup", "leave", "(password)"],
      ["form#signup", "leave", "email"],
      ["form#signup", "leave", "size"],
      ["form#signup", "submit", null],
      ["form.newsletter:nth-of-type(2)", "start", "email"],
      ["form.newsletter:nth-of-type(2)", "leave", "email"],
      ["form.newsletter:nth-of-type(2)", "abandon", "email"],
    ]);
    expect(forms[1]).toMatchObject({ duration: 1200, filled: true, again: false, kind: "email" });
    expect(forms[3]).toMatchObject({ again: true });
    expect(forms[4]).toMatchObject({ kind: "select", filled: false });
    expect(JSON.stringify(sent)).not.toMatch(/ali@example|hunter2/);
  });

  it("sends nothing about forms unless the site asks for it, nor for fields in masked parts", async () => {
    document.body.innerHTML = `<form><input name="q"></form><form data-analytics-mask><input name="iban"></form>`;
    start(config, stop.signal);
    focus(document.querySelector("input")!);
    expect((await flushed()).some((e) => e.type === "form")).toBe(false);
    stop.abort();
    stop = new AbortController();
    sent = [];
    start({ ...config, forms: true }, stop.signal);
    focus(document.querySelector("[data-analytics-mask] input")!);
    expect((await flushed()).some((e) => e.type === "form")).toBe(false);
  });

  it("names a field by its name or id, and one named like a card or password by its kind", () => {
    document.body.innerHTML = `<input name="cc-number"><input id="phone" type="tel"><textarea name="message"></textarea><input>`;
    expect([...document.querySelectorAll("input, textarea")].map((el) => fieldOf(el))).toEqual([
      { field: "(text)", kind: "text" },
      { field: "phone", kind: "tel" },
      { field: "message", kind: "textarea" },
      { field: "(text)", kind: "text" },
    ]);
  });
});

describe("heatmaps and replays", () => {
  it("records nothing on a page Analytics opened in its frame, and loads the overlay instead", async () => {
    history.replaceState(null, "", "/pricing#openasy-heatmap");
    const parent = { postMessage() {} };
    const real = Object.getOwnPropertyDescriptor(window, "parent")!;
    Object.defineProperty(window, "parent", { configurable: true, value: parent });
    try {
      const api = start({ ...config, heatmap: "https://analytics.example/s/heatmap.js" }, stop.signal);
      api.track("anything");
      expect(await flushed()).toEqual([]);
      expect(document.querySelector('script[src="https://analytics.example/s/heatmap.js"]')).not.toBeNull();
      expect(localStorage.length).toBe(0);
    } finally {
      Object.defineProperty(window, "parent", real);
      document.head.innerHTML = "";
    }
  });

  it("loads the recorder for the share of visits a site records, decided once a visit", async () => {
    const replay = { sample: 50, script: "https://analytics.example/s/replay.js", endpoint: "https://analytics.example/api/v1/replay" };
    const random = vi.spyOn(Math, "random").mockReturnValue(0.2);
    start({ ...config, replay }, stop.signal);
    expect(document.querySelector(`script[src="${replay.script}"]`)).not.toBeNull();
    expect(sessionStorage.getItem("openasy.replay")).toMatch(/:1$/);
    document.head.innerHTML = "";
    stop.abort();
    stop = new AbortController();
    // The same visit keeps its pick even if the dice say otherwise now.
    random.mockReturnValue(0.9);
    start({ ...config, replay }, stop.signal);
    expect(document.querySelector(`script[src="${replay.script}"]`)).not.toBeNull();
    document.head.innerHTML = "";
    sessionStorage.clear();
    stop.abort();
    stop = new AbortController();
    start({ ...config, replay }, stop.signal);
    expect(document.querySelector(`script[src="${replay.script}"]`)).toBeNull();
    random.mockRestore();
  });

  it("does not record on a site that asks first until consent is given", () => {
    const replay = { sample: 100, script: "https://analytics.example/s/replay.js", endpoint: "https://analytics.example/api/v1/replay" };
    const api = start({ ...config, consent: "required", replay }, stop.signal);
    expect(document.querySelector("script[src]")).toBeNull();
    api.consent(true);
    expect(document.querySelector(`script[src="${replay.script}"]`)).not.toBeNull();
    document.head.innerHTML = "";
  });

  it("puts each click where its element is on the page now", () => {
    document.body.innerHTML = `<a class="btn">Start</a>`;
    const a = document.querySelector("a")!;
    a.getBoundingClientRect = () => ({ left: 100, top: 200, width: 80, height: 20, right: 180, bottom: 220, x: 100, y: 200, toJSON() {} }) as DOMRect;
    expect(
      place([
        { target: "a.btn", x: 500, y: 500, count: 3 },
        { target: "button#gone", x: 0, y: 0, count: 9 },
        { target: "::not a selector", x: 0, y: 0, count: 1 },
      ]),
    ).toEqual([{ left: 140, top: 210, count: 3 }]);
  });
});

describe("what a click says", () => {
  it("names an element by tag, id and classes, and prefers its own label", () => {
    document.body.innerHTML = `<section class="hero"><div class="cta big extra"><button aria-label="Start free trial">Go</button></div></section>`;
    const button = document.querySelector("button")!;
    expect(selectorOf(button)).toBe("section.hero > div.cta.big > button");
    expect(textOf(button)).toBe("Start free trial");
  });
});
