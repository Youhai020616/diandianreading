import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TAB_REVEAL_AFTER_COMMIT_MS, TAB_REVEAL_SAFETY_MS, TabRevealGate } from "../electron/browser/tabReveal";

let reveals: number;
let gate: TabRevealGate;

beforeEach(() => {
  vi.useFakeTimers();
  reveals = 0;
  gate = new TabRevealGate(true, () => reveals++);
});
afterEach(() => {
  gate.dispose();
  vi.useRealTimers();
});

it("keeps the old page hidden until the new site commits, then reveals shortly after", () => {
  gate.defer();
  expect(gate.ready).toBe(false);
  // Late signals from the page being replaced.
  gate.domReady();
  gate.failed(-3, true);
  gate.stopped(true);
  expect(gate.ready).toBe(false);
  gate.committed();
  vi.advanceTimersByTime(TAB_REVEAL_AFTER_COMMIT_MS - 1);
  expect(gate.ready).toBe(false);
  vi.advanceTimersByTime(1);
  expect(gate.ready).toBe(true);
  expect(reveals).toBe(1);
});

it("reveals as soon as the committed page is ready", () => {
  gate.defer();
  gate.committed();
  gate.domReady();
  expect(reveals).toBe(1);
  vi.advanceTimersByTime(TAB_REVEAL_SAFETY_MS);
  expect(reveals).toBe(1);
});

it("shows the previous page right away when the navigation is stopped or never commits", () => {
  gate.defer();
  // The user pressed stop, or the link turned into a download: ERR_ABORTED, then loading ends.
  gate.failed(-3, true);
  gate.stopped(false);
  expect(gate.ready).toBe(true);
  expect(reveals).toBe(1);
});

it("reveals a failed navigation's error page, ignores subframe failures, and has a safety net", () => {
  gate.defer();
  gate.failed(-105, false);
  expect(gate.ready).toBe(false);
  gate.failed(-105, true);
  expect(gate.ready).toBe(true);

  gate.defer();
  vi.advanceTimersByTime(TAB_REVEAL_SAFETY_MS);
  expect(gate.ready).toBe(true);
  expect(reveals).toBe(2);
});
