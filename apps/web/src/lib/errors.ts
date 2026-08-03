export const ERROR_TEXT: Readonly<Record<string, string>> = Object.freeze({
  AUTH_REQUIRED: "Authentication is required / 需要重新认证。",
  VALIDATION: "Some values are invalid. Review the highlighted fields / 请检查输入内容。",
  PAYLOAD_TOO_LARGE: "The request is too large. Choose a smaller file or shorten the question / 请求过大。",
  NOT_FOUND: "The requested local resource is no longer available / 本地资源不存在或已删除。",
  SOURCE_NOT_READY: "The book source is still processing. Check its import job / 书籍来源尚未就绪。",
  REMOTE_RATE_LIMITED: "The remote service is rate-limited. Wait before retrying / 远程服务限流，请稍后重试。",
  REMOTE_UNAVAILABLE: "The remote service is temporarily unavailable / 远程服务暂时不可用。",
  REMOTE_PROTOCOL_DRIFT: "The provider integration needs an update / Provider 集成需要升级。",
  SOURCE_PROCESSING_FAILED: "Source processing failed. Review the related import job / 来源处理失败。",
  CONVERSATION_BUSY: "This conversation already has an active answer run / 当前对话已有回答正在运行。",
  IDEMPOTENCY_CONFLICT: "The saved command no longer matches this request. Refresh before continuing / 幂等请求冲突，请刷新。",
  AMBIGUOUS_PROVIDER_OUTCOME: "The provider outcome is uncertain. Do not retry until reconciliation finishes / 结果仍在核对，暂不可重试。",
  UNEXPECTED: "An unexpected local service error occurred / 本地服务出现意外错误。",
  NETWORK_UNAVAILABLE: "The local API could not be reached / 无法连接本地 API。",
  INVALID_RESPONSE: "The local API returned an unreadable response / 本地 API 返回了无法读取的响应。",
  CSRF_MISSING: "The security token is missing. Refresh or relaunch the local workspace / 缺少安全令牌，请刷新或重新启动。",
});

export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly status: number;
  readonly code: string;
  readonly payload: unknown;

  constructor(status: number, code: string | null | undefined, payload: unknown) {
    super(code || "API_ERROR");
    this.status = status;
    this.code = code || "API_ERROR";
    this.payload = payload;
  }
}

export class UiError extends Error {
  override readonly name = "UiError";
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export function friendlyError(error: unknown, fallback: string): string {
  const candidate = error as { code?: unknown } | null | undefined;
  const code = candidate && typeof candidate.code === "string" ? candidate.code : "";
  if (Object.prototype.hasOwnProperty.call(ERROR_TEXT, code)) {
    return ERROR_TEXT[code] as string;
  }
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return ERROR_TEXT["AUTH_REQUIRED"] as string;
    }
    if (error.status === 403) {
      return "The local security check rejected this request / 本地安全校验拒绝了请求。";
    }
    if (error.status >= 500) {
      return "The local service is temporarily unavailable / 本地服务暂时不可用。";
    }
  }
  return fallback;
}

export function errorText(code: string): string {
  const text = ERROR_TEXT[code];
  return text !== undefined ? text : (ERROR_TEXT["UNEXPECTED"] as string);
}
