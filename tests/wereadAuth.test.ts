import { describe, expect, it } from "vitest";
import { isWeReadAuthRequiredError } from "../src/lib/wereadAuth";

describe("WeRead upload auth error detection", () => {
  it("identifies unbound or expired WeRead upload sessions without matching network errors", () => {
    expect(isWeReadAuthRequiredError(new Error("请在「连接与偏好」中连接微信读书账号，再回到书库重试。"))).toBe(true);
    expect(isWeReadAuthRequiredError(new Error("WeRead session expired"))).toBe(true);
    expect(isWeReadAuthRequiredError("Error: not logged in to WeRead")).toBe(true);
    expect(isWeReadAuthRequiredError(new Error("连接微信读书失败，请检查网络后重试。"))).toBe(false);
    expect(isWeReadAuthRequiredError(new Error("文件超过微信读书允许的大小。"))).toBe(false);
  });
});
