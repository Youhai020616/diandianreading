import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppController } from "./controller";
import { FakeEventSource } from "../test/fakeEventSource";
import { installFetchMock, jsonResponse, type RecordedRequest } from "../test/mockFetch";

function jobPayload(status: string): unknown {
  return {
    data: {
      job: {
        id: "job-1",
        job_type: "import_book",
        book_title: "Book One",
        status,
        current_step: status === "running" ? "uploading" : null,
        attempt: 1,
        progress_current: null,
        progress_total: null,
        retriable: false,
        blocked_reason: null,
        created_at: "2026-08-01T00:00:00+00:00",
        updated_at: "2026-08-01T00:00:01+00:00",
      },
    },
  };
}

describe("job SSE tracking with Last-Event-ID resume semantics", () => {
  let controller: AppController;
  let requests: RecordedRequest[];
  let jobStatus: string;

  beforeEach(() => {
    vi.useFakeTimers();
    jobStatus = "running";
    controller = new AppController();
    ({ requests } = installFetchMock((request) => {
      if (request.url.startsWith("/api/jobs/job-1")) {
        return jsonResponse(200, jobPayload(jobStatus));
      }
      return jsonResponse(404, { error: { code: "NOT_FOUND" } });
    }));
  });

  afterEach(() => {
    controller.dispose();
    vi.useRealTimers();
  });

  function snapshotRequests(): number {
    return requests.filter((request) => request.url === "/api/jobs/job-1").length;
  }

  it("opens one credentialed stream per job and refreshes snapshots on events", async () => {
    await controller.selectJob("job-1", false);

    expect(FakeEventSource.instances).toHaveLength(1);
    const stream = FakeEventSource.instances[0]!;
    expect(stream.url).toBe("/api/jobs/job-1/events");
    expect(stream.withCredentials).toBe(true);
    expect(snapshotRequests()).toBe(1);

    stream.emit("job.updated", { job_id: "job-1", to_status: "running" });
    await vi.advanceTimersByTimeAsync(180);
    expect(snapshotRequests()).toBe(2);

    // Burst of events collapses into a single debounced snapshot refresh.
    stream.emit("job.updated", {});
    stream.emit("job.updated", {});
    await vi.advanceTimersByTimeAsync(180);
    expect(snapshotRequests()).toBe(3);
  });

  it("keeps the same EventSource across transport errors so the browser can resume with Last-Event-ID", async () => {
    await controller.selectJob("job-1", false);
    const stream = FakeEventSource.instances[0]!;

    stream.emit("error");

    // The stream object must survive the error: closing or recreating it would
    // discard the browser's automatic Last-Event-ID reconnect.
    expect(stream.closed).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(controller.store.getState().jobsStatus.state).toBe("error");
    expect(controller.store.getState().jobsStatus.text).toContain("Live updates disconnected");

    // Polling fallback keeps refreshing the persisted snapshot meanwhile.
    await vi.advanceTimersByTimeAsync(8000);
    expect(snapshotRequests()).toBeGreaterThanOrEqual(2);
  });

  it("does not recreate a stream for the same job on repeated selection", async () => {
    await controller.selectJob("job-1", false);
    await controller.selectJob("job-1", false);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]!.closed).toBe(false);
  });

  it("closes the stream and stops polling once the job is terminal", async () => {
    await controller.selectJob("job-1", false);
    const stream = FakeEventSource.instances[0]!;

    jobStatus = "completed";
    stream.emit("job.completed", { job_id: "job-1", to_status: "completed" });
    await vi.advanceTimersByTimeAsync(180);

    expect(stream.closed).toBe(true);
    const requestsAfterTerminal = snapshotRequests();
    await vi.advanceTimersByTimeAsync(30000);
    expect(snapshotRequests()).toBe(requestsAfterTerminal);
  });
});
