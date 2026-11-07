// Funnels, forms, heatmaps and replays, from what pages send.
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SHOP, startApp } from "./test-app.ts";

let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  app = await startApp({ version: "0.1.0" });
});
afterAll(() => app.close());

const json = async (res: Response) => (await res.json()) as any;
let n = 0;
const ids = () => ({ visitor: `visitor-${++n}-insights`, session: `session-${n}-insights` });
const at = (seconds = 0) => app.clock() + seconds * 1000;
const send = (id: { visitor: string; session: string }, events: unknown[]) => app.collect({ site: "shop", ...id, events });
const view = (path: string, s = 0) => ({ type: "pageview", at: at(s), url: `${SHOP}${path}` });
const signup = (s = 0) => ({ type: "event", at: at(s), url: `${SHOP}/signup`, name: "signup" });

describe("funnels", () => {
  it("counts a visit at a step only once it did the steps before, in order, with the median wait and conversion by source", async () => {
    // Three visits reach the pricing page; two go on to the form; one signs up. One signs up without the pricing page.
    const a = ids();
    await send(a, [{ ...view("/pricing"), referrer: "https://news.example/fall" }, view("/signup", 30), signup(60)]);
    const b = ids();
    await send(b, [view("/pricing"), view("/signup", 90)]);
    const c = ids();
    await send(c, [view("/pricing")]);
    const d = ids();
    await send(d, [view("/signup"), signup(10)]);
    // Order matters: signing up before seeing the form does not count as the form.
    const e = ids();
    await send(e, [view("/pricing"), signup(5), view("/signup", 20)]);
    const r = await json(await app.admin("/api/v1/funnels?site=shop&days=7"));
    const trial = r.funnels[0];
    expect(trial.steps.map((s: { visits: number }) => s.visits)).toEqual([4, 3, 1]);
    expect(trial.steps[0].median).toBeNull();
    expect(trial.steps[1].median).toBe(30);
    expect(trial.steps[2].median).toBe(30);
    expect(trial.sources).toContainEqual({ source: "news.example", entered: 1, finished: 1 });
    expect(trial.sources).toContainEqual({ source: "Direct", entered: 3, finished: 0 });
  });
});

describe("forms", () => {
  const form = (action: string, over: object = {}) => ({ type: "form", at: at(), url: `${SHOP}/signup`, form: "form#signup", action, ...over });

  it("reports starts, sends and the field people leave at, never a value", async () => {
    const a = ids();
    await send(a, [
      form("start", { field: "email", kind: "email" }),
      form("leave", { field: "email", kind: "email", duration: 4000, filled: true }),
      form("leave", { field: "company", kind: "text", duration: 2000, filled: true }),
      form("submit"),
    ]);
    const b = ids();
    await send(b, [
      form("start", { field: "email", kind: "email" }),
      form("leave", { field: "email", kind: "email", duration: 6000, filled: true }),
      form("leave", { field: "email", kind: "email", duration: 1000, filled: true, again: true }),
      form("abandon", { field: "email", kind: "email" }),
    ]);
    const r = await json(await app.admin("/api/v1/forms?site=shop&days=7"));
    const f = r.forms.find((x: { form: string }) => x.form === "form#signup");
    expect(f).toMatchObject({ page: "/signup", starts: 2, submits: 1 });
    expect(f.fields[0]).toMatchObject({ field: "email", kind: "email", reached: 2, left: 1, again: 0.5 });
    expect(f.fields[0].time).toBe(4);
    expect(f.fields[1]).toMatchObject({ field: "company", reached: 1, left: 0 });
    expect(r.enabled).toBe(true);
  });

  it("keeps a field named like a card number or a password by its kind only, and refuses anything that is not a field", async () => {
    const a = ids();
    await send(a, [form("start", { field: "cardNumber", kind: "text" }), form("leave", { field: "user_password", kind: "password", duration: 10 })]);
    const visit = await json(await app.admin(`/api/v1/visits/${a.session}?site=shop`));
    expect(visit.timeline.map((e: { field: string }) => e.field)).toEqual(["(text)", "(password)"]);
    expect((await send(ids(), [form("start", { value: "ali@example.com" })])).status).toBe(422);
    expect((await send(ids(), [form("typed")])).status).toBe(422);
    expect((await send(ids(), [form("start", { field: "a b" })])).status).toBe(422);
  });
});

describe("heatmaps", () => {
  it("gives the clicks of a page by element and where in it, and how far it was read, by device", async () => {
    const click = (target: string, x: number, y: number) => ({ type: "click", at: at(), url: `${SHOP}/plans`, target, text: "Start", x, y });
    const a = ids();
    await send(a, [
      view("/plans"),
      click("a.btn.primary", 510, 480),
      click("a.btn.primary", 520, 490),
      click("button#yearly", 100, 900),
      { type: "leave", at: at(9), url: `${SHOP}/plans`, duration: 9000, scroll: 62 },
    ]);
    const r = await json(await app.admin("/api/v1/heatmap?site=shop&path=/plans&days=7"));
    expect(r).toMatchObject({ path: "/plans", url: `${SHOP}/plans`, views: 1, clicks: 3 });
    expect(r.elements[0]).toMatchObject({ target: "a.btn.primary", count: 2 });
    // Both clicks land in the same cell of the 20 by 20 grid, at its centre.
    expect(r.points).toContainEqual({ target: "a.btn.primary", x: 525, y: 475, count: 2 });
    expect(r.scroll.find((s: { depth: number }) => s.depth === 60).share).toBe(1);
    expect(r.scroll.find((s: { depth: number }) => s.depth === 70).share).toBe(0);
    expect(r.pages.some((p: { path: string }) => p.path === "/plans")).toBe(true);
    // The test clock's visits are all from desktop Chrome.
    expect((await json(await app.admin("/api/v1/heatmap?site=shop&path=/plans&days=7&device=mobile"))).clicks).toBe(0);
    expect((await app.admin("/api/v1/heatmap?site=shop&path=plans")).status).toBe(422);
  });
});

describe("replays", () => {
  const rr = (type: number, data: object, s = 0) => ({ type, timestamp: at(s), data });

  it("keeps a visit's chunks in order, masked, and gives them back for the player", async () => {
    const a = ids();
    await send(a, [view("/signup")]);
    expect((await app.replay(a, 1, [rr(3, { source: 2 }, 2)])).status).toBe(202);
    expect((await app.replay(a, 0, [rr(4, { href: `${SHOP}/signup` }), rr(2, { node: { text: "Signed in as ali@example.com" } }, 1)])).status).toBe(202);
    const list = await json(await app.admin("/api/v1/replays?site=shop&days=7"));
    expect(list.replays.find((v: { id: string }) => v.id === a.session)).toMatchObject({ replay: true });
    const r = await json(await app.admin(`/api/v1/replays/${a.session}?site=shop`));
    expect(r.events.map((e: { type: number }) => e.type)).toEqual([4, 2, 3]);
    expect(JSON.stringify(r.events)).not.toContain("ali@example.com");
    expect(r.visit.id).toBe(a.session);
    // What is kept is gzipped.
    const row = app.db.prepare("SELECT data FROM replay_chunks WHERE session = ? AND seq = 0").get(a.session) as { data: Uint8Array };
    expect(gunzipSync(row.data).toString()).toContain("***");
  });

  it("takes chunks only from the site's pages, for sites that record replays, as rrweb events", async () => {
    const a = ids();
    expect((await app.replay(a, 0, [rr(4, {})], { origin: "https://evil.example" })).status).toBe(403);
    expect((await app.replay(a, 0, [rr(4, {})], { site: "blog", origin: "https://blog.example" })).status).toBe(403);
    expect((await app.replay(a, 0, [{ hello: "world" }])).status).toBe(422);
    const bad = await fetch(`${app.base}/api/v1/replay?site=shop&visitor=${a.visitor}&session=${a.session}&seq=0`, {
      method: "POST",
      body: "not gzip",
      headers: { origin: SHOP, "content-type": "text/plain" },
    });
    expect(bad.status).toBe(422);
    expect((await app.replay({ visitor: "x", session: a.session }, 0, [rr(4, {})])).status).toBe(422);
    expect((await app.admin(`/api/v1/replays/${a.session}?site=shop`)).status).toBe(404);
  });

  it("goes with the visitor when they withdraw consent or an admin deletes them", async () => {
    const a = ids();
    await send(a, [view("/")]);
    await app.replay(a, 0, [rr(4, {})]);
    const exported = await json(await app.admin(`/api/v1/visitors/${a.visitor}?site=shop`));
    expect(exported.visits[0]).toMatchObject({ replay: true });
    expect(exported.visits[0].recording).toHaveLength(1);
    expect((await app.admin(`/api/v1/visitors/${a.visitor}?site=shop`, { method: "DELETE" })).status).toBe(204);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM replay_chunks WHERE visitor = ?").get(a.visitor)).toEqual({ n: 0 });
  });

  it("counts rage clicks: three on the same element within a second", async () => {
    const a = ids();
    const click = (ms: number) => ({ type: "click", at: app.clock() + ms, url: `${SHOP}/signup`, target: "button#create", text: "Create account" });
    await send(a, [view("/signup"), click(0), click(300), click(600), click(700), click(5000)]);
    const visit = await json(await app.admin(`/api/v1/visits/${a.session}?site=shop`));
    expect(visit.rage).toBe(1);
  });
});
