import { expect, it } from "vitest";
import { createWheelPager, WHEEL_GESTURE_GAP_MS, type WheelInput, type WheelTurn } from "../src/reader/wheelPaging";

function pager() {
  const turns: WheelTurn[] = [];
  const handle = createWheelPager(turn => turns.push(turn));
  const wheel = (input: Partial<WheelInput> & { time: number }) =>
    handle({ deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, ...input });
  return { turns, wheel };
}

it("turns one page for a trackpad swipe and ignores its inertial tail", () => {
  const { turns, wheel } = pager();
  let time = 0;
  for (let i = 0; i < 40; i++) wheel({ deltaY: 6, time: (time += 16) });
  expect(turns).toEqual(["next"]);
  time += WHEEL_GESTURE_GAP_MS + 1;
  for (let i = 0; i < 10; i++) wheel({ deltaY: -8, time: (time += 16) });
  expect(turns).toEqual(["next", "prev"]);
});

it("ignores a light brush, turns once per separate wheel notch, and resolves the dominant axis", () => {
  const { turns, wheel } = pager();
  wheel({ deltaY: 4, time: 0 });
  wheel({ deltaY: 4, time: 10 });
  expect(turns).toEqual([]);
  wheel({ deltaY: 100, time: 500 });
  wheel({ deltaY: 100, time: 1000 });
  wheel({ deltaMode: 1, deltaY: 3, time: 1500 });
  expect(turns).toEqual(["next", "next", "next"]);
  wheel({ deltaX: 40, deltaY: 6, time: 2000 });
  wheel({ deltaX: -40, deltaY: -6, time: 2500 });
  expect(turns.slice(3)).toEqual(["right", "left"]);
});

it("never treats pinch-to-zoom as paging and does not let it leak into the next gesture", () => {
  const { turns, wheel } = pager();
  for (let i = 0; i < 10; i++) wheel({ deltaY: 20, ctrlKey: true, time: i * 16 });
  wheel({ deltaY: 20, time: 170 });
  expect(turns).toEqual([]);
  wheel({ deltaY: 20, time: 186 });
  expect(turns).toEqual(["next"]);
});
