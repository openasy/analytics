// What the search window (Cmd+K) finds in Analytics: sites by name, the chosen site's pages by path from the last 30
// days, and a person's visits by the site's own user id.
import type { SearchFn, SearchResult } from "@openasy/ui";
import { FileText, Globe, UserRound } from "lucide-react";
import type { Report, Site } from "./api.ts";
import type { T } from "./i18n.ts";

type Call = <R>(path: string, init?: RequestInit) => Promise<R>;

export function search(call: Call, t: T, site: string): SearchFn {
  return async (q, signal) => {
    const [sites, report] = await Promise.all([
      call<{ sites: Site[] }>("/api/v1/sites", { signal }),
      site ? call<Report>(`/api/v1/report?${new URLSearchParams({ site, days: "30" })}`, { signal }).catch(() => null) : null,
    ]);
    const named: SearchResult[] = sites.sites
      .filter((s) => s.name.includes(q) || s.domains.some((d) => d.includes(q)))
      .slice(0, 6)
      .map((s) => ({
        id: `site:${s.name}`,
        label: s.name,
        detail: s.domains.join(", "),
        kind: t("search.site"),
        icon: Globe,
        mono: true,
        href: "/sites",
      }));
    const pages: SearchResult[] = (report?.pages ?? [])
      .filter((p) => p.path.toLowerCase().includes(q) || p.title?.toLowerCase().includes(q))
      .slice(0, 8)
      .map((p) => ({
        id: `page:${p.path}`,
        label: p.path,
        detail: t("search.pageDetail", { views: p.views, site }),
        kind: t("search.page"),
        icon: FileText,
        mono: true,
        href: "/pages",
      }));
    const user: SearchResult[] =
      site && /^[\w.:-]{2,128}$/.test(q)
        ? [{ id: `user:${q}`, label: q, detail: t("search.userDetail", { site }), kind: t("search.user"), icon: UserRound, mono: true, href: "/visits" }]
        : [];
    return [...named, ...pages, ...user];
  };
}
