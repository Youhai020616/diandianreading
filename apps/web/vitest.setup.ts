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

installFakeEventSource();

beforeEach(() => {
  FakeEventSource.reset();
});

afterEach(() => {
  cleanup();
});
