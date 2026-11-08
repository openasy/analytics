import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { due, zoned } from "./sharing.ts";
import { readMail, SHOP, startApp } from "./test-app.ts";

const HOUR = 3_600_000;
let app: Awaited<ReturnType<typeof startApp>>;
const hooks: Array<{ url: string; body: any }> = [];
const json = async (r: Response) => (await r.json()) as any;
const send = (path: string, body: unknown, method = "POST") => app.admin(path, { method, body: JSON.stringify(body) });

beforeAll(async () => {
  app = await startApp({
    version: "0.1.0",
    webhook: (async (url: string | URL, init?: RequestInit) => {
      hooks.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response("ok");
    }) as typeof fetch,
  });
  await app.collect({
    site: "shop",
    visitor: "visitor-share-0001",
    session: "session-share-0001",
    user: "u-secret-42",
    events: [{ type: "pageview", url: `${SHOP}/pricing`, title: "Pricing" }],
  });
});
afterAll(() => app.close());

describe("schedules", () => {
  it("reads a time in the file's time zone", () => {
    // 2026-11-01 22:30 UTC is Monday 2 November 01:30 in Istanbul.
    expect(zoned(Date.parse("2026-11-01T22:30:00Z"), "Europe/Istanbul")).toEqual({
      date: "2026-11-02",
      month: "2026-11",
      week: "2026-W45",
      weekday: 1,
      day: 2,
      hour: 1,
    });
    expect(zoned(Date.parse("2027-01-01T12:00:00Z"), "UTC").week).toBe("2026-W53");
  });

  it("sends a report once a period, after its hour on the period's first day", () => {
    const at = (iso: string) => Date.parse(iso);
    expect(due("weekly", "2026-W44", at("2026-11-02T05:00:00Z"), "Europe/Istanbul")).toEqual({ period: "2026-W45", due: false }); // 08:00 on Monday
    expect(due("weekly", "2026-W44", at("2026-11-02T06:00:00Z"), "Europe/Istanbul")).toEqual({ period: "2026-W45", due: true }); // 09:00
    // Missed on Monday, as the install was down: sent when it is back.
    expect(due("weekly", "2026-W44", at("2026-11-04T01:00:00Z"), "Europe/Istanbul").due).toBe(true);
    expect(due("weekly", "2026-W45", at("2026-11-04T01:00:00Z"), "Europe/Istanbul").due).toBe(false);
    expect(due("daily", "2026-11-02", at("2026-11-03T04:59:00Z"), "Europe/Istanbul").due).toBe(false);
    expect(due("daily", "2026-11-02", at("2026-11-03T05:00:00Z"), "Europe/Istanbul").due).toBe(true);
    expect(due("monthly", "2026-10", at("2026-11-01T08:00:00Z"), "UTC").due).toBe(false);
    expect(due("monthly", "2026-10", at("2026-11-01T09:00:00Z"), "UTC").due).toBe(true);
  });
});

describe("segments", () => {
  it("keep a member's own and the team's on the server", async () => {
    const mine = await json(await send("/api/v1/segments", { name: "Mobile in Türkiye", filters: ["device:is:mobile", "country:is:TR"] }));
    expect(mine).toMatchObject({
      name: "Mobile in Türkiye",
      shared: false,
      mine: true,
      filters: [{ dimension: "device", op: "is", values: ["mobile"] }, expect.anything()],
    });
    // Another member's private segment is not listed; a shared one is.
    app.db.prepare("INSERT INTO segments (id, name, filters, owner, shared, created_at) VALUES ('other', 'Theirs', '[]', 'user:2', 0, '2026-10-01')").run();
    app.db.prepare("INSERT INTO segments (id, name, filters, owner, shared, created_at) VALUES ('team', 'Team', '[]', 'user:2', 1, '2026-10-01')").run();
    const list = await json(await app.admin("/api/v1/segments"));
    expect(list.segments.map((s: { id: string; mine: boolean }) => [s.id === mine.id ? "mine" : s.id, s.mine])).toEqual([
      ["mine", true],
      ["team", false],
    ]);
    expect((await send("/api/v1/segments", { name: "Bad", filters: ["shoe:is:42"] })).status).toBe(422);
    // An admin may delete a shared one; nobody another's private one.
    expect((await app.admin("/api/v1/segments/other", { method: "DELETE" })).status).toBe(404);
    expect((await app.admin("/api/v1/segments/team", { method: "DELETE" })).status).toBe(204);
  });
});

describe("email reports", () => {
  it("send the chosen sections as HTML with CSV files, and stop for a recipient from the link", async () => {
    const created = await json(
      await send("/api/v1/email-reports", {
        site: "shop",
        name: "Weekly traffic",
        recipients: ["Zeynep@Example.test", "emily@example.test"],
        every: "weekly",
        sections: ["overview", "conversions"],
      }),
    );
    expect(created).toMatchObject({ recipients: ["zeynep@example.test", "emily@example.test"], lastSentAt: null });
    // Created on a Thursday: the first goes out next Monday, not now.
    expect(await app.sharing.reports.tick()).toBe(0);
    app.sink.messages.length = 0;
    // A report is of whole days up to yesterday: the visit of today is in tomorrow's.
    app.clock.advance(24 * HOUR);
    const sent = await json(await app.admin(`/api/v1/email-reports/${created.id}/send`, { method: "POST" }));
    expect(sent.sent).toBe(2);
    expect(app.sink.messages.map((m) => m.to[0])).toEqual(["zeynep@example.test", "emily@example.test"]);
    const mail = readMail(app.sink.messages[0]!.data);
    expect(mail).toContain("Subject: Weekly traffic: shop");
    expect(mail).toContain("List-Unsubscribe: <");
    expect(mail).toContain('filename="pages.csv"');
    expect(mail).toContain("Page,Views,Visitors");
    // Totals and tables only: no visitor id or user id.
    expect(mail).not.toContain("visitor-share-0001");
    expect(mail).not.toContain("u-secret-42");
    const stop = /token=([A-Za-z0-9_.-]+)/.exec(mail)![1]!;
    expect((await fetch(`${app.base}/api/v1/unsubscribe?token=${stop}`)).status).toBe(200);
    expect((await json(await app.admin("/api/v1/email-reports"))).reports[0].recipients).toEqual(["emily@example.test"]);
    expect((await fetch(`${app.base}/api/v1/unsubscribe?token=${stop.slice(0, -2)}xx`)).status).toBe(404);
    // Next Monday at 09:00 in Istanbul (06:00 UTC) it is due.
    app.clock.advance(3 * 24 * HOUR - 6 * HOUR);
    expect(await app.sharing.reports.tick()).toBe(1);
    expect(await app.sharing.reports.tick()).toBe(0);
  });
});

describe("shared links", () => {
  it("show the chosen sections to anyone with the link, after its password, and stop when revoked", async () => {
    const created = await json(
      await send("/api/v1/shares", { site: "shop", name: "Agency", sections: ["overview", "performance"], password: "correct horse battery" }),
    );
    const token = created.url.split("/shared/")[1];
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM shares WHERE token_hash = ?").get(token)).toEqual({ n: 0 });
    const open = await json(await fetch(`${app.base}/api/v1/shared/${token}`));
    expect(open).toMatchObject({ name: "Agency", site: "shop", sections: ["overview", "performance"], password: true, unlocked: false });
    expect((await fetch(`${app.base}/api/v1/shared/${token}/report?section=overview`)).status).toBe(401);
    const { access } = await json(
      await fetch(`${app.base}/api/v1/shared/${token}/unlock`, { method: "POST", body: JSON.stringify({ password: "correct horse battery" }) }),
    );
    const get = (q: string) => fetch(`${app.base}/api/v1/shared/${token}/report?${q}`, { headers: { "x-share-access": access } });
    const overview = await get("section=overview&days=7");
    expect(overview.status).toBe(200);
    const text = await overview.text();
    expect(JSON.parse(text).data.totals.visits).toBe(1);
    expect(text).not.toContain("visitor-share-0001");
    expect(text).not.toContain("session-share-0001");
    expect(text).not.toContain("u-secret-42");
    expect((await get("section=ecommerce")).status).toBe(404);
    expect((await get("section=overview&filter=screen:is:1920x1080")).status).toBe(422);
    // Access from another link does not open this one.
    const other = await json(await send("/api/v1/shares", { site: "shop", name: "Open", sections: ["overview"] }));
    const otherToken = other.url.split("/shared/")[1];
    expect((await fetch(`${app.base}/api/v1/shared/${otherToken}/report?section=overview`)).status).toBe(200);
    expect((await json(await app.admin("/api/v1/shares"))).shares.find((s: { id: string }) => s.id === created.id).views).toBe(1);
    await app.admin(`/api/v1/shares/${created.id}`, { method: "DELETE" });
    expect((await fetch(`${app.base}/api/v1/shared/${token}`)).status).toBe(404);
  });

  it("expire", async () => {
    const created = await json(await send("/api/v1/shares", { site: "shop", name: "Week", sections: ["overview"], expiresDays: 7 }));
    const token = created.url.split("/shared/")[1];
    expect((await fetch(`${app.base}/api/v1/shared/${token}`)).status).toBe(200);
    app.clock.advance(8 * 24 * HOUR);
    expect((await fetch(`${app.base}/api/v1/shared/${token}`)).status).toBe(404);
  });
});

describe("alerts", () => {
  it("compare an hour's visits with the same hour of the weeks before, and say so by email and webhook once", async () => {
    const fresh = await startApp({
      version: "0.1.0",
      webhook: (async (url: string | URL, init?: RequestInit) => {
        hooks.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return new Response("ok");
      }) as typeof fetch,
    });
    try {
      const rule = await json(
        await fresh.admin("/api/v1/alerts", {
          method: "POST",
          body: JSON.stringify({
            site: "shop",
            name: "Traffic spike",
            kind: "spike",
            ratio: 2,
            recipients: ["ops@example.test"],
            webhook: "https://hooks.example.test/a",
          }),
        }),
      );
      expect(
        (await fresh.admin("/api/v1/alerts", { method: "POST", body: JSON.stringify({ site: "shop", name: "x", kind: "drop", webhook: "ftp://x" }) })).status,
      ).toBe(422);
      const hour = Math.floor(fresh.clock() / HOUR) * HOUR - HOUR;
      const add = (n: number, t: number, tag: string) => {
        const insert = fresh.db.prepare(
          "INSERT INTO sessions (site, id, visitor, started_at, last_at, browser, os, device) VALUES ('shop', ?, ?, ?, ?, 'Chrome', 'macOS', 'desktop')",
        );
        for (let i = 0; i < n; i++) insert.run(`${tag}-${i}`, `v-${tag}-${i}`, new Date(t + i * 1000).toISOString(), new Date(t + i * 1000).toISOString());
      };
      // Ten visits in the same hour of each of the four weeks before; twenty-five in the last hour.
      for (let k = 1; k <= 4; k++) add(10, hour - k * 7 * 24 * HOUR, `w${k}`);
      add(25, hour, "now");
      fresh.sink.messages.length = 0;
      hooks.length = 0;
      expect(await fresh.sharing.alerts.check()).toBe(1);
      expect(await fresh.sharing.alerts.check()).toBe(0);
      expect(hooks).toHaveLength(1);
      expect(hooks[0]).toMatchObject({
        url: "https://hooks.example.test/a",
        body: { type: "analytics.alert", site: "shop", visits: 25, usual: 10, rule: { kind: "spike" } },
      });
      expect(fresh.sink.messages.map((m) => m.to[0])).toEqual(["ops@example.test"]);
      expect(readMail(fresh.sink.messages[0]!.data)).toContain("Visits were 2.5 times the usual");
      let list = await json(await fresh.admin("/api/v1/alerts?site=shop"));
      expect(list.rules[0]).toMatchObject({ id: rule.id, open: true });
      expect(list.alerts[0]).toMatchObject({ name: "Traffic spike", visits: 25, usual: 10, endedAt: null, sent: "email, webhook" });
      // The next hour is quiet: the alert ends, and nothing more is sent.
      fresh.clock.advance(HOUR);
      expect(await fresh.sharing.alerts.check()).toBe(0);
      list = await json(await fresh.admin("/api/v1/alerts?site=shop"));
      expect(list.alerts[0].endedAt).not.toBeNull();
      expect(hooks).toHaveLength(1);
    } finally {
      await fresh.close();
    }
  });

  it("need a usual of ten visits for a drop", async () => {
    const fresh = await startApp({ version: "0.1.0" });
    try {
      await fresh.admin("/api/v1/alerts", {
        method: "POST",
        body: JSON.stringify({ site: "shop", name: "Drop", kind: "drop", recipients: ["ops@example.test"] }),
      });
      const hour = Math.floor(fresh.clock() / HOUR) * HOUR - HOUR;
      const insert = fresh.db.prepare(
        "INSERT INTO sessions (site, id, visitor, started_at, last_at, browser, os, device) VALUES ('shop', ?, 'v', ?, ?, 'Chrome', 'macOS', 'desktop')",
      );
      for (let k = 1; k <= 3; k++)
        for (let i = 0; i < 4; i++)
          insert.run(`d${k}-${i}`, new Date(hour - k * 7 * 24 * HOUR).toISOString(), new Date(hour - k * 7 * 24 * HOUR).toISOString());
      expect(await fresh.sharing.alerts.check()).toBe(0);
    } finally {
      await fresh.close();
    }
  });
});
