import type { ReactElement } from "react";
import {
  formatTime,
  jobBlockedText,
  jobErrorText,
  jobStatusLabel,
  jobStepLabel,
  jobTypeLabel,
} from "../lib/labels";
import type { JobSnapshot } from "../lib/types";
import type { AppController } from "../state/controller";
import type { AppState } from "../state/store";

interface JobsViewProps {
  state: AppState;
  controller: AppController;
}

interface JobDetailProps {
  job: JobSnapshot;
  controller: AppController;
  retryBusy: boolean;
}

function JobDetail({ job, controller, retryBusy }: JobDetailProps): ReactElement {
  return (
    <article className="job-detail">
      <div className="job-detail-heading">
        <div>
          <h2>{jobTypeLabel(job)}</h2>
          <p>{`Saved snapshot · Updated ${formatTime(job.updatedAt || job.createdAt)}`}</p>
        </div>
        <span className="status-badge" data-state={job.status}>
          {jobStatusLabel(job.status)}
        </span>
      </div>

      <dl className="job-facts">
        <dt>Status / 状态</dt>
        <dd>{jobStatusLabel(job.status)}</dd>
        <dt>Current step / 当前步骤</dt>
        <dd>{jobStepLabel(job.currentStep)}</dd>
        {job.attempt !== null ? (
          <>
            <dt>Attempt / 尝试次数</dt>
            <dd>{String(job.attempt)}</dd>
          </>
        ) : null}
        {job.progressCurrent !== null && job.progressTotal !== null ? (
          <>
            <dt>Reported work / 已报告处理量</dt>
            <dd>{`${job.progressCurrent} of ${job.progressTotal} units / ${job.progressCurrent} / ${job.progressTotal} 个单元`}</dd>
          </>
        ) : null}
        <dt>Created / 创建</dt>
        <dd>{formatTime(job.createdAt)}</dd>
        {job.completedAt ? (
          <>
            <dt>Finished / 结束</dt>
            <dd>{formatTime(job.completedAt)}</dd>
          </>
        ) : null}
        {job.cancelRequestedAt ? (
          <>
            <dt>Cancellation / 取消</dt>
            <dd>{`Requested at ${formatTime(job.cancelRequestedAt)}; this does not claim the remote work already stopped / 已请求取消，不代表远程操作已停止`}</dd>
          </>
        ) : null}
      </dl>

      {job.status === "blocked" ? (
        <p className="job-callout" data-state="warning">
          {jobBlockedText(job.blockedReason)}
        </p>
      ) : null}
      {job.status === "failed" ? (
        <p className="job-callout" data-state="error">
          {jobErrorText(job)}
        </p>
      ) : null}

      <div className="job-detail-actions">
        <button
          className="button button-secondary"
          type="button"
          onClick={() => void controller.selectJob(job.id, false)}
        >
          Refresh snapshot / 刷新快照
        </button>
        {job.status === "failed" && job.retriable ? (
          <button
            className="button button-primary"
            type="button"
            disabled={retryBusy}
            onClick={() => void controller.retryJob(job.id)}
          >
            Retry job / 重试任务
          </button>
        ) : null}
      </div>
    </article>
  );
}

export function JobsView({ state, controller }: JobsViewProps): ReactElement {
  const selected = state.jobs.find((job) => job.id === state.selectedJobId) || null;

  return (
    <section
      className="view"
      id="view-jobs"
      data-view-panel="jobs"
      aria-labelledby="jobs-title"
      hidden={state.currentView !== "jobs"}
    >
      <div className="view-heading">
        <div>
          <p className="eyebrow">DURABLE LOCAL WORK</p>
          <h1 id="jobs-title">
            Jobs <span>/ 任务进度</span>
          </h1>
          <p>状态来自持久化快照。实时事件只触发重新获取，不模拟 Token 流或虚假百分比。</p>
        </div>
        <button
          className="button button-secondary"
          id="refresh-jobs-button"
          type="button"
          disabled={state.jobsRefreshBusy}
          onClick={() => void controller.refreshJobs()}
        >
          Refresh / 刷新任务
        </button>
      </div>

      <p
        className="section-status"
        id="jobs-status"
        role="status"
        aria-live="polite"
        data-state={state.jobsStatus.state || undefined}
      >
        {state.jobsStatus.text}
      </p>

      <div className="jobs-layout">
        <section className="jobs-list-panel" aria-labelledby="job-list-title">
          <div className="panel-heading">
            <h2 id="job-list-title">Recent jobs / 最近任务</h2>
            <span>最多 50 条</span>
          </div>
          <ul className="job-list" id="job-list">
            {state.jobs.length === 0 ? (
              <li className="job-list-empty">
                No jobs found / 暂无任务。导入书籍后会在这里显示持久状态。
              </li>
            ) : (
              state.jobs.map((job) => (
                <li className="job-list-item" key={job.id}>
                  <button
                    className="job-card-button"
                    type="button"
                    aria-pressed={job.id === state.selectedJobId}
                    onClick={() => void controller.selectJob(job.id, true)}
                  >
                    <span className="job-card-title">{jobTypeLabel(job)}</span>
                    <span className="status-badge" data-state={job.status}>
                      {jobStatusLabel(job.status)}
                    </span>
                    <span className="job-card-meta">
                      {`Updated / 更新：${formatTime(job.updatedAt || job.createdAt)}`}
                    </span>
                    <span className="job-card-step">{jobStepLabel(job.currentStep)}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </section>

        <section
          className="job-detail-panel"
          id="job-detail-panel"
          aria-label="Job details / 任务详情"
        >
          <div className="empty-state" id="job-detail-empty" hidden={Boolean(selected)}>
            <span aria-hidden="true">↗</span>
            <h2>Select a job / 选择任务</h2>
            <p>查看持久状态、当前步骤、阻塞原因与安全重试选项。</p>
          </div>
          <div id="job-detail-content" hidden={!selected}>
            {selected ? (
              <JobDetail job={selected} controller={controller} retryBusy={state.jobRetryBusy} />
            ) : null}
          </div>
        </section>
      </div>
    </section>
  );
}
