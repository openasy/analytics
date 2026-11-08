import { describe, expect, it } from "vitest";
import { agentOf, cleanPath, cleanUrl, isBot, mask, parseBatch, sourceOf } from "./visit.ts";

const now = () => Date.parse("2026-10-22T12:00:00Z");
const batch = (events: unknown[], over: object = {}) => ({ site: "shop", visitor: "visitor-0001", session: "session-0001", events, ...over });

describe("addresses", () => {
  it("keeps utm_* and the site's own parameters, and drops every other one", () => {
    expect(cleanUrl("https://www.example.com/p?utm_source=news&utm_medium=email&token=abc&q=shoes&ref=x", ["q"])).toEqual({
      origin: "https://www.example.com",
      path: "/p",
      query: "?utm_source=news&utm_medium=email&q=shoes",
      utm: { source: "news", medium: "email", campaign: null, term: null, content: null },
      paidClick: false,
      search: null,
    });
    expect(cleanUrl("https://www.example.com/")?.query).toBeNull();
    expect(cleanUrl("ftp://example.com/")).toBeNull();
    expect(cleanUrl("not a url")).toBeNull();
  });

  it("masks emails and tokens in a path, and keeps words and ids", () => {
    expect(cleanPath("/users/ali@example.com/orders")).toBe("/users/***/orders");
    expect(cleanPath("/reset/9f2c4b1e7a3d5f6e8b0c2d4e6f8a1b3c")).toBe("/reset/***");
    expect(cleanPath("/products/42/running-shoes-for-trail-and-road")).toBe("/products/42/running-shoes-for-trail-and-road");
    expect(cleanPath("/kategori/ayakkab%C4%B1")).toBe("/kategori/ayakkab%C4%B1");
    expect(cleanPath("")).toBe("/");
  });

  it("names where a visit came from, and nothing for the site itself", () => {
    const site = { domains: ["https://www.example.com"] };
    expect(sourceOf("https://www.google.com/search?q=x", site)).toBe("google.com");
    expect(sourceOf("https://www.example.com/a", site)).toBeNull();
    expect(sourceOf("", site)).toBeNull();
    expect(sourceOf("android-app://com.slack", site)).toBeNull();
  });

  it("masks secrets and email addresses in text", () => {
    expect(mask("token=abcdef123456 for ali@example.com")).toBe("token=*** for ***");
  });
});

describe("user agents", () => {
  it("names the browser, system and device, and tells crawlers apart", () => {
    expect(agentOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36")).toEqual({
      browser: "Chrome",
      os: "macOS",
      device: "desktop",
      browserVersion: "141",
      osVersion: "10.15",
    });
    expect(
      agentOf("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"),
    ).toEqual({
      browser: "Safari",
      os: "iOS",
      device: "mobile",
      browserVersion: "18",
      osVersion: "18.0",
    });
    expect(agentOf("Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36")).toMatchObject({
      os: "Android",
      device: "tablet",
    });
    expect(agentOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 Edg/141.0")).toMatchObject({
      browser: "Edge",
      os: "Windows",
    });
    expect(isBot("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).toBe(true);
    expect(isBot("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0 Safari/537.36")).toBe(true);
    expect(isBot("")).toBe(true);
    expect(isBot("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0")).toBe(false);
  });
});

describe("batches", () => {
  it("cleans what a page sent", () => {
    const b = parseBatch(
      batch([
        {
          type: "pageview",
          at: now() - 1000,
          url: "https://www.example.com/a?utm_campaign=fall&x=1",
          title: "Hello ali@example.com",
          referrer: "https://news.example/",
        },
        { type: "click", url: "https://www.example.com/a", target: "a.buy", text: "x".repeat(200), href: "https://www.example.com/cart" },
        { type: "event", url: "https://www.example.com/a", name: "signup", props: { plan: "pro", email: "a@b.co", seats: 3 } },
        { type: "leave", url: "https://www.example.com/a", duration: 12_345.6, scroll: 140 },
      ]),
      now,
    );
    expect(b.events[0]).toMatchObject({ at: "2026-10-22T11:59:59.000Z", title: "Hello ***", address: { path: "/a", query: "?utm_campaign=fall" } });
    expect(b.events[1]!.text).toHaveLength(80);
    expect(b.events[2]!.props).toEqual({ plan: "pro", email: "***", seats: 3 });
    expect(b.events[3]).toMatchObject({ duration: 12_346, scroll: 100 });
  });

  it("uses the server's clock when the page's is off by more than a day", () => {
    const b = parseBatch(batch([{ type: "pageview", at: now() + 3 * 86_400_000, url: "https://www.example.com/" }]), now);
    expect(b.events[0]!.at).toBe("2026-10-22T12:00:00.000Z");
  });

  it("refuses what is not part of a batch", () => {
    const cases: Array<[unknown, RegExp]> = [
      [[], /JSON object/],
      [batch([{ type: "pageview", url: "https://a.example/" }], { cookies: "x" }), /cookies is not part of a batch/],
      [batch([{ type: "pageview", url: "https://a.example/" }], { visitor: "short" }), /visitor is an id/],
      [batch([{ type: "pageview", url: "https://a.example/" }], { user: "ali@example.com" }), /email addresses and phone numbers/],
      [batch([{ type: "pageview", url: "https://a.example/" }], { user: "+90 532 000 00 00" }), /email addresses and phone numbers/],
      [batch([]), /events is a list of 1 to 50/],
      [batch([{ type: "scroll", url: "https://a.example/" }]), /type is one of/],
      [batch([{ type: "pageview" }]), /url is required/],
      [batch([{ type: "pageview", url: "https://a.example/", value: "secret" }]), /value is part of an ecommerce event only/],
      [batch([{ type: "event", url: "https://a.example/", name: "bad name" }]), /name is up to 64/],
      [batch([{ type: "event", url: "https://a.example/", name: "x", props: { a: { b: 1 } } }]), /values are strings, numbers or booleans/],
      [batch([{ type: "leave", url: "https://a.example/", duration: -1 }]), /duration must be a number of 0 or more/],
    ];
    for (const [body, error] of cases) expect(() => parseBatch(body, now), JSON.stringify(body)).toThrow(error);
  });
});
