/**
 * Once-a-day bookkeeping for the pet's "旧划线重逢" nudge. The pet window asks shortly after it loads;
 * without this record it nudged on every app start and every pet-window reload, popping up over
 * whatever the user was doing.
 */
export interface RecallSettings {
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
}

const MUTED_KEY = "pet.recallMutedDate";
const SHOWN_KEY = "pet.recallShownDate";

/** Calendar day in the user's own time zone, e.g. "2026-11-27". */
export function localDay(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** Allow today's automatic nudge at most once, and never on a day the user muted it. */
export function claimDailyRecall(db: RecallSettings, today: string = localDay()): boolean {
  if (db.getSetting(MUTED_KEY) === today || db.getSetting(SHOWN_KEY) === today) return false;
  db.setSetting(SHOWN_KEY, today);
  return true;
}

/** "今天不再提醒": no more automatic nudges until tomorrow. */
export function muteRecallToday(db: RecallSettings, today: string = localDay()): void {
  db.setSetting(MUTED_KEY, today);
}
