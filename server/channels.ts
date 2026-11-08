// Channel groups: where a visit came from, in the groups every analytics tool shows. Worked out once, when a visit
// starts, from the referring host, the utm_* parameters and whether the address carried an ad click id, with the rules
// GA4 uses for its default channel groups and one group GA4 does not have: AI assistants.
//
// The lists below are kept here, with tests in channels.test.ts. A site can put its own sources in a channel with
// `channels:` in the sites file, such as `email: [partner-bulten]`: a referring host or a utm_source it names goes to
// that channel before any rule here is tried.

export const CHANNELS = [
  "ai",
  "paid-search",
  "organic-search",
  "paid-social",
  "social",
  "email",
  "affiliate",
  "display",
  "paid-other",
  "referral",
  "other",
  "direct",
] as const;
export type Channel = (typeof CHANNELS)[number];

/** What a host on one of the lists below is. */
export type HostGroup = "ai" | "search" | "social" | "email";

/** A site's own sources for a channel: referring hosts (and their subdomains) or utm_source values. */
export type OwnChannels = Partial<Record<Channel, string[]>>;

/** A channel as the sites file may name it: its id, or its name as people say it, such as Email or AI assistants. */
export function channelId(name: string): Channel | null {
  const id = name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  const alias: Record<string, Channel> = {
    "ai-assistants": "ai",
    "organic-social": "social",
    search: "organic-search",
    "paid-display": "display",
    affiliates: "affiliate",
  };
  const c = alias[id] ?? id;
  return (CHANNELS as readonly string[]).includes(c) ? (c as Channel) : null;
}

/**
 * AI assistants and AI search. A host matches itself and its subdomains. They come first: gemini.google.com and
 * copilot.microsoft.com are not Google or Bing search.
 */
export const AI_HOSTS = [
  "chatgpt.com",
  "chat.openai.com",
  "openai.com",
  "perplexity.ai",
  "claude.ai",
  "gemini.google.com",
  "bard.google.com",
  "aistudio.google.com",
  "notebooklm.google.com",
  "copilot.microsoft.com",
  "copilot.cloud.microsoft",
  "m365copilot.com",
  "chat.deepseek.com",
  "deepseek.com",
  "chat.mistral.ai",
  "you.com",
  "phind.com",
  "poe.com",
  "meta.ai",
  "grok.com",
  "pi.ai",
  "chat.qwen.ai",
  "kimi.com",
  "kimi.moonshot.cn",
  "duck.ai",
];

/** Search engines. `google.*` matches a host that starts with google., such as google.com.tr or google.de. */
export const SEARCH_HOSTS = [
  "google.*",
  "bing.com",
  "duckduckgo.com",
  "yahoo.*",
  "search.yahoo.com",
  "yandex.*",
  "ya.ru",
  "baidu.com",
  "ecosia.org",
  "search.brave.com",
  "startpage.com",
  "qwant.com",
  "naver.com",
  "daum.net",
  "seznam.cz",
  "sogou.com",
  "so.com",
  "ask.com",
  "aol.com",
  "search.aol.com",
  "yep.com",
  "mojeek.com",
  "kagi.com",
  "petalsearch.com",
  "presearch.com",
  "metager.org",
  "swisscows.com",
  "coccoc.com",
  "rambler.ru",
];

export const SOCIAL_HOSTS = [
  "facebook.com",
  "fb.com",
  "fb.me",
  "messenger.com",
  "instagram.com",
  "threads.net",
  "threads.com",
  "t.co",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "lnkd.in",
  "reddit.com",
  "redd.it",
  "youtube.com",
  "youtu.be",
  "pinterest.*",
  "pin.it",
  "tiktok.com",
  "snapchat.com",
  "bsky.app",
  "mastodon.social",
  "mastodon.online",
  "tumblr.com",
  "quora.com",
  "vk.com",
  "ok.ru",
  "weibo.com",
  "discord.com",
  "discord.gg",
  "whatsapp.com",
  "wa.me",
  "t.me",
  "telegram.org",
  "news.ycombinator.com",
  "medium.com",
  "twitch.tv",
  "vimeo.com",
  "xing.com",
  "eksisozluk.com",
  "line.me",
  "kakao.com",
  "slack.com",
];

/** Webmail: a visit from a link in an email. */
export const EMAIL_HOSTS = [
  "mail.google.com",
  "outlook.live.com",
  "outlook.office.com",
  "outlook.office365.com",
  "mail.yahoo.com",
  "mail.aol.com",
  "mail.proton.me",
  "mail.yandex.ru",
  "mail.yandex.com",
  "mail.zoho.com",
  "e.mail.ru",
  "webmail.*",
];

const PAID = /^(.*cp.*|ppc|retargeting|paid.*)$/;
const SOCIAL_MEDIUM = /^(social|social[-_ ]?network|social[-_ ]?media|sm|organic[-_ ]?social)$/;
const EMAIL_TEXT = /^(email|e-mail|e_mail|e mail|newsletter)$/;
const DISPLAY = /^(display|banner|expandable|interstitial|cpm)$/;
const SEARCH_MEDIUM = /^(organic|search)$/;

/** Whether a host is one of a list: itself, a subdomain of it, or for `name.*` a host that starts with the name. */
function hostIn(host: string, list: readonly string[]): boolean {
  return list.some((entry) => {
    if (entry.endsWith(".*")) {
      const name = entry.slice(0, -2);
      return host.startsWith(`${name}.`);
    }
    return host === entry || host.endsWith(`.${entry}`);
  });
}

/** A utm_source such as chatgpt.com, Google or facebook, as a host to look up. */
function sourceHost(value: string): string {
  const v = value.trim().toLowerCase();
  if (v.includes("."))
    return (
      v
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .split("/")[0] ?? v
    );
  // A bare name: google stands for google.com, so it matches the lists.
  return `${v}.com`;
}

/** The group a host is in, by the lists above. */
export function groupOf(host: string | null): HostGroup | null {
  if (!host) return null;
  const h = host.toLowerCase().replace(/^www\./, "");
  if (hostIn(h, EMAIL_HOSTS)) return "email";
  if (hostIn(h, AI_HOSTS)) return "ai";
  if (hostIn(h, SEARCH_HOSTS)) return "search";
  if (hostIn(h, SOCIAL_HOSTS)) return "social";
  return null;
}

export interface Arrival {
  /** The referring host without www., or null when the visit came from nowhere or from the site itself. */
  source: string | null;
  utm: { source: string | null; medium: string | null; campaign: string | null };
  /** The address carried an ad click id (gclid, gbraid, wbraid, msclkid, dclid). */
  paidClick?: boolean;
}

/** The channel of a visit: the site's own sources first, then the rules in the order GA4 checks its default groups. */
export function channelOf({ source, utm, paidClick = false }: Arrival, own: OwnChannels = {}): Channel {
  const medium = utm.medium?.trim().toLowerCase() ?? "";
  const utmSource = utm.source?.trim().toLowerCase() ?? "";
  const campaign = utm.campaign?.trim().toLowerCase() ?? "";
  const host = source?.toLowerCase().replace(/^www\./, "") ?? null;
  for (const [channel, sources] of Object.entries(own) as Array<[Channel, string[]]>)
    if (sources.some((x) => x === utmSource || (host && hostIn(host, [x])))) return channel;
  const group = groupOf(source) ?? (utmSource ? groupOf(sourceHost(utmSource)) : null);
  const paid = PAID.test(medium) || paidClick;

  if (group === "ai" && !paid) return "ai";
  if (EMAIL_TEXT.test(medium) || EMAIL_TEXT.test(utmSource) || group === "email") return "email";
  if (medium === "affiliate" || medium === "affiliates") return "affiliate";
  if (group === "search" || SEARCH_MEDIUM.test(medium)) return paid ? "paid-search" : "organic-search";
  if (group === "social" || SOCIAL_MEDIUM.test(medium) || /social/.test(campaign)) return paid ? "paid-social" : "social";
  if (DISPLAY.test(medium)) return "display";
  if (paid) return paidClick && !medium ? "paid-search" : "paid-other";
  if (medium === "referral" || source) return "referral";
  if (medium || utmSource || campaign) return "other";
  return "direct";
}
