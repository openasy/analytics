// Acquisition: the channel each visit was put in, the sites that sent visits with the full addresses they came from,
// tagged campaigns by any of their utm_* parameters, and visits sent by AI assistants.
import { BarList, Callout, DataTable, KpiCard, KpiGrid, Panel, SegmentedControl, type Column } from "@openasy/ui";
import { useState } from "react";
import type { BreakdownDimension, BreakdownRow } from "./api.ts";
import { duration } from "./common.tsx";
import { NONE, useFormat } from "./format.ts";
import { useT } from "./i18n.ts";
import { byValue, Change, CsvButton, Failed, Loading, Note, Report, useBreakdown, useDelta, useReport, useTab, type Filter } from "./report.tsx";

const TABS = ["channels", "sources", "campaigns", "assistants"] as const;

export function AcquisitionPage({ at }: { at?: string }) {
  const t = useT();
  const [tab, setTab] = useTab("acquisition", TABS, at);
  return (
    <Report
      title={t("acquisition.title")}
      description={t(`acquisition.${tab}Detail`)}
      tabs={TABS.map((x) => ({ value: x, label: t(`acquisition.${x}`) }))}
      tab={tab}
      onTab={setTab}
    >
      {tab === "channels" && <ChannelsTab />}
      {tab === "sources" && <SourcesTab />}
      {tab === "campaigns" && <CampaignsTab />}
      {tab === "assistants" && <AssistantsTab />}
    </Report>
  );
}

/** Columns every table of visits by one value shares: visits, their share, the change, engagement and length. */
function visitColumns(t: ReturnType<typeof useT>, f: ReturnType<typeof useFormat>, total: number, then: Map<string | null, BreakdownRow> | null) {
  const cols: Column<BreakdownRow>[] = [
    { id: "visits", header: t("table.visits"), align: "right", mono: true, sortValue: (x) => x.visits, cell: (x) => f.num(x.visits) },
    { id: "share", header: t("table.share"), align: "right", mono: true, sortValue: (x) => x.visits, cell: (x) => f.share(x.visits, total) },
    ...(then
      ? [
          {
            id: "change",
            header: t("table.change"),
            align: "right" as const,
            mono: true,
            sortValue: (x: BreakdownRow) => x.visits / Math.max(1, then.get(x.value)?.visits ?? 0),
            cell: (x: BreakdownRow) => <Change now={x.visits} then={then.get(x.value)?.visits} />,
          },
        ]
      : []),
    {
      id: "engaged",
      header: t("table.engaged"),
      align: "right",
      mono: true,
      sortValue: (x) => x.engagementRate ?? 0,
      cell: (x) => (x.engagementRate === null ? "–" : f.pct(x.engagementRate)),
      description: t("table.engagedDetail"),
    },
    {
      id: "bounce",
      header: t("table.bounce"),
      align: "right",
      mono: true,
      sortValue: (x) => 1 - (x.engagementRate ?? 1),
      cell: (x) => (x.engagementRate === null ? "–" : f.pct(1 - x.engagementRate)),
    },
    { id: "duration", header: t("table.visitLength"), align: "right", sortValue: (x) => x.duration ?? 0, cell: (x) => duration(x.duration) },
  ];
  return cols;
}

function ChannelsTab() {
  const t = useT();
  const f = useFormat();
  const b = useBreakdown("channel", { limit: 50 });
  if (b === null) return <Failed />;
  if (!b) return <Loading />;
  const total = b.rows.reduce((n, x) => n + x.visits, 0);
  const cols: Column<BreakdownRow>[] = [
    {
      id: "name",
      header: t("table.channel"),
      width: "30%",
      cell: (c) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{f.channel(c.value)}</span>
          <span className="text-2xs text-fg-muted">{f.channelHow(c.value)}</span>
        </span>
      ),
    },
    ...visitColumns(t, f, total, b.compare ? byValue(b.compare.rows) : null),
  ];
  return (
    <>
      <Panel
        flush
        title={t("acquisition.channels")}
        description={t("acquisition.channelsTotal", { visits: f.num(total) })}
        actions={
          <CsvButton
            name="channels"
            rows={b.rows}
            columns={[
              [t("table.channel"), (c) => f.channel(c.value)],
              [t("table.visits"), (c) => c.visits],
              [t("table.visitors"), (c) => c.visitors],
              [t("table.engagementRate"), (c) => c.engagementRate],
              [t("table.secondsPerVisit"), (c) => c.duration],
            ]}
          />
        }
      >
        <DataTable
          label={t("acquisition.channels")}
          columns={cols}
          rows={b.rows}
          getRowId={(c) => c.value ?? NONE}
          defaultSort={{ id: "visits", direction: "desc" }}
          minWidth={820}
          empty={<Nothing />}
        />
      </Panel>
      <Note>{t("acquisition.channelsNote")}</Note>
    </>
  );
}

function Nothing() {
  const t = useT();
  return <p className="m-0 px-3 py-2 text-sm text-fg-muted">{t("report.noneInPeriod")}</p>;
}

function SourcesTab() {
  const t = useT();
  const f = useFormat();
  const b = useBreakdown("source", { limit: 200 });
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const source = picked !== undefined ? picked : (b?.rows.find((x) => x.value !== null)?.value ?? b?.rows[0]?.value ?? null);
  const filter: Filter = { dimension: "source", op: "is", values: [source ?? NONE] };
  const refs = useBreakdown("referrer", { limit: 100, filters: [filter], skip: !b?.rows.length });
  if (b === null) return <Failed />;
  if (!b) return <Loading />;
  const total = b.rows.reduce((n, x) => n + x.visits, 0);
  const then = b.compare ? byValue(b.compare.rows) : null;
  const cols: Column<BreakdownRow>[] = [
    {
      id: "source",
      header: t("table.source"),
      cell: (x) => <span className={x.value ? "truncate font-mono text-xs font-medium" : "text-fg-muted"}>{f.source(x.value)}</span>,
    },
    { id: "visits", header: t("table.visits"), align: "right", mono: true, sortValue: (x) => x.visits, cell: (x) => f.num(x.visits) },
    { id: "share", header: t("table.share"), align: "right", mono: true, sortValue: (x) => x.visits, cell: (x) => f.share(x.visits, total) },
    ...(then
      ? [
          {
            id: "change",
            header: t("table.change"),
            align: "right" as const,
            mono: true,
            cell: (x: BreakdownRow) => <Change now={x.visits} then={then.get(x.value)?.visits} />,
          },
        ]
      : []),
    {
      id: "bounce",
      header: t("table.bounce"),
      align: "right",
      mono: true,
      sortValue: (x) => 1 - (x.engagementRate ?? 1),
      cell: (x) => (x.engagementRate === null ? "–" : f.pct(1 - x.engagementRate)),
    },
  ];
  return (
    <div className="grid gap-2.5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Panel
        flush
        title={t("acquisition.sources")}
        description={t("acquisition.sourcesPick")}
        actions={
          <CsvButton
            name="sources"
            rows={b.rows}
            columns={[
              [t("table.source"), (x) => f.source(x.value)],
              [t("table.visits"), (x) => x.visits],
              [t("table.visitors"), (x) => x.visitors],
              [t("table.engagementRate"), (x) => x.engagementRate],
            ]}
          />
        }
      >
        <DataTable
          label={t("acquisition.sources")}
          columns={cols}
          rows={b.rows}
          getRowId={(x) => x.value ?? NONE}
          onRowClick={(x) => setPicked(x.value)}
          activeRowId={source ?? NONE}
          minWidth={420}
          defaultSort={{ id: "visits", direction: "desc" }}
          pageSize={50}
          empty={<Nothing />}
        />
      </Panel>
      {b.rows.length > 0 && (
        <Panel
          aria-label={t("acquisition.referringPages")}
          title={source ? t("acquisition.from", { source }) : t("sources.direct")}
          description={t("acquisition.referringDetail")}
          className="self-start"
          actions={
            refs?.rows.length ? (
              <CsvButton
                name={`referrers-${source ?? "direct"}`}
                rows={refs.rows}
                columns={[
                  [t("table.address"), (x) => x.value],
                  [t("table.visits"), (x) => x.visits],
                ]}
              />
            ) : undefined
          }
        >
          {refs === undefined ? (
            <Loading />
          ) : refs?.rows.some((x) => x.value) ? (
            <ul aria-label={t("acquisition.referringPages")} className="analytics-list flex flex-col">
              {refs.rows
                .filter((x) => x.value)
                .map((x) => (
                  <li key={x.value} className="flex items-center justify-between gap-2 border-b border-subtle py-1.5 text-xs last:border-0">
                    <span className="analytics-wrap min-w-0 font-mono text-fg">{x.value}</span>
                    <span className="shrink-0 font-mono tabular-nums">{f.num(x.visits)}</span>
                  </li>
                ))}
            </ul>
          ) : (
            <p className="m-0 text-sm text-fg-muted">{source ? t("acquisition.noReferrer") : t("acquisition.directDetail")}</p>
          )}
        </Panel>
      )}
    </div>
  );
}

const CAMPAIGN_KEYS = {
  campaign: "utmCampaign",
  source: "utmSource",
  medium: "utmMedium",
  term: "utmTerm",
  content: "utmContent",
} as const satisfies Record<string, BreakdownDimension>;
type CampaignKey = keyof typeof CAMPAIGN_KEYS;

function CampaignsTab() {
  const t = useT();
  const f = useFormat();
  const [by, setBy] = useState<CampaignKey>("campaign");
  const dimension = CAMPAIGN_KEYS[by];
  const b = useBreakdown(dimension, { limit: 200 });
  const label = `utm_${by}`;
  const rows = b?.rows.filter((x) => x.value !== null) ?? [];
  const total = rows.reduce((n, x) => n + x.visits, 0);
  const cols: Column<BreakdownRow>[] = [
    { id: "key", header: label, cell: (x) => <span className="analytics-wrap font-mono text-xs font-medium">{x.value}</span> },
    ...visitColumns(t, f, total, b?.compare ? byValue(b.compare.rows) : null),
  ];
  return (
    <>
      <SegmentedControl
        label={t("acquisition.groupBy")}
        value={by}
        onChange={setBy}
        options={(Object.keys(CAMPAIGN_KEYS) as CampaignKey[]).map((k) => ({ value: k, label: t(`acquisition.by_${k}`) }))}
      />
      {b === null ? (
        <Failed />
      ) : (
        <Panel
          flush
          title={t("acquisition.byKey", { key: label })}
          description={t("acquisition.taggedVisits", { visits: f.num(total) })}
          actions={
            <CsvButton
              name={`campaigns-by-${by}`}
              rows={rows}
              columns={[
                [label, (x) => x.value],
                [t("table.visits"), (x) => x.visits],
                [t("table.visitors"), (x) => x.visitors],
                [t("table.engagementRate"), (x) => x.engagementRate],
              ]}
            />
          }
        >
          <DataTable
            key={by}
            label={t("acquisition.campaigns")}
            columns={cols}
            rows={rows}
            loading={b === undefined}
            getRowId={(x) => x.value ?? NONE}
            defaultSort={{ id: "visits", direction: "desc" }}
            minWidth={720}
            pageSize={50}
            empty={<p className="m-0 px-3 py-2 text-sm text-fg-muted">{t("acquisition.noCampaigns", { key: label })}</p>}
          />
        </Panel>
      )}
      <Note>{t("acquisition.campaignsNote")}</Note>
    </>
  );
}

const AI: Filter = { dimension: "channel", op: "is", values: ["ai"] };

function AssistantsTab() {
  const t = useT();
  const f = useFormat();
  const delta = useDelta();
  const { compare } = useReport();
  const channels = useBreakdown("channel", { limit: 50 });
  const sources = useBreakdown("source", { limit: 20, filters: [AI] });
  const tagged = useBreakdown("utmSource", { limit: 20, filters: [AI, { dimension: "source", op: "is", values: [NONE] }] });
  const landing = useBreakdown("entry", { limit: 10, filters: [AI] });
  if (channels === null) return <Failed />;
  if (!channels) return <Loading />;
  const ai = channels.rows.find((c) => c.value === "ai");
  const was = channels.compare?.rows.find((c) => c.value === "ai");
  const total = channels.rows.reduce((n, x) => n + x.visits, 0);
  const engaged = channels.rows.reduce((n, x) => n + (x.engagementRate ?? 0) * x.visits, 0);
  const assistants = [
    ...(sources?.rows.filter((x) => x.value) ?? []).map((x) => ({ id: `ref:${x.value}`, label: x.value!, value: x.visits })),
    ...(tagged?.rows.filter((x) => x.value) ?? []).map((x) => ({
      id: `utm:${x.value}`,
      label: t("acquisition.viaUtm", { source: x.value! }),
      value: x.visits,
    })),
  ].sort((a, b) => b.value - a.value);
  return (
    <>
      <KpiGrid>
        <KpiCard label={t("acquisition.aiVisits")} value={f.num(ai?.visits ?? 0)} delta={compare ? delta(ai?.visits ?? 0, was?.visits ?? 0) : undefined} />
        <KpiCard label={t("acquisition.aiShare")} value={f.share(ai?.visits ?? 0, total)} />
        <KpiCard
          label={t("table.engagementRate")}
          value={ai?.engagementRate == null ? "–" : f.pct(ai.engagementRate)}
          footer={<span className="text-xs text-fg-muted">{t("acquisition.siteAverage", { value: f.share(engaged, total) })}</span>}
        />
        <KpiCard label={t("table.visitLength")} value={duration(ai?.duration ?? null)} unit={t("overview.average")} />
      </KpiGrid>
      <div className="grid gap-2.5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Panel title={t("acquisition.byAssistant")} description={t("overview.visits")}>
          {sources === undefined ? (
            <Loading />
          ) : assistants.length ? (
            <BarList label={t("acquisition.byAssistantLabel")} items={assistants} />
          ) : (
            <p className="m-0 text-sm text-fg-muted">{t("acquisition.noAi")}</p>
          )}
        </Panel>
        <Panel title={t("acquisition.landing")} description={t("acquisition.landingDetail")}>
          {landing === undefined ? (
            <Loading />
          ) : landing?.rows.length ? (
            <BarList
              label={t("acquisition.landingLabel")}
              items={landing.rows.map((x) => ({ id: x.value ?? NONE, label: <span className="font-mono text-xs">{x.value ?? "–"}</span>, value: x.visits }))}
            />
          ) : (
            <p className="m-0 text-sm text-fg-muted">{t("acquisition.noAi")}</p>
          )}
        </Panel>
      </div>
      <Callout tone="info" title={t("acquisition.whatCounts")}>
        {t("acquisition.whatCountsDetail")}
      </Callout>
    </>
  );
}
