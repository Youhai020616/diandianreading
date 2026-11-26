import { describe, expect, it } from "vitest";
import { claimDailyRecall, localDay, muteRecallToday, type RecallSettings } from "../electron/pet/recallNudge";

function memorySettings(): RecallSettings {
  const values = new Map<string, string>();
  return { getSetting: (key) => values.get(key) ?? null, setSetting: (key, value) => void values.set(key, value) };
}

describe("pet recall nudge", () => {
  it("nudges at most once a day, however often the pet window loads", () => {
    const db = memorySettings();
    expect(claimDailyRecall(db, "2026-11-27")).toBe(true);
    expect(claimDailyRecall(db, "2026-11-27")).toBe(false);
    expect(claimDailyRecall(db, "2026-11-27")).toBe(false);
    expect(claimDailyRecall(db, "2026-11-28")).toBe(true);
  });

  it("stays quiet on a day the user muted it", () => {
    const db = memorySettings();
    muteRecallToday(db, "2026-11-27");
    expect(claimDailyRecall(db, "2026-11-27")).toBe(false);
    expect(claimDailyRecall(db, "2026-11-28")).toBe(true);
  });

  it("uses the local calendar day", () => {
    expect(localDay(new Date(2026, 10, 27, 0, 30))).toBe("2026-11-27");
    expect(localDay(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });
});
