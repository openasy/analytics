// Search: what people searched before they came, from Google Search Console, Bing Webmaster Tools and Yandex
// Webmaster, imported daily, beside what the visits that entered on each page did.
import { Callout, DataTable, EmptyState, KpiCard, KpiGrid, Panel, SegmentedControl, useAgo, type Column } from "@openasy/ui";
import { useState, type ReactNode } from "react";
import type { Engine, SearchConsole } from "./api.ts";
import { Code } from "./common.tsx";
import { useFormat } from "./format.ts";
import { useT } from "./i18n.ts";
import { CsvButton, Failed, Loading, Note, Report, useDelta, useLoad, useReport, useTab } from "./report.tsx";

const TABS = ["queries", "pages"] as const;
const ENGINES: Engine[] = ["google", "bing", "yandex"];

const EXAMPLE = `    searchConsole:
      google: sc-domain:example.com
      bing: https://www.example.com/
      yandex: https:www.example.com:443`;

export function SearchPage({ at }: { at?: string }) {
  const t = useT();
  const f = useFormat();
  const r = useReport();
  const ago = useAgo();
  const delta = useDelta();
  const [tab, setTab] = useTab("search", TABS, at);
  const linked = ENGINES.filter((e) => r.current?.searchConsole?.[e]);
  const [picked, setPicked] = useState<Engine>();
  const engine = picked && linked.includes(picked) ? picked : (linked[0] ?? "google");
  const data = useLoad<SearchConsole>(
    r.site && linked.length
      ? `/api/v1/search-console?${new URLSearchParams({ site: r.site, days: String(r.days), engine, ...(r.compare && { compare: r.compare }) })}`
      : null,
  );
  const page = (children: ReactNode) => (
    <Report
      title={t("searchConsole.title")}
      description={t("searchConsole.description")}
      tabs={TABS.map((x) => ({ value: x, label: t(`searchConsole.${x}`) }))}
      tab={tab}
      onTab={setTab}
    >
      {children}
    </Report>
  );
  if (!linked.length)
    return page(
      <EmptyState title={t("searchConsole.none")}>
        <span className="flex flex-col gap-2">
          {t("searchConsole.noneDetail")}
          <Code>{EXAMPLE}</Code>
        </span>
      </EmptyState>,
    );
  if (data === null) return page(<Failed />);
  if (!data) return page(<Loading />);
  const status = data.engines.find((e) => e.engine === engine)!;
  const c = data.compare?.totals;
  type Q = SearchConsole["queries"][number];
  type P = SearchConsole["pages"][number];
  const position = (v: number | null) => (v === null ? "–" : f.num(v));
  const qCols: Column<Q>[] = [
    {
      id: "query",
      header: t("searchConsole.query"),
      width: "34%",
      cell: (q) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{q.query}</span>
          {q.page && <span className="truncate font-mono text-2xs text-fg-muted">{URL.parse(q.page)?.pathname ?? q.page}</span>}
        </span>
      ),
    },
    { id: "clicks", header: t("searchConsole.clicks"), align: "right", mono: true, sortValue: (q) => q.clicks, cell: (q) => f.num(q.clicks) },
    {
      id: "impressions",
      header: t("searchConsole.impressions"),
      align: "right",
      mono: true,
      sortValue: (q) => q.impressions,
      cell: (q) => f.num(q.impressions),
    },
    { id: "ctr", header: "CTR", align: "right", mono: true, sortValue: (q) => q.ctr, cell: (q) => f.pct(q.ctr) },
    { id: "position", header: t("searchConsole.position"), align: "right", mono: true, sortValue: (q) => q.position ?? 999, cell: (q) => position(q.position) },
  ];
  const pCols: Column<P>[] = [
    { id: "page", header: t("table.page"), cell: (p) => <span className="analytics-wrap font-mono text-xs font-medium">{p.path}</span> },
    { id: "clicks", header: t("searchConsole.clicks"), align: "right", mono: true, sortValue: (p) => p.clicks, cell: (p) => f.num(p.clicks) },
    {
      id: "impressions",
      header: t("searchConsole.impressions"),
      align: "right",
      mono: true,
      sortValue: (p) => p.impressions,
      cell: (p) => f.num(p.impressions),
    },
    { id: "ctr", header: "CTR", align: "right", mono: true, sortValue: (p) => p.ctr, cell: (p) => f.pct(p.ctr) },
    { id: "position", header: t("searchConsole.position"), align: "right", mono: true, sortValue: (p) => p.position ?? 999, cell: (p) => position(p.position) },
    { id: "entries", header: t("searchConsole.entries"), align: "right", mono: true, sortValue: (p) => p.entries, cell: (p) => f.num(p.entries) },
    {
      id: "bounce",
      header: t("searchConsole.bounceHere"),
      align: "right",
      mono: true,
      description: t("searchConsole.bounceHereDetail"),
      sortValue: (p) => p.bounceRate ?? -1,
      cell: (p) => (p.bounceRate === null ? "–" : f.pct(p.bounceRate)),
    },
  ];
  return page(
    <>
      {linked.length > 1 && (
        <SegmentedControl
          label={t("searchConsole.engine")}
          value={engine}
          onChange={setPicked}
          options={linked.map((e) => ({ value: e, label: t(`searchConsole.${e}`) }))}
        />
      )}
      {status.missing ? (
        <Callout tone="warning" title={t("searchConsole.keyMissing", { engine: t(`searchConsole.${engine}`) })}>
          {t("searchConsole.keyMissingDetail", { variables: status.missing })}
        </Callout>
      ) : status.error ? (
        <Callout tone="danger" title={t("searchConsole.failed", { engine: t(`searchConsole.${engine}`) })}>
          {status.error}
        </Callout>
      ) : (
        <Callout tone="info" title={`${t(`searchConsole.${engine}`)}: ${status.property}`}>
          {status.importedAt ? t("searchConsole.imported", { day: status.importedUntil ?? "", ago: ago(status.importedAt) }) : t("searchConsole.notYet")}
        </Callout>
      )}
      <KpiGrid>
        <KpiCard label={t("searchConsole.clicks")} value={f.num(data.totals.clicks)} delta={delta(data.totals.clicks, c?.clicks)} />
        <KpiCard label={t("searchConsole.impressions")} value={f.num(data.totals.impressions)} delta={delta(data.totals.impressions, c?.impressions)} />
        <KpiCard label="CTR" value={f.pct(data.totals.ctr)} delta={c ? delta(data.totals.ctr, c.ctr, { points: true }) : undefined} />
        <KpiCard
          label={t("searchConsole.averagePosition")}
          value={position(data.totals.position)}
          delta={c?.position != null && data.totals.position !== null ? delta(data.totals.position, c.position, { lowerIsBetter: true }) : undefined}
        />
      </KpiGrid>
      {tab === "queries" ? (
        <Panel
          flush
          title={t("searchConsole.queries")}
          description={t("searchConsole.hidden", { clicks: f.num(data.hidden), engine: t(`searchConsole.${engine}`) })}
          actions={
            <CsvButton
              name={`search-queries-${engine}`}
              rows={data.queries}
              columns={[
                [t("searchConsole.query"), (q) => q.query],
                [t("table.page"), (q) => q.page],
                [t("searchConsole.clicks"), (q) => q.clicks],
                [t("searchConsole.impressions"), (q) => q.impressions],
                [t("searchConsole.position"), (q) => q.position],
              ]}
            />
          }
        >
          <DataTable
            key={engine}
            label={t("searchConsole.queries")}
            columns={qCols}
            rows={data.queries}
            getRowId={(q) => `${q.query}|${q.page ?? ""}`}
            defaultSort={{ id: "clicks", direction: "desc" }}
            minWidth={720}
            pageSize={50}
            empty={<p className="m-0 px-3 py-2 text-sm text-fg-muted">{t("report.noneInPeriod")}</p>}
          />
        </Panel>
      ) : (
        <Panel
          flush
          title={t("searchConsole.pages")}
          description={t("searchConsole.pagesDetail")}
          actions={
            <CsvButton
              name={`search-pages-${engine}`}
              rows={data.pages}
              columns={[
                [t("table.page"), (p) => p.page],
                [t("searchConsole.clicks"), (p) => p.clicks],
                [t("searchConsole.impressions"), (p) => p.impressions],
                [t("searchConsole.position"), (p) => p.position],
              ]}
            />
          }
        >
          <DataTable
            key={engine}
            label={t("searchConsole.pages")}
            columns={pCols}
            rows={data.pages}
            getRowId={(p) => p.page}
            defaultSort={{ id: "clicks", direction: "desc" }}
            minWidth={760}
            pageSize={50}
            empty={<p className="m-0 px-3 py-2 text-sm text-fg-muted">{engine === "yandex" ? t("searchConsole.noPagesYandex") : t("report.noneInPeriod")}</p>}
          />
        </Panel>
      )}
      <Note>{t("searchConsole.note")}</Note>
    </>,
  );
}
