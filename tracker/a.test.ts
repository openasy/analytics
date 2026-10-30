// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomId, selectorOf, start, textOf, type Config } from "./a.ts";

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
      { target: "form > input", text: "Send" },
      { target: "div > button.reveal" },
    ]);
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

describe("what a click says", () => {
  it("names an element by tag, id and classes, and prefers its own label", () => {
    document.body.innerHTML = `<section class="hero"><div class="cta big extra"><button aria-label="Start free trial">Go</button></div></section>`;
    const button = document.querySelector("button")!;
    expect(selectorOf(button)).toBe("section.hero > div.cta.big > button");
    expect(textOf(button)).toBe("Start free trial");
  });
});
