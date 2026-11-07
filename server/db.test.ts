import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lastDays } from "./analytics.ts";
import { openDb } from "./db.ts";

describe("openDb", () => {
  it("uses WAL and migrates once", () => {
    const path = join(mkdtempSync(join(tmpdir(), "analytics-")), "nested", "analytics.db");
    const first = openDb(path);
    expect(first.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    first.close();
    const second = openDb(path);
    expect(second.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({ n: 2 });
    second.close();
  });
});

describe("lastDays", () => {
  it("names the last days in UTC, today last", () => {
    expect(lastDays(3, Date.parse("2026-11-01T23:59:59.000Z"))).toEqual(["2026-10-30", "2026-10-31", "2026-11-01"]);
  });
});
