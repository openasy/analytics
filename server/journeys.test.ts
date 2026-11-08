import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SHOP, startApp } from "./test-app.ts";

const SITES = `
sites:
  - name: shop
    domains: [${SHOP}]
    search: { path: /search, param: q }
`;

let app: Awaited<ReturnType<typeof startApp>>;
const json = async (r: Response) => (await r.json()) as any;
const DAY = 86_400_000;

beforeAll(async () => {
  app = await startApp({ version: "0.1.0", sites: SITES });
});
afterAll(() => app.close());

/** A visit of the pages given, in order, a second apart. */
async function visit(id: string, paths: string[], more: Record<number, object> = {}, visitor = `visitor-${id}`) {
  const t = app.clock();
  await app.collect({
    site: "shop",
    visitor,
    session: `session-${id}`,
    events: paths.map((p, i) => ({ type: "pageview", at: t + i * 1000, url: `${SHOP}${p}`, ...more[i] })),
  });
}

describe("paths", () => {
  it("follows visits onward from a page and back to how they reached it", async () => {
    await visit("path-a", ["/", "/pricing", "/signup", "/signup", "/done"]);
    await visit("path-b", ["/pricing", "/signup"]);
    await visit("path-c", ["/blog", "/pricing"]);
    const r = await json(await app.admin("/api/v1/paths?site=shop&days=7&page=/pricing&steps=2"));
    expect(r.visits).toBe(3);
    const node = (id: string) => r.nodes.find((n: { id: string }) => n.id === id);
    expect(node("0:start")).toMatchObject({ path: "/pricing", visits: 3 });
    // A reload of /signup is not a step.
    expect(node("1:/signup")).toMatchObject({ visits: 2 });
    expect(node("1:exit")).toMatchObject({ visits: 1, exit: true });
    expect(node("2:/done")).toMatchObject({ visits: 1 });
    expect(node("2:exit")).toMatchObject({ visits: 1 });
    expect(r.links).toContainEqual({ from: "1:/signup", to: "2:/done", visits: 1 });
    const back = await json(await app.admin("/api/v1/paths?site=shop&days=7&page=/pricing&direction=to&steps=1"));
    expect(back.nodes.map((n: { id: string; visits: number }) => [n.id, n.visits])).toEqual([
      ["0:start", 3],
      ["1:/", 1],
      ["1:/blog", 1],
      ["1:exit", 1],
    ]);
    const wild = await json(await app.admin("/api/v1/paths?site=shop&days=7&page=/sign*&steps=1"));
    expect(wild.visits).toBe(2);
  });
});

describe("site search", () => {
  it("says what came after each search, and which found nothing", async () => {
    await visit("search-a", ["/search?q=Grinder", "/products/grinder"]);
    await visit("search-b", ["/search?q=grinder", "/search?q=burr+grinder"], { 1: { noResults: true } });
    await visit("search-c", ["/", "/search?q=decaf"], { 1: { noResults: true } });
    const r = await json(await app.admin("/api/v1/sitesearch?site=shop&days=7"));
    expect(r.enabled).toBe(true);
    expect(r.totals).toMatchObject({ searches: 4, terms: 3, visits: 3, noResults: 2, clicked: 0.25, left: 0.5 });
    expect(r.terms[0]).toEqual({ term: "grinder", searches: 2, visits: 2, noResults: 0, clicked: 0.5, refined: 0.5, left: 0 });
    expect(r.terms.find((x: { term: string }) => x.term === "decaf")).toMatchObject({ noResults: 1, left: 1 });
  });

  it("is marked by the page's leave when the page says so late", async () => {
    const t = app.clock();
    await app.collect({
      site: "shop",
      visitor: "visitor-late-0001",
      session: "session-late-0001",
      events: [
        { type: "pageview", at: t, url: `${SHOP}/search?q=tea` },
        { type: "leave", at: t + 500, url: `${SHOP}/search?q=tea`, noResults: true },
      ],
    });
    expect(app.db.prepare("SELECT no_results FROM events WHERE session = 'session-late-0001' AND type = 'pageview'").get()).toEqual({ no_results: 1 });
  });
});

describe("retention", () => {
  it("counts weekly cohorts, stickiness and who is new, returning or back", async () => {
    const fresh = await startApp({ version: "0.1.0", sites: SITES });
    try {
      // The clock is a Thursday; visits are moved back by hand to the weeks before.
      const put = async (id: string, visitor: string, daysAgo: number) => {
        await fresh.collect({ site: "shop", visitor, session: `session-${id}`, events: [{ type: "pageview", url: `${SHOP}/` }] });
        const when = new Date(fresh.clock() - daysAgo * DAY).toISOString();
        fresh.db.prepare("UPDATE sessions SET started_at = ?, last_at = ? WHERE id = ?").run(when, when, `session-${id}`);
      };
      await put("r1", "visitor-ret-a", 21); // three weeks ago, then this week and last week
      await put("r2", "visitor-ret-a", 7);
      await put("r3", "visitor-ret-a", 0);
      await put("r4", "visitor-ret-b", 21); // three weeks ago, then this week
      await put("r5", "visitor-ret-b", 0);
      await put("r6", "visitor-ret-c", 0); // new this week
      await put("r7", "visitor-ret-d", 49); // seven weeks ago, back this week after more than four
      await put("r8", "visitor-ret-d", 1);
      const r = await json(await fresh.admin("/api/v1/retention?site=shop&weeks=4&days=7"));
      expect(r.cohorts.map((c: { week: string }) => c.week)).toEqual(["2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19"]);
      expect(r.cohorts[0]).toEqual({ week: "2026-09-28", visitors: 2, counts: [2, 0, 1, 2], shares: [1, 0, 0.5, 1] });
      expect(r.cohorts[3]).toMatchObject({ visitors: 1, counts: [1] });
      expect(r.lifecycle[3]).toEqual({ week: "2026-10-19", new: 1, returning: 2, resurrected: 1, dormant: 0 });
      expect(r.lifecycle[2]).toMatchObject({ returning: 1, dormant: 0 });
      const today = r.stickiness.at(-1);
      expect(today).toEqual({ day: "2026-10-22", dau: 3, wau: 4, mau: 4 });
      const filtered = await json(await fresh.admin("/api/v1/retention?site=shop&weeks=4&days=7&filter=page:is:/nope"));
      expect(filtered.cohorts.every((c: { visitors: number }) => c.visitors === 0)).toBe(true);
    } finally {
      await fresh.close();
    }
  });
});
