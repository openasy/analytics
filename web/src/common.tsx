// What the pages share: data loading with the session, and formatting.
import { useAuth } from "@openasy/auth/react";
import { useCallback, type ReactNode } from "react";
import { api, MfaSetupRequired, Unauthorized } from "./api.ts";
import { viewerLocale } from "./i18n.ts";

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
export const shortDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(viewerLocale(), { month: "short", day: "numeric", timeZone: "UTC" });
export const time = (iso: string) => new Date(iso).toLocaleString(viewerLocale(), { dateStyle: "medium", timeStyle: "short" });
