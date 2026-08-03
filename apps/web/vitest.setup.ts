import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { FakeEventSource, installFakeEventSource } from "./src/test/fakeEventSource";

// jsdom does not implement matchMedia; the app only needs matches/listeners.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string): MediaQueryList => {
    const mediaQueryList = {
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    };
    return mediaQueryList as unknown as MediaQueryList;
  };
}

// jsdom does not implement scrollIntoView or canvas contexts; the reader
// guards on their presence, and quiet stubs keep virtual-console noise out
// of test output.
if (typeof window !== "undefined") {
  window.HTMLElement.prototype.scrollIntoView = (): void => undefined;
  window.HTMLCanvasElement.prototype.getContext = ((): null => null) as never;
}

installFakeEventSource();

beforeEach(() => {
  FakeEventSource.reset();
});

afterEach(() => {
  cleanup();
});
