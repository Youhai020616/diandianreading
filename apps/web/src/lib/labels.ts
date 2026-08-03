import { ERROR_TEXT } from "./errors";
import type {
  BookSnapshot,
  ChatRunView,
  JobBlockedReason,
  JobSnapshot,
  JobStatusValue,
  JobStepValue,
} from "./types";
import { READY_BOOK_STATUSES } from "./normalize";

export function jobTypeLabel(job: JobSnapshot): string {
  if (job.title) {
    return job.title;
  }
  const labels: Record<string, string> = {
    import_book: "Book import / 书籍导入",
    local_import: "Local book import / 本地书籍导入",
    zlibrary_import: "Connected book import / 连接书籍导入",
    acquire_zlibrary: "Connected acquisition / 连接资料获取",
    generate_content: "Content generation / 内容生成",
  };
  return labels[job.jobType] || "Background job / 后台任务";
}

export function jobStatusLabel(status: JobStatusValue): string {
  const labels: Record<string, string> = {
    queued: "Queued / 已排队",
    running: "Running / 运行中",
    blocked: "Blocked / 已阻塞",
    completed: "Completed / 已完成",
    failed: "Failed / 失败",
    cancelled: "Cancelled / 已取消",
    unknown: "Unknown / 未知",
  };
  return labels[status] || (labels["unknown"] as string);
}

export function jobStepLabel(step: JobStepValue | null): string {
  const labels: Record<string, string> = {
    acquiring: "Acquiring source / 获取资料",
    storing: "Storing verified bytes / 保存已验证文件",
    preparing: "Preparing document / 处理文档",
    creating_workspace: "Creating knowledge workspace / 创建知识空间",
    uploading: "Uploading prepared source / 上传处理后来源",
    processing: "Waiting for source processing / 等待来源处理",
    verifying: "Verifying completion / 验证完成状态",
  };
  return step ? labels[step] || "Working / 处理中" : "Waiting to start / 等待开始";
}

export function formatTime(value: string | null): string {
  if (!value) {
    return "Not reported / 未提供";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Not reported / 未提供";
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function jobBlockedText(reason: JobBlockedReason | null): string {
  if (reason === "AUTH_REQUIRED") {
    return "Authentication is required. Reconnect the affected provider, then refresh this job / 需要重新认证后再刷新任务。";
  }
  if (reason === "REMOTE_OUTCOME_AMBIGUOUS") {
    return "The remote outcome is being reconciled. Do not retry blindly / 远程结果不确定，完成核对前不要重试。";
  }
  return "This job is blocked and needs an external action / 任务需要外部操作后才能继续。";
}

export function jobErrorText(job: JobSnapshot): string {
  if (job.errorCode && Object.prototype.hasOwnProperty.call(ERROR_TEXT, job.errorCode)) {
    return ERROR_TEXT[job.errorCode] as string;
  }
  return "The job failed. Review authentication and retry eligibility / 任务失败，请检查认证与重试条件。";
}

export function bookOptionText(book: BookSnapshot): string {
  const author = book.author ? ` · ${book.author}` : "";
  const readiness = READY_BOOK_STATUSES.has(book.status) ? "" : " · Not ready / 未就绪";
  return `${book.title}${author}${readiness}`;
}

export function chatRunStatusText(run: ChatRunView | null): string {
  if (!run) {
    return "Conversation ready / 对话已就绪。";
  }
  if (run.status === "queued") {
    return "Question saved; waiting for the worker / 问题已保存，等待处理。";
  }
  if (run.status === "running") {
    const phaseCopy: Record<string, string> = {
      resolving_scope: "Confirming the source scope / 正在确认来源范围。",
      waiting_for_provider: "Reading sources and organizing a complete answer / 正在读取来源并组织回答。",
      reconciling: "Confirming whether the provider completed the answer / 正在核对 Provider 是否已完成回答。",
      finalizing: "Saving the answer and references / 正在保存回答与引用。",
    };
    return (
      (run.phase ? phaseCopy[run.phase] : undefined)
      || "The saved answer run is active / 回答任务正在运行。"
    );
  }
  if (run.status === "completed") {
    return "Answer completed and saved / 回答已完成并保存。";
  }
  if (run.status === "cancelled") {
    return "Answer run cancelled at a safe point / 回答任务已在安全点取消。";
  }
  if (run.status === "failed") {
    const code = run.error ? run.error.code : "UNEXPECTED";
    return Object.prototype.hasOwnProperty.call(ERROR_TEXT, code)
      ? (ERROR_TEXT[code] as string)
      : (ERROR_TEXT["UNEXPECTED"] as string);
  }
  return "Conversation ready / 对话已就绪。";
}
