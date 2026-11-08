// Numbers, shares and the names of what reports group by, in the person's language: channel ids, country codes,
// language tags and kinds of device as people read them.
import { useLocalePreference } from "@openasy/ui";
import { useMemo } from "react";
import { useT, type T } from "./i18n.ts";

/** The channels the server puts visits in, in the order GA4 checks its default groups. */
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

/** Stands for a visit without a value in a filter, such as a visit with no source. */
export const NONE = "(none)";

function displayNames(locale: string, type: "region" | "language") {
  try {
    return new Intl.DisplayNames([locale], { type, fallback: "code" });
  } catch {
    return null;
  }
}

export function makeFormat(locale: string, t: T) {
  const plain = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const regions = displayNames(locale, "region");
  const languages = displayNames(locale, "language");
  const of = (names: Intl.DisplayNames | null, code: string) => {
    try {
      return names?.of(code) ?? code;
    } catch {
      return code;
    }
  };
  const isChannel = (v: string): v is Channel => (CHANNELS as readonly string[]).includes(v);
  const f = {
    locale,
    num: (n: number) => plain.format(n),
    /** A ratio as a percent: 0.456 is 45.6%. */
    pct: (ratio: number, digits = 1) => new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: digits }).format(ratio),
    /** A share of a whole, 0 when the whole is 0. */
    share: (part: number, whole: number, digits = 1) =>
      new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: digits }).format(whole ? part / whole : 0),
    channel: (id: string | null) => (id === null ? t("value.none") : isChannel(id) ? t(`channel.${id}`) : id),
    channelHow: (id: string | null) => (id && isChannel(id) ? t(`channelHow.${id}`) : ""),
    country: (code: string | null) => (code ? of(regions, code.toUpperCase()) : t("value.unknownPlace")),
    language: (tag: string | null) => (tag ? of(languages, tag) : t("value.none")),
    device: (d: string | null) => (d === "desktop" || d === "mobile" || d === "tablet" ? t(`device.${d}`) : (d ?? t("value.none"))),
    source: (s: string | null) => s ?? t("sources.direct"),
    /** An amount in the site's currency, or a plain number when it names none. */
    money: (n: number, currency: string | null | undefined, compact = false) => {
      try {
        return currency
          ? new Intl.NumberFormat(locale, {
              style: "currency",
              currency,
              maximumFractionDigits: compact || Math.abs(n) >= 1000 ? 0 : 2,
              ...(compact && { notation: "compact" }),
            }).format(n)
          : new Intl.NumberFormat(locale, { maximumFractionDigits: 2, ...(compact && { notation: "compact" }) }).format(n);
      } catch {
        return `${plain.format(n)} ${currency ?? ""}`.trim();
      }
    },
    /** A value of any dimension, as a filter chip or a list shows it. */
    value: (dimension: string, v: string | null): string => {
      if (v === null || v === NONE) return t("value.none");
      if (dimension === "channel") return f.channel(v);
      if (dimension === "country") return f.country(v);
      if (dimension === "device") return f.device(v);
      if (dimension === "language") return f.language(v);
      if (dimension === "visitorType") return v === "new" ? t("value.new") : v === "returning" ? t("value.returning") : v;
      return v;
    },
  };
  return f;
}
export type Format = ReturnType<typeof makeFormat>;

export function useFormat(): Format {
  const t = useT();
  const [locale] = useLocalePreference();
  return useMemo(() => makeFormat(locale, t), [locale, t]);
}

/** A country's flag from its two-letter code, for lists; screen readers read the name beside it. */
export function flagOf(code: string | null): string {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return "🌐";
  return [...code.toUpperCase()].map((ch) => String.fromCodePoint(127397 + ch.charCodeAt(0))).join("");
}
