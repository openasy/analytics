// Visitors: where they are (country, region and city from the install's GeoIP database), what they use (kind of
// device, screen, browser and system with their versions), and their language and time zone.
import { Button, Callout, DataTable, DonutChart, BarList, Panel, SegmentedControl, SelectField, type Column } from "@openasy/ui";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import type { BreakdownRow, Summary } from "./api.ts";
import { NONE, useFormat } from "./format.ts";
import { useT } from "./i18n.ts";
import { CsvButton, Failed, Flag, Loading, Note, Report, ShareBar, useBreakdown, useReport, useTab } from "./report.tsx";

const TABS = ["locations", "devices", "languages"] as const;

export function VisitorsPage({ at, summary }: { at?: string; summary?: Summary }) {
  const t = useT();
  const [tab, setTab] = useTab("visitors", TABS, at);
  return (
    <Report
      title={t("visitors.title")}
      description={t(`visitors.${tab}Detail`)}
      tabs={TABS.map((x) => ({ value: x, label: t(`visitors.${x}`) }))}
      tab={tab}
      onTab={setTab}
    >
      {tab === "locations" && <LocationsTab summary={summary} />}
      {tab === "devices" && <DevicesTab />}
      {tab === "languages" && <LanguagesTab />}
    </Report>
  );
}

type Level = "countries" | "regions" | "cities";

function LocationsTab({ summary }: { summary?: Summary }) {
  const t = useT();
  const f = useFormat();
  const r = useReport();
  const [level, setLevel] = useState<Level>("countries");
  const [country, setCountry] = useState<string | null>(null);
  const countries = useBreakdown("country", { limit: 250 });
  const chosen = country ?? countries?.rows.find((x) => x.value)?.value ?? null;
  const within = { dimension: "country" as const, op: "is" as const, values: [chosen ?? NONE] };
  const places = useBreakdown(level === "regions" ? "region" : "city", { limit: 250, filters: [within], skip: level === "countries" });
  const b = level === "countries" ? countries : places;
  const precision = r.current?.location ?? "city";
  const geo = summary?.location;
  const rows = b?.rows ?? [];
  const total = rows.reduce((n, x) => n + x.visitors, 0);
  const name = (x: BreakdownRow) =>
    level === "countries"
      ? f.country(x.value)
      : level === "cities" && x.value
        ? x.group
          ? `${x.value}, ${x.group.split(", ")[0]}`
          : x.value
        : (x.value ?? t("value.unknownPlace"));
  const cols: Column<BreakdownRow>[] = [
    {
      id: "name",
      header: t(`visitors.level_${level}`),
      cell: (x) => (
        <span className="flex items-center gap-1.5">
          {level === "countries" && <Flag code={x.value} />}
          <span className={x.value ? "font-medium" : "text-fg-muted"}>{name(x)}</span>
        </span>
      ),
    },
    { id: "visitors", header: t("table.visitors"), align: "right", mono: true, sortValue: (x) => x.visitors, cell: (x) => f.num(x.visitors) },
    { id: "visits", header: t("table.visits"), align: "right", mono: true, sortValue: (x) => x.visits, cell: (x) => f.num(x.visits) },
    {
      id: "share",
      header: t("table.share"),
      align: "right",
      width: "30%",
      sortValue: (x) => x.visitors,
      cell: (x) => <ShareBar part={x.visitors} whole={total} />,
    },
  ];
  const levels: Level[] = precision === "country" ? ["countries"] : precision === "region" ? ["countries", "regions"] : ["countries", "regions", "cities"];
  return (
    <>
      {levels.length > 1 && (
        <div className="flex flex-wrap items-end gap-2">
          <SegmentedControl
            label={t("visitors.level")}
            value={level}
            onChange={setLevel}
            options={levels.map((l) => ({ value: l, label: t(`visitors.level_${l}`) }))}
          />
          {level !== "countries" && (
            <>
              <SelectField
                aria-label={t("visitors.level_countries")}
                className="w-44"
                value={chosen ?? NONE}
                onChange={(e) => setCountry(e.target.value)}
                options={(countries?.rows ?? []).filter((x) => x.value).map((x) => ({ value: x.value!, label: f.country(x.value) }))}
              />
              <Button variant="ghost" icon={<ArrowLeft aria-hidden />} onClick={() => setLevel("countries")}>
                {t("visitors.allCountries")}
              </Button>
            </>
          )}
        </div>
      )}
      <div className="grid gap-2.5 xl:grid-cols-[minmax(0,1fr)_300px]">
        <Panel
          flush
          title={level === "countries" ? t("visitors.level_countries") : t(`visitors.${level}Of`, { country: f.country(chosen) })}
          description={level === "countries" ? (levels.length > 1 ? t("visitors.pickCountry") : undefined) : t("visitors.visitorsCount", { count: total })}
          actions={
            <CsvButton
              name={level}
              rows={rows}
              columns={[
                [t("table.place"), (x) => (level === "countries" ? x.value : name(x))],
                [t("table.visitors"), (x) => x.visitors],
                [t("table.visits"), (x) => x.visits],
              ]}
            />
          }
        >
          {b === null ? (
            <Failed />
          ) : (
            <DataTable
              key={`${level}-${chosen}`}
              label={t("visitors.locations")}
              columns={cols}
              rows={rows}
              loading={b === undefined}
              getRowId={(x) => `${x.value}|${x.group}`}
              defaultSort={{ id: "visitors", direction: "desc" }}
              pageSize={50}
              onRowClick={
                level === "countries" && levels.length > 1
                  ? (x) => {
                      if (!x.value) return;
                      setCountry(x.value);
                      setLevel("regions");
                    }
                  : undefined
              }
              empty={<p className="m-0 px-3 py-2 text-sm text-fg-muted">{precision === "off" ? t("visitors.locationOff") : t("report.noneInPeriod")}</p>}
            />
          )}
        </Panel>
        <div className="flex min-w-0 flex-col gap-2.5 self-start">
          <Callout tone={geo && !geo.enabled ? "warning" : "info"} title={geo && !geo.enabled ? t("visitors.geoOff") : t("visitors.ipNeverKept")}>
            {geo && !geo.enabled ? t("visitors.geoOffDetail") : t(`visitors.ipNeverKeptDetail_${precision}`)}
          </Callout>
          {geo?.error && (
            <Callout tone="warning" title={t("visitors.geoError")}>
              {geo.error}
            </Callout>
          )}
        </div>
      </div>
      {geo?.enabled !== false && (
        <Note>
          {geo?.database ? `${geo.database}. ` : ""}
          {t("visitors.attributionBefore")}{" "}
          <a href="https://db-ip.com" target="_blank" rel="noreferrer">
            DB-IP
          </a>
          {t("visitors.attributionMiddle")}{" "}
          <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">
            CC BY 4.0
          </a>
          .
        </Note>
      )}
    </>
  );
}

function VersionTable({ kind }: { kind: "browser" | "os" }) {
  const t = useT();
  const f = useFormat();
  const b = useBreakdown(kind === "browser" ? "browserVersion" : "osVersion", { limit: 100 });
  const rows = b?.rows ?? [];
  const total = rows.reduce((n, x) => n + x.visitors, 0);
  const title = t(kind === "browser" ? "visitors.browsers" : "visitors.systems");
  const cols: Column<BreakdownRow>[] = [
    {
      id: "name",
      header: t(kind === "browser" ? "table.browser" : "table.system"),
      cell: (x) => <span className="font-medium">{x.group ?? t("value.none")}</span>,
    },
    { id: "version", header: t("table.version"), mono: true, cell: (x) => x.value ?? "–" },
    { id: "visitors", header: t("table.visitors"), align: "right", mono: true, sortValue: (x) => x.visitors, cell: (x) => f.num(x.visitors) },
    { id: "share", header: t("table.share"), align: "right", mono: true, sortValue: (x) => x.visitors, cell: (x) => f.share(x.visitors, total) },
  ];
  return (
    <Panel
      flush
      title={title}
      actions={
        <CsvButton
          name={kind === "browser" ? "browsers" : "systems"}
          rows={rows}
          columns={[
            [t("table.name"), (x) => x.group],
            [t("table.version"), (x) => x.value],
            [t("table.visitors"), (x) => x.visitors],
          ]}
        />
      }
    >
      {b === null ? (
        <Failed />
      ) : (
        <DataTable
          label={title}
          columns={cols}
          rows={rows}
          loading={b === undefined}
          getRowId={(x) => `${x.group}-${x.value}`}
          minWidth={420}
          defaultSort={{ id: "visitors", direction: "desc" }}
          pageSize={20}
          empty={<p className="m-0 px-3 py-2 text-sm text-fg-muted">{t("report.noneInPeriod")}</p>}
        />
      )}
    </Panel>
  );
}

function List({ rows, label, name }: { rows: BreakdownRow[] | undefined; label: string; name: (x: BreakdownRow) => string }) {
  const t = useT();
  if (rows === undefined) return <Loading />;
  if (!rows.length) return <p className="m-0 text-sm text-fg-muted">{t("report.noneInPeriod")}</p>;
  return <BarList label={label} items={rows.map((x) => ({ id: x.value ?? NONE, label: name(x), value: x.visitors }))} />;
}

function DevicesTab() {
  const t = useT();
  const f = useFormat();
  const devices = useBreakdown("device", { limit: 10 });
  const screens = useBreakdown("screen", { limit: 12 });
  return (
    <>
      <div className="grid gap-2.5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Panel title={t("visitors.kind")} description={t("overview.visitors")}>
          {devices === undefined ? (
            <Loading />
          ) : devices?.rows.length ? (
            <DonutChart
              label={t("visitors.kindLabel")}
              caption={t("overview.visitorsCaption")}
              slices={devices.rows.map((d) => ({ id: d.value ?? NONE, name: f.device(d.value), value: d.visitors }))}
            />
          ) : (
            <p className="m-0 text-sm text-fg-muted">{t("report.noneInPeriod")}</p>
          )}
        </Panel>
        <Panel title={t("visitors.screens")} description={t("visitors.screensDetail")}>
          <List rows={screens?.rows} label={t("visitors.screens")} name={(x) => (x.value ? x.value.replace("x", " × ") : t("value.none"))} />
        </Panel>
        <VersionTable kind="browser" />
        <VersionTable kind="os" />
      </div>
      <Note>{t("visitors.devicesNote")}</Note>
    </>
  );
}

function LanguagesTab() {
  const t = useT();
  const f = useFormat();
  const languages = useBreakdown("language", { limit: 30 });
  const zones = useBreakdown("timezone", { limit: 30 });
  return (
    <div className="grid gap-2.5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Panel
        title={t("visitors.languagesTitle")}
        description={t("visitors.languagesDetail")}
        actions={
          <CsvButton
            name="languages"
            rows={languages?.rows ?? []}
            columns={[
              [t("table.language"), (x) => x.value],
              [t("table.visitors"), (x) => x.visitors],
            ]}
          />
        }
      >
        <List rows={languages?.rows} label={t("visitors.languagesTitle")} name={(x) => (x.value ? f.language(x.value) : t("value.none"))} />
      </Panel>
      <Panel
        title={t("visitors.zones")}
        description={t("visitors.zonesDetail")}
        actions={
          <CsvButton
            name="time-zones"
            rows={zones?.rows ?? []}
            columns={[
              [t("table.timeZone"), (x) => x.value],
              [t("table.visitors"), (x) => x.visitors],
            ]}
          />
        }
      >
        <List rows={zones?.rows} label={t("visitors.zones")} name={(x) => x.value ?? t("value.none")} />
      </Panel>
    </div>
  );
}
