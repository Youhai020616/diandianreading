import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  filterCookiesByDomains,
  isRecommendedReadingDomain,
  parseCookieInput,
  parseHalfBlockQrToMatrix,
  serializeToNetscapeCookies,
} from "../electron/browser/cookieCodec";
import {
  chromiumMicrosToUnixSeconds,
  classifyCookieDomain,
  decryptChromiumMacCookieValue,
  deriveChromiumMacAesKey,
} from "../electron/browser/localBrowserImporter";
import { normalizeZlibDomainUrl } from "../electron/router/zlibCliService";

describe("Cookie codec & minimum-privilege domain filtering", () => {
  it("parses Netscape cookies.txt (including #HttpOnly_) and classifies reading domains", () => {
    const raw = [
      "# Netscape HTTP Cookie File",
      "#HttpOnly_.weread.qq.com\tTRUE\t/\tTRUE\t1893456000\twr_skey\tsecret123",
      ".z-lib.by\tTRUE\t/\tTRUE\t1893456000\tremixed_userid\t40119657",
      "bank.example.com\tFALSE\t/\tTRUE\t1893456000\tsession\tdo_not_import",
    ].join("\n");

    const bundle = parseCookieInput(raw);
    expect(bundle.format).toBe("netscape");
    expect(bundle.cookies).toHaveLength(3);
    expect(bundle.cookies[0]?.httpOnly).toBe(true);

    const wereadDom = bundle.domains.find((d) => d.domain === "weread.qq.com");
    const bankDom = bundle.domains.find((d) => d.domain === "bank.example.com");
    expect(wereadDom?.recommended).toBe(true);
    expect(bankDom?.recommended).toBe(false);

    // Filter strictly to selected domains -> bank cookie excluded
    const filtered = filterCookiesByDomains(bundle.cookies, ["weread.qq.com"]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.name).toBe("wr_skey");
  });

  it("parses Cookie-Editor JSON format and round-trips to Netscape format", () => {
    const json = JSON.stringify([
      {
        name: "remix_userkey",
        value: "abc987",
        domain: ".z-library.qa",
        path: "/",
        secure: true,
        httpOnly: true,
        expirationDate: 1893456000,
      },
      {
        name: "remix_userid",
        value: "12345",
        domain: "z-library.qa",
        path: "/",
        secure: true,
        httpOnly: false,
      },
    ]);

    const parsed = parseCookieInput(json);
    expect(parsed.format).toBe("json");
    expect(parsed.cookies).toHaveLength(2);
    expect(isRecommendedReadingDomain("z-library.qa")).toBe(true);

    const netscape = serializeToNetscapeCookies(parsed.cookies);
    expect(netscape).toContain("#HttpOnly_.z-library.qa\tTRUE\t/\tTRUE\t1893456000\tremix_userkey\tabc987");
    expect(netscape).toContain("z-library.qa\tFALSE\t/\tTRUE\t0\tremix_userid\t12345");
  });

  it("converts Unicode half-block QR output into a crisp boolean matrix", () => {
    const fakeQr = [
      "    █▀▀▀▀▀█  ▄▀  █▀▀▀▀▀█    ",
      "    █ ███ █ ▀▄ ▀ █ ███ █    ",
      "    █ ▀▀▀ █  ▀▄▄ █ ▀▀▀ █    ",
      "    ▀▀▀▀▀▀▀ █ ▀▄ ▀▀▀▀▀▀▀    ",
      "    ▀▀█ ▀▀▀▀█▄ ▄ ▀▀█ ▀▀▀    ",
      "    ▄ ██▄ ▀▀▄▄█▀ ▄ ██▄ ▀    ",
      "    █▄ █  ▀   ██ █▄ █  ▀    ",
      "    ▀▀▀▀▀▀▀ ▀▀▀  ▀▀▀▀▀▀▀    ",
    ].join("\n");

    const matrix = parseHalfBlockQrToMatrix(fakeQr);
    expect(matrix).not.toBeNull();
    expect(matrix!.rows.length).toBeGreaterThanOrEqual(15);
    expect(matrix!.rows[0]?.[0]).toBe(true); // Top-left finder corner
  });

  it("normalizes and validates Z-Library mirror domain URLs", () => {
    expect(normalizeZlibDomainUrl("z-lib.by")).toBe("https://z-lib.by");
    expect(normalizeZlibDomainUrl("https://z-library.qa/login")).toBe("https://z-library.qa");
    expect(() => normalizeZlibDomainUrl("javascript:alert(1)")).toThrow();
  });

  it("classifies reading/writing cookie domains into clean site groups", () => {
    expect(classifyCookieDomain(".weread.qq.com")).toBe("weread");
    expect(classifyCookieDomain("book.douban.com")).toBe("douban");
    expect(classifyCookieDomain(".xiaohongshu.com")).toBe("xiaohongshu");
    expect(classifyCookieDomain("mp.weixin.qq.com")).toBe("wechat_mp");
    expect(classifyCookieDomain(".z-library.sk")).toBe("zlib");
    expect(classifyCookieDomain("singlelogin.re")).toBe("zlib");
    expect(classifyCookieDomain("github.com")).toBe("other");
  });

  it("decrypts Chromium macOS v10 cookies for both legacy (<v24) and Chrome 130+ (v24 SHA-256 host prefix)", () => {
    const key = deriveChromiumMacAesKey("mock-keychain-secret");
    const iv = Buffer.alloc(16, 0x20);
    const encryptV10 = (payload: Buffer) => {
      const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
      return Buffer.concat([Buffer.from("v10", "ascii"), cipher.update(payload), cipher.final()]);
    };

    // 1. Legacy Chromium (<v24): raw UTF-8 value
    const legacyEnc = encryptV10(Buffer.from("wr_skey_legacy_987654", "utf8"));
    expect(decryptChromiumMacCookieValue(legacyEnc, key, ".weread.qq.com", 21)).toBe("wr_skey_legacy_987654");

    // 2. Chrome 130+ (v24+): SHA-256(host_key) || UTF-8 value
    const hostKey = ".weread.qq.com";
    const hostHash = crypto.createHash("sha256").update(hostKey, "utf8").digest();
    const v24Enc = encryptV10(Buffer.concat([hostHash, Buffer.from("wr_skey_v24_abcdef", "utf8")]));
    expect(decryptChromiumMacCookieValue(v24Enc, key, hostKey, 24)).toBe("wr_skey_v24_abcdef");
    // Also works when leading dot differs
    expect(decryptChromiumMacCookieValue(v24Enc, key, "weread.qq.com", 24)).toBe("wr_skey_v24_abcdef");

    // 3. Invalid prefix or wrong key returns null cleanly
    expect(decryptChromiumMacCookieValue(Buffer.from("v11xxxx"), key, hostKey, 24)).toBeNull();
    const wrongKey = deriveChromiumMacAesKey("wrong-secret");
    expect(decryptChromiumMacCookieValue(v24Enc, wrongKey, hostKey, 24)).toBeNull();
  });

  it("converts 64-bit Chromium expires_utc BigInt timestamps (> Number.MAX_SAFE_INTEGER) safely", () => {
    // 13440855789739540n exceeds Number.MAX_SAFE_INTEGER (9007199254740991)
    expect(chromiumMicrosToUnixSeconds(13440855789739540n)).toBe(1796382189);
    expect(chromiumMicrosToUnixSeconds(0n)).toBeUndefined();
    expect(chromiumMicrosToUnixSeconds(null)).toBeUndefined();
    // Absurd far-future values clamp cleanly to 9999-12-31
    expect(chromiumMicrosToUnixSeconds(999_999_999_999_000_000n)).toBe(253_402_300_799);
  });
});
