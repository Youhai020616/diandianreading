/** Agent, models, chat history and safety mode. */

export type SafetyMode = "plan" | "confirm" | "auto";

export interface AppInfo {
  name: string;
  version: string;
  electronVersion: string;
  nodeVersion: string;
}

export interface PublicModelSettings {
  provider: "deepseek" | "openai-compatible";
  model: string;
  baseUrl: string;
  hasApiKey: boolean;
  apiKeySource: "saved" | "env" | "none";
  /** How the saved key sits on disk; "plain" means the system keychain was unavailable. */
  apiKeyStorage: "encrypted" | "plain" | "none";
  /** Whether a newly entered key would be encrypted. */
  secureStorageAvailable: boolean;
}

export interface TwinProfileState {
  profileMd: string;
  styleMd: string;
  sha256: string;
  twinDir: string;
  updatedAt: string;
}

export interface StyleDistillSuggestion {
  id: string;
  rule: string;
  reason: string;
  source: "llm" | "heuristic";
}

export interface ChatMessageRecord {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  text: string;
  reasoning: string;
  contexts: string[];
  tools: Array<{ name: string; status: "running" | "done" }>;
  createdAt: string;
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  harnessSessionId: string;
  /** The book, page or draft the conversation started from; used to group history. */
  contextLabel: string;
  messageCount: number;
  preview: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatSessionDetail extends ChatSessionSummary {
  messages: ChatMessageRecord[];
}

export type AgentEvent =
  | { kind: "engine-state"; state: "idle" | "booting" | "ready" | "error"; detail?: string }
  | { kind: "status"; running: boolean }
  | { kind: "stream"; streamRole: "assistant" | "reasoning"; text: string; sessionId: string | null }
  | { kind: "tool"; phase: "start" | "done"; name: string; callId?: string; sessionId: string | null }
  | { kind: "final"; sessionId: string | null; finalResponse: string; finishReason: string | null }
  | { kind: "session-reset" }
  | { kind: "error"; message: string; sessionId?: string | null };

export interface AvailableModelOption {
  id: string;
  label: string;
  tag?: string;
  desc?: string;
  source: "api" | "preset" | "current";
}

export interface AvailableModelsResult {
  models: AvailableModelOption[];
  source: "api" | "preset";
  providerLabel: string;
  error?: string;
}
