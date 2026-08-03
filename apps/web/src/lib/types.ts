export type ViewName = "connections" | "import" | "jobs" | "library" | "reader";
export type ImportTabName = "local" | "zlibrary";
export type PanelMode = "desktop" | "drawer" | "mobile";

export type SessionStatus =
  | "loading"
  | "active"
  | "required"
  | "expired"
  | "unavailable"
  | "error";

export type ProviderStatus =
  | "loading"
  | "connected"
  | "required"
  | "unavailable"
  | "error"
  | "unknown";

export type JobStatusValue =
  | "queued"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export type JobStepValue =
  | "acquiring"
  | "storing"
  | "preparing"
  | "creating_workspace"
  | "uploading"
  | "processing"
  | "verifying";

export type JobBlockedReason = "AUTH_REQUIRED" | "REMOTE_OUTCOME_AMBIGUOUS";

export interface JobSnapshot {
  id: string;
  title: string;
  jobType: string;
  status: JobStatusValue;
  currentStep: JobStepValue | null;
  blockedReason: JobBlockedReason | null;
  errorCode: string | null;
  retriable: boolean;
  cancelRequestedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  progressCurrent: number | null;
  progressTotal: number | null;
  attempt: number | null;
}

export interface BookSnapshot {
  id: string;
  title: string;
  author: string;
  status: string;
}

export interface ConversationSnapshot {
  id: string;
  bookId: string;
  title: string;
  status: string;
}

export interface ChatReferenceView {
  citationNumber: number | null;
  label: string;
  passage: string;
  hasLocation: boolean;
}

export interface ChatMessageView {
  id: string;
  role: "user" | "assistant";
  content: string | null;
  createdAt: string | null;
  references: ChatReferenceView[];
}

export type ChatRunStatusValue = "queued" | "running" | "completed" | "failed" | "cancelled";

export type ChatPhaseValue =
  | "resolving_scope"
  | "waiting_for_provider"
  | "reconciling"
  | "finalizing";

export interface ChatRunErrorView {
  code: string;
  retriable: boolean;
  retryAfterMs: number;
}

export interface ChatRunView {
  id: string;
  status: ChatRunStatusValue;
  phase: ChatPhaseValue | null;
  error: ChatRunErrorView | null;
  updatedAt: string | null;
}

export interface StatusLine {
  text: string;
  state: string;
}
