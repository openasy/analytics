import { describe, expect, it } from "vitest";
import { AI_HOSTS, channelId, channelOf, groupOf, SEARCH_HOSTS, SOCIAL_HOSTS } from "./channels.ts";

const none: { source: string | null; medium: string | null; campaign: string | null } = { source: null, medium: null, campaign: null };
const from = (source: string | null, utm: Partial<typeof none> = {}, paidClick = false) => channelOf({ source, utm: { ...none, ...utm }, paidClick });

describe("channel groups", () => {
  it("puts AI assistants in their own group, before the search engines they belong to", () => {
    for (const host of ["chatgpt.com", "chat.openai.com", "perplexity.ai", "www.perplexity.ai", "claude.ai", "gemini.google.com", "copilot.microsoft.com"])
      expect(from(host), host).toBe("ai");
    // ChatGPT adds utm_source=chatgpt.com to the links it gives, often with no referrer at all.
    expect(from(null, { source: "chatgpt.com" })).toBe("ai");
    expect(from("google.com")).toBe("organic-search");
    expect(from("bing.com")).toBe("organic-search");
  });

  it("tells paid search from organic search by the medium or an ad click id", () => {
    expect(from("google.com.tr")).toBe("organic-search");
    expect(from("google.de", { medium: "cpc" })).toBe("paid-search");
    expect(from(null, {}, true)).toBe("paid-search");
    expect(from("duckduckgo.com", { medium: "ppc" })).toBe("paid-search");
    expect(from(null, { source: "google", medium: "organic" })).toBe("organic-search");
  });

  it("names social, email, affiliates, display, referral, other and direct", () => {
    expect(from("t.co")).toBe("social");
    expect(from("l.facebook.com")).toBe("social");
    expect(from("news.ycombinator.com")).toBe("social");
    expect(from("instagram.com", { medium: "paid_social" })).toBe("paid-social");
    expect(from(null, { source: "facebook", medium: "cpc" })).toBe("paid-social");
    expect(from(null, { source: "newsletter", medium: "email" })).toBe("email");
    expect(from("mail.google.com")).toBe("email");
    expect(from(null, { medium: "affiliate" })).toBe("affiliate");
    expect(from(null, { medium: "banner" })).toBe("display");
    expect(from(null, { source: "partner", medium: "cpm" })).toBe("display");
    expect(from(null, { source: "partner", medium: "paid" })).toBe("paid-other");
    expect(from("blog.example")).toBe("referral");
    expect(from(null, { source: "qr-code" })).toBe("other");
    expect(from(null)).toBe("direct");
  });

  it("puts a site's own sources in the channel the sites file names, by referring host or utm_source", () => {
    expect(channelOf({ source: "news.ycombinator.com", utm: none }, { referral: ["news.ycombinator.com"] })).toBe("referral");
    expect(channelOf({ source: "ask.internal.example", utm: none }, { ai: ["internal.example"] })).toBe("ai");
    expect(channelOf({ source: null, utm: { ...none, source: "Partner-Bulten" } }, { email: ["partner-bulten"] })).toBe("email");
    expect(channelOf({ source: "google.com", utm: none }, { email: ["partner-bulten"] })).toBe("organic-search");
  });

  it("reads a channel by its id or its name", () => {
    expect(channelId("Email")).toBe("email");
    expect(channelId("AI assistants")).toBe("ai");
    expect(channelId("Organic search")).toBe("organic-search");
    expect(channelId("paid-search")).toBe("paid-search");
    expect(channelId("Carrier pigeon")).toBeNull();
  });

  it("matches a host, its subdomains, and for name.* the name with any ending, nothing else", () => {
    expect(groupOf("www.google.co.uk")).toBe("search");
    expect(groupOf("yandex.ru")).toBe("search");
    expect(groupOf("notgoogle.com")).toBeNull();
    expect(groupOf("m.youtube.com")).toBe("social");
    expect(groupOf("claude.ai.example")).toBeNull();
    expect(groupOf(null)).toBeNull();
  });

  it("keeps lists of plain lowercase hosts", () => {
    for (const host of [...AI_HOSTS, ...SEARCH_HOSTS, ...SOCIAL_HOSTS]) expect(host, host).toMatch(/^[a-z0-9.-]+(\.\*)?$/);
  });
});
