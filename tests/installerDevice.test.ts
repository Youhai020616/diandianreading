import { describe, expect, it } from "vitest";
import { detectInstallerDevice } from "../site/src/installerDevice";

const mac = { platform: "MacIntel", maxTouchPoints: 0, userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" };

describe("desktop installer detection", () => {
  it.each([
    ["macOS", "arm", "64", "arm64"],
    ["macOS", "x86", "64", "x64"],
    ["Windows", "x86", "64", "x64"],
    ["Linux", "x86", "64", "x64"],
    ["Linux", "arm", "64", "arm64"],
    ["Windows", "x86", "32", "unsupported"],
  ])("reads %s %s %s client hints", async (platform, architecture, bitness, cpu) => {
    const device = await detectInstallerDevice({
      ...mac, userAgentData: { platform, mobile: false, getHighEntropyValues: async () => ({ architecture, bitness }) },
    });
    expect(device).toEqual({ os: platform, cpu });
  });

  it("leaves the chip unknown when a Mac reports only its compatibility UA", async () => {
    expect(await detectInstallerDevice(mac)).toEqual({ os: "macOS", cpu: "unknown" });
  });

  it("does not treat a desktop-mode iPad as a Mac", async () => {
    expect(await detectInstallerDevice({ ...mac, maxTouchPoints: 5 })).toBeNull();
  });

  it("ignores reduced Chromium CPU tokens if high-entropy hints are blocked", async () => {
    const device = await detectInstallerDevice({
      platform: "Linux x86_64", maxTouchPoints: 0, userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0.0.0",
      userAgentData: { platform: "Linux", mobile: false, getHighEntropyValues: async () => { throw new Error("Denied"); } },
    });
    expect(device).toEqual({ os: "Linux", cpu: "unknown" });
  });
});
