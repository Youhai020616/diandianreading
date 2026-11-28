export type DesktopOS = "macOS" | "Windows" | "Linux";
export type InstallerCPU = "arm64" | "x64";
type CPU = InstallerCPU | "unknown" | "unsupported";

interface DeviceHints {
  platform: string;
  mobile: boolean;
  getHighEntropyValues?(keys: string[]): Promise<{ architecture?: string; bitness?: string }>;
}

type BrowserDevice = Pick<Navigator, "platform" | "userAgent" | "maxTouchPoints"> & { userAgentData?: DeviceHints };
export type InstallerDevice = { os: DesktopOS; cpu: CPU };

function desktopOS(browser: BrowserDevice): DesktopOS | null {
  const hints = browser.userAgentData;
  const ua = browser.userAgent;
  const platform = hints?.platform || browser.platform || ua;
  // iPadOS can advertise itself as a desktop Mac.
  if (hints?.mobile || /Android|iOS|iPhone|iPad|iPod|CrOS|Chrome OS|Windows Phone/i.test(platform + " " + ua)) return null;
  if (/mac/i.test(platform)) return browser.maxTouchPoints > 1 ? null : "macOS";
  if (/windows|^win/i.test(platform)) return "Windows";
  if (/linux/i.test(platform)) return "Linux";
  return null;
}

function hintedCPU(architecture = "", bitness = ""): CPU {
  if (!architecture) return "unknown";
  if (bitness === "32") return "unsupported";
  if (/^(arm64|aarch64)$/i.test(architecture)) return "arm64";
  if (/^(x64|amd64|x86_64)$/i.test(architecture)) return "x64";
  if (bitness !== "64") return "unknown";
  if (architecture === "arm") return "arm64";
  if (architecture === "x86") return "x64";
  return "unsupported";
}

export async function detectInstallerDevice(browser: BrowserDevice): Promise<InstallerDevice | null> {
  const os = desktopOS(browser);
  if (!os) return null;
  const hints = browser.userAgentData;
  if (hints?.getHighEntropyValues) {
    try {
      const { architecture, bitness } = await hints.getHighEntropyValues(["architecture", "bitness"]);
      const cpu = hintedCPU(architecture, bitness);
      if (cpu !== "unknown") return { os, cpu };
    } catch {
      // A browser policy can withhold architecture hints.
    }
  }

  // Chromium's reduced desktop UA can say x64 on ARM. Also, "Intel Mac OS X"
  // and "MacIntel" are reported on both Intel and Apple Silicon by several browsers.
  const legacy = browser.platform + " " + browser.userAgent;
  if (/\b(?:aarch64|arm64)\b/i.test(legacy)) return { os, cpu: "arm64" };
  if (os !== "macOS" && !hints && !/Chrome\/|Chromium\//i.test(browser.userAgent)) {
    if (/\b(?:x86_64|amd64|x64|wow64)\b/i.test(legacy)) return { os, cpu: "x64" };
    if (/\b(?:i[3-6]86|armv[5-8]l)\b/i.test(legacy)) return { os, cpu: "unsupported" };
  }
  return { os, cpu: "unknown" };
}
