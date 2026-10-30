// Prometheus text exposition, written by hand: a few lines, no client library needed.
const requests = new Map<string, number>();

export function countRequest(method: string, route: string, status: number) {
  const key = `method="${method}",route="${route}",status="${status}"`;
  requests.set(key, (requests.get(key) ?? 0) + 1);
}

export interface Gauges {
  /** Sites in the file. */
  sites: number;
  /** Events kept, by site. */
  events: Record<string, number>;
  /** 1 when the sites file on disk could not be applied and an older version is in use. */
  fileError: boolean;
}

export function renderMetrics(version: string, g: Gauges): string {
  const lines = [
    "# HELP openasy_build_info Build information.",
    "# TYPE openasy_build_info gauge",
    `openasy_build_info{product="analytics",version="${version}"} 1`,
    "# HELP openasy_http_requests_total HTTP requests handled.",
    "# TYPE openasy_http_requests_total counter",
    ...[...requests].map(([labels, n]) => `openasy_http_requests_total{${labels}} ${n}`),
    "# HELP openasy_analytics_sites Sites in the sites file.",
    "# TYPE openasy_analytics_sites gauge",
    `openasy_analytics_sites ${g.sites}`,
    "# HELP openasy_analytics_events Events kept, by site.",
    "# TYPE openasy_analytics_events gauge",
    ...Object.entries(g.events).map(([site, n]) => `openasy_analytics_events{site="${site}"} ${n}`),
    "# HELP openasy_analytics_config_error 1 when the sites file could not be applied and its last good version is in use.",
    "# TYPE openasy_analytics_config_error gauge",
    `openasy_analytics_config_error ${g.fileError ? 1 : 0}`,
    "# HELP process_uptime_seconds Seconds since the process started.",
    "# TYPE process_uptime_seconds gauge",
    `process_uptime_seconds ${process.uptime().toFixed(0)}`,
  ];
  return lines.join("\n") + "\n";
}
