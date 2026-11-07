// What the pages share: data loading with the session, the site and period a report covers, and formatting.
import { EmptyState, PageHeader, SegmentedControl, SelectField } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, MfaSetupRequired, Unauthorized, type Range, type Report, type Site } from "./api.ts";
import { useT, type T } from "./i18n.ts";

/** Data loading with the session; when it ends, the sign-in screen comes back. */
export function useApi() {
  const { expired, refresh } = useAuth();
  return useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      try {
        return await api<T>(path, init);
      } catch (err) {
        if (err instanceof Unauthorized) expired();
        if (err instanceof MfaSetupRequired) void refresh();
        throw err;
      }
    },
    [expired, refresh],
  );
}
export type Call = ReturnType<typeof useApi>;

export function Code({ children }: { children: ReactNode }) {
  return <pre className="m-0 overflow-x-auto rounded-md bg-subtle px-2.5 py-2 font-mono text-xs text-fg">{children}</pre>;
}

// ---------------------------------------------------------------- Formatting

/** 75 → "1m 15s"; an hour or more → "1h 5m". */
export function duration(seconds: number | null): string {
  if (seconds === null) return "–";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
export const percent = (v: number) => `${Math.round(v * 100)}%`;
export const shortDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
export const time = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

// ---------------------------------------------------------------- Site and period

/** The site and period every report page shows, kept for this browser only. */
export function useChoice(sites: Site[] | undefined) {
  const read = (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  };
  const write = (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      // the choice lasts for this page only
    }
  };
  const [picked, setPicked] = useState(() => read("analytics.site") ?? "");
  const [range, setRange] = useState<Range>(() => (Number(read("analytics.days")) as Range) || 7);
  const site = sites?.some((s) => s.name === picked) ? picked : (sites?.[0]?.name ?? "");
  return {
    site,
    range,
    setSite: (s: string) => (setPicked(s), write("analytics.site", s)),
    setRange: (r: Range) => (setRange(r), write("analytics.days", String(r))),
  };
}
export type Choice = ReturnType<typeof useChoice>;

export function ChoiceBar({ sites, choice }: { sites: Site[]; choice: Choice }) {
  const t = useT();
  return (
    <span className="flex flex-wrap items-center gap-2">
      {sites.length > 1 && (
        <SelectField
          aria-label={t("choice.site")}
          value={choice.site}
          onChange={(e) => choice.setSite(e.target.value)}
          options={sites.map((s) => ({ value: s.name, label: s.name }))}
        />
      )}
      <SegmentedControl<string>
        label={t("choice.period")}
        size="sm"
        value={String(choice.range)}
        onChange={(v) => choice.setRange(Number(v) as Range)}
        options={[
          { value: "1", label: t("choice.today") },
          { value: "7", label: t("choice.days", { count: 7 }) },
          { value: "30", label: t("choice.days", { count: 30 }) },
          { value: "90", label: t("choice.days", { count: 90 }) },
        ]}
      />
    </span>
  );
}

export function useReport(call: Call, choice: Choice) {
  const [report, setReport] = useState<Report | null>();
  useEffect(() => {
    if (!choice.site) return;
    setReport(undefined);
    void call<Report>(`/api/v1/report?${new URLSearchParams({ site: choice.site, days: String(choice.range) })}`).then(setReport, () => setReport(null));
  }, [call, choice.site, choice.range]);
  return report;
}

/** The heading of a report page: its title, the site and period it covers, and where to change them. */
export function ReportHeader({ title, description, sites, choice }: { title: string; description: string; sites: Site[]; choice: Choice }) {
  return <PageHeader title={title} description={description} actions={<ChoiceBar sites={sites} choice={choice} />} />;
}

export const nothing = (t: T) => <EmptyState title={t("report.nothingYet")}>{t("report.nothingYetDetail")}</EmptyState>;
