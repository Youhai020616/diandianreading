/**
 * Wheel and trackpad paging for the paginated reader.
 *
 * A trackpad or touch mouse reports one swipe as dozens of small wheel events
 * followed by an inertial tail. Turning a page per event would skip several
 * pages, so travel is summed until it reads as intent, one page is turned, and
 * the rest of that gesture is ignored until the wheel has been quiet briefly.
 */
export type WheelTurn = "next" | "prev" | "left" | "right";

export interface WheelInput {
  deltaX: number;
  deltaY: number;
  /** WheelEvent.deltaMode: 0 pixels, 1 lines, 2 pages. */
  deltaMode: number;
  /** Pinch-to-zoom arrives as a wheel event with ctrlKey. */
  ctrlKey: boolean;
  /** Milliseconds from a single clock shared by every event source. */
  time: number;
}

export const WHEEL_TURN_TRAVEL = 30;
export const WHEEL_GESTURE_GAP_MS = 220;
const PX_PER_LINE = 40;
const PX_PER_PAGE = 800;

export function createWheelPager(onTurn: (turn: WheelTurn) => void) {
  let travelX = 0;
  let travelY = 0;
  let lastEventAt = Number.NEGATIVE_INFINITY;
  let gestureTurned = false;

  return function handleWheel(input: WheelInput): void {
    if (input.ctrlKey) {
      travelX = travelY = 0;
      gestureTurned = false;
      lastEventAt = Number.NEGATIVE_INFINITY;
      return;
    }
    if (input.time - lastEventAt > WHEEL_GESTURE_GAP_MS) {
      travelX = travelY = 0;
      gestureTurned = false;
    }
    lastEventAt = input.time;
    if (gestureTurned) return;

    const scale = input.deltaMode === 1 ? PX_PER_LINE : input.deltaMode === 2 ? PX_PER_PAGE : 1;
    travelX += input.deltaX * scale;
    travelY += input.deltaY * scale;
    if (Math.abs(travelX) < WHEEL_TURN_TRAVEL && Math.abs(travelY) < WHEEL_TURN_TRAVEL) return;

    gestureTurned = true;
    const vertical = Math.abs(travelY) >= Math.abs(travelX);
    const turn: WheelTurn = vertical ? (travelY > 0 ? "next" : "prev") : (travelX > 0 ? "right" : "left");
    travelX = travelY = 0;
    onTurn(turn);
  };
}
