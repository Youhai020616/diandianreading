import { firstArray, isRecord, unwrapData } from "./records";
import { displayText, internalIdentifier, knownCode } from "./text";
import type {
  BookSnapshot,
  ChatMessageView,
  ChatPhaseValue,
  ChatReferenceView,
  ChatRunErrorView,
  ChatRunStatusValue,
  ChatRunView,
  ConversationSnapshot,
  JobBlockedReason,
  JobSnapshot,
  JobStatusValue,
  JobStepValue,
} from "./types";

export const JOB_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "blocked",
  "completed",
  "failed",
  "cancelled",
]);
export const JOB_STEPS: ReadonlySet<string> = new Set([
  "acquiring",
  "storing",
  "preparing",
  "creating_workspace",
  "uploading",
  "processing",
  "verifying",
]);
export const CHAT_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export const CHAT_PHASES: ReadonlySet<string> = new Set([
  "resolving_scope",
  "waiting_for_provider",
  "reconciling",
  "finalizing",
]);
export const TERMINAL_JOB_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
]);
export const TERMINAL_CHAT_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
]);
export const READY_BOOK_STATUSES: ReadonlySet<string> = new Set([
  "ready",
  "reading",
  "completed",
]);
export const RIGHTS_BASES: ReadonlySet<string> = new Set([
  "owned_copy",
  "public_domain",
  "open_license",
]);
export const LICENSE_IDENTIFIER_BASES: ReadonlySet<string> = new Set([
  "public_domain",
  "open_license",
]);

export function normalizeJob(raw: unknown): JobSnapshot | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = internalIdentifier(raw["id"] || raw["job_id"]);
  if (!id) {
    return null;
  }
  const rawStatus = typeof raw["status"] === "string" ? raw["status"].toLowerCase() : "unknown";
  const status = (JOB_STATUSES.has(rawStatus) ? rawStatus : "unknown") as JobStatusValue;
  const rawStep =
    typeof raw["current_step"] === "string" ? raw["current_step"].toLowerCase() : null;
  const currentStep = (rawStep && JOB_STEPS.has(rawStep) ? rawStep : null) as JobStepValue | null;
  const blockedReason = (
    raw["blocked_reason"] === "AUTH_REQUIRED" || raw["blocked_reason"] === "REMOTE_OUTCOME_AMBIGUOUS"
      ? raw["blocked_reason"]
      : null
  ) as JobBlockedReason | null;
  const rawError = raw["error"];
  const errorCode = knownCode(
    raw["last_error_code"] || (isRecord(rawError) && rawError["code"]),
  );
  const progressCurrent =
    Number.isInteger(raw["progress_current"]) && (raw["progress_current"] as number) >= 0
      ? (raw["progress_current"] as number)
      : null;
  const progressTotal =
    Number.isInteger(raw["progress_total"]) && (raw["progress_total"] as number) > 0
      ? (raw["progress_total"] as number)
      : null;
  const attempt =
    Number.isInteger(raw["attempt"]) && (raw["attempt"] as number) > 0
      ? (raw["attempt"] as number)
      : null;

  return {
    id,
    title: displayText(raw["book_title"] || raw["title"], "", 180),
    jobType: typeof raw["job_type"] === "string" ? raw["job_type"] : "",
    status,
    currentStep,
    blockedReason,
    errorCode,
    retriable:
      raw["retriable"] === true || (isRecord(rawError) && rawError["retriable"] === true),
    cancelRequestedAt:
      typeof raw["cancel_requested_at"] === "string" ? raw["cancel_requested_at"] : null,
    createdAt: typeof raw["created_at"] === "string" ? raw["created_at"] : null,
    updatedAt: typeof raw["updated_at"] === "string" ? raw["updated_at"] : null,
    completedAt: typeof raw["completed_at"] === "string" ? raw["completed_at"] : null,
    progressCurrent: progressTotal !== null ? progressCurrent : null,
    progressTotal: progressCurrent !== null ? progressTotal : null,
    attempt,
  };
}

export function extractJobs(payload: unknown): JobSnapshot[] {
  const data = unwrapData(payload);
  return firstArray(data, ["jobs", "items", "results"])
    .map(normalizeJob)
    .filter((job): job is JobSnapshot => job !== null);
}

export function importResponseJob(payload: unknown): JobSnapshot | null {
  const data = unwrapData(payload);
  if (!isRecord(data)) {
    return null;
  }
  if (isRecord(data["job"])) {
    return normalizeJob(data["job"]);
  }
  const direct = normalizeJob(data);
  if (direct) {
    return direct;
  }
  const jobId = internalIdentifier(data["job_id"]);
  if (!jobId) {
    return null;
  }
  return normalizeJob({ id: jobId, status: "queued", job_type: "import_book" });
}

export function normalizeBook(raw: unknown): BookSnapshot | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = internalIdentifier(raw["id"] || raw["book_id"]);
  const title = displayText(raw["title"], "Untitled book / 未命名书籍", 200);
  if (!id) {
    return null;
  }
  const rawStatus = typeof raw["status"] === "string" ? raw["status"].toLowerCase() : "unknown";
  return {
    id,
    title,
    author: displayText(raw["author"], "", 160),
    status: rawStatus,
  };
}

export function extractBooks(payload: unknown): BookSnapshot[] {
  const data = unwrapData(payload);
  return firstArray(data, ["books", "items", "results"])
    .map(normalizeBook)
    .filter((book): book is BookSnapshot => book !== null);
}

export function normalizeConversation(
  payload: unknown,
  fallbackBookId: string | null,
): ConversationSnapshot | null {
  const data = unwrapData(payload);
  const raw = isRecord(data) && isRecord(data["conversation"]) ? data["conversation"] : data;
  if (!isRecord(raw)) {
    return null;
  }
  const id = internalIdentifier(raw["id"] || raw["conversation_id"]);
  const bookId = internalIdentifier(raw["book_id"]) || fallbackBookId;
  if (!id || !bookId) {
    return null;
  }
  return {
    id,
    bookId,
    title: displayText(raw["title"], "Book conversation / 书籍对话", 180),
    status: typeof raw["status"] === "string" ? raw["status"].toLowerCase() : "active",
  };
}

export function normalizeReference(raw: unknown): ChatReferenceView | null {
  if (!isRecord(raw)) {
    return null;
  }
  const citationNumber =
    Number.isInteger(raw["citation_number"]) && (raw["citation_number"] as number) > 0
      ? (raw["citation_number"] as number)
      : null;
  return {
    citationNumber,
    label: displayText(raw["label"], "Local source / 本地来源", 180),
    passage: displayText(raw["passage"], "No excerpt was provided / API 未提供摘录。", 4000),
    hasLocation: raw["location"] !== null && raw["location"] !== undefined,
  };
}

export function normalizeReferences(value: unknown): ChatReferenceView[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(normalizeReference)
    .filter((reference): reference is ChatReferenceView => reference !== null);
}

export function normalizeMessage(
  raw: unknown,
  wrapperReferences: unknown,
): ChatMessageView | null {
  const source = isRecord(raw) && isRecord(raw["message"]) ? raw["message"] : raw;
  if (!isRecord(source)) {
    return null;
  }
  const id = internalIdentifier(source["id"] || source["message_id"]);
  const role =
    source["role"] === "user" || source["role"] === "assistant" ? source["role"] : null;
  if (!id || !role) {
    return null;
  }
  const rawReferences = isRecord(raw) ? raw["references"] : undefined;
  const references = normalizeReferences(
    Array.isArray(wrapperReferences)
      ? wrapperReferences
      : Array.isArray(rawReferences)
        ? rawReferences
        : source["references"],
  );
  return {
    id,
    role,
    content: typeof source["content"] === "string" ? source["content"] : null,
    createdAt: typeof source["created_at"] === "string" ? source["created_at"] : null,
    references,
  };
}

export function normalizeChatError(raw: unknown): ChatRunErrorView | null {
  if (!isRecord(raw)) {
    return null;
  }
  const code = knownCode(raw["code"]) || "UNEXPECTED";
  const rawRetryAfter = raw["retry_after_ms"];
  const retryAfterMs =
    typeof rawRetryAfter === "number" && Number.isFinite(rawRetryAfter) && rawRetryAfter > 0
      ? Math.min(Math.floor(rawRetryAfter), 2147483647)
      : 0;
  return {
    code,
    retriable: raw["retriable"] === true,
    retryAfterMs,
  };
}

export function normalizeChatRun(raw: unknown): ChatRunView | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = internalIdentifier(raw["id"] || raw["run_id"]);
  const rawStatus = typeof raw["status"] === "string" ? raw["status"].toLowerCase() : "";
  if (!id || !CHAT_STATUSES.has(rawStatus)) {
    return null;
  }
  const rawPhase = typeof raw["phase"] === "string" ? raw["phase"].toLowerCase() : null;
  return {
    id,
    status: rawStatus as ChatRunStatusValue,
    phase: (rawPhase && CHAT_PHASES.has(rawPhase) ? rawPhase : null) as ChatPhaseValue | null,
    error: normalizeChatError(raw["error"]),
    updatedAt: typeof raw["updated_at"] === "string" ? raw["updated_at"] : null,
  };
}

export interface ChatRunEnvelope {
  run: ChatRunView | null;
  assistantMessage: ChatMessageView | null;
  references: ChatReferenceView[];
}

export function chatRunEnvelope(payload: unknown): ChatRunEnvelope {
  const data = unwrapData(payload);
  if (!isRecord(data)) {
    return { run: null, assistantMessage: null, references: [] };
  }
  const runRaw = isRecord(data["chat_run"]) ? data["chat_run"] : data;
  const assistantRaw = isRecord(data["assistant_message"]) ? data["assistant_message"] : null;
  return {
    run: normalizeChatRun(runRaw),
    assistantMessage: assistantRaw
      ? normalizeMessage(assistantRaw, data["references"])
      : null,
    references: normalizeReferences(data["references"]),
  };
}

export interface LooseReference {
  messageId: string;
  reference: ChatReferenceView;
}

export interface MessageEnvelope {
  messages: ChatMessageView[];
  activeRun: ChatRunView | null;
  looseReferences: LooseReference[];
}

export function extractMessageEnvelope(payload: unknown): MessageEnvelope {
  const data = unwrapData(payload);
  const rawMessages = firstArray(data, ["messages", "items", "results"]);
  const messages = rawMessages
    .map((raw) => normalizeMessage(raw, isRecord(raw) ? raw["references"] : null))
    .filter((message): message is ChatMessageView => message !== null);

  const looseReferences: LooseReference[] = [];
  if (isRecord(data) && Array.isArray(data["references"])) {
    for (const rawReference of data["references"]) {
      if (!isRecord(rawReference)) {
        continue;
      }
      const messageId = internalIdentifier(
        rawReference["message_id"] || rawReference["assistant_message_id"],
      );
      const reference = normalizeReference(rawReference);
      if (messageId && reference) {
        looseReferences.push({ messageId, reference });
      }
    }
  }

  const activeRunRaw = isRecord(data)
    ? data["active_chat_run"] || data["chat_run"] || null
    : null;
  return {
    messages,
    activeRun: activeRunRaw ? normalizeChatRun(activeRunRaw) : null,
    looseReferences,
  };
}
