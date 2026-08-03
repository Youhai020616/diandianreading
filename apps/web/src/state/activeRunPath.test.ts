import { describe, expect, it } from "vitest";
import { activeRunPathFromError } from "./controller";
import { ApiError } from "../lib/errors";

describe("activeRunPathFromError", () => {
  it("extracts the run id from error.details.active_run_url", () => {
    const error = new ApiError(409, "CONVERSATION_BUSY", {
      error: {
        code: "CONVERSATION_BUSY",
        details: { active_run_url: "/api/chat-runs/run-42" },
      },
    });
    expect(activeRunPathFromError(error)).toBe("run-42");
  });

  it("supports the top-level and data-level fallbacks", () => {
    expect(
      activeRunPathFromError(
        new ApiError(409, "CONVERSATION_BUSY", {
          error: { code: "CONVERSATION_BUSY", active_run_url: "/api/chat-runs/run-a" },
        }),
      ),
    ).toBe("run-a");
    expect(
      activeRunPathFromError(
        new ApiError(409, "CONVERSATION_BUSY", {
          data: { active_run_url: "/api/chat-runs/run-b" },
        }),
      ),
    ).toBe("run-b");
  });

  it("rejects cross-origin or non chat-run URLs", () => {
    expect(
      activeRunPathFromError(
        new ApiError(409, "CONVERSATION_BUSY", {
          error: { details: { active_run_url: "https://evil.example/api/chat-runs/run-x" } },
        }),
      ),
    ).toBeNull();
    expect(
      activeRunPathFromError(
        new ApiError(409, "CONVERSATION_BUSY", {
          error: { details: { active_run_url: "/api/jobs/run-x" } },
        }),
      ),
    ).toBeNull();
  });

  it("returns null for non-ApiError values", () => {
    expect(activeRunPathFromError(new Error("boom"))).toBeNull();
  });
});
