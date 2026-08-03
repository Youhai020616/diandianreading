import type { ReactElement } from "react";
import type { AppController } from "../state/controller";
import type { AppState } from "../state/store";

interface ImportViewProps {
  state: AppState;
  controller: AppController;
}

export function ImportView({ state, controller }: ImportViewProps): ReactElement {
  const localActive = state.importTab === "local";
  const localBusy = state.localImportBusy;
  const zlibraryBusy = state.zlibraryImportBusy;

  return (
    <section
      className="view"
      id="view-import"
      data-view-panel="import"
      aria-labelledby="import-title"
      hidden={state.currentView !== "import"}
    >
      <div className="view-heading">
        <div>
          <p className="eyebrow">ONE SOURCE, EXPLICIT RIGHTS</p>
          <h1 id="import-title">
            Import <span>/ 导入书籍</span>
          </h1>
          <p>每次导入都需要单独确认权利依据。默认使用本地文件；可选连接仅用于你有权访问的资料。</p>
        </div>
      </div>

      <div className="segmented-control" role="tablist" aria-label="Import source / 导入来源">
        <button
          className={localActive ? "segment is-active" : "segment"}
          id="local-import-tab"
          type="button"
          role="tab"
          aria-selected={localActive}
          aria-controls="local-import-panel"
          tabIndex={localActive ? 0 : -1}
          ref={(node) => controller.registerRef("localImportTab", node)}
          onClick={() => controller.setImportTab("local", false)}
          onKeyDown={(event) => controller.handleImportTabKeydown(event)}
        >
          Local file / 本地文件
        </button>
        <button
          className={localActive ? "segment" : "segment is-active"}
          id="zlibrary-import-tab"
          type="button"
          role="tab"
          aria-selected={!localActive}
          aria-controls="zlibrary-import-panel"
          tabIndex={localActive ? -1 : 0}
          ref={(node) => controller.registerRef("zlibraryImportTab", node)}
          onClick={() => controller.setImportTab("zlibrary", false)}
          onKeyDown={(event) => controller.handleImportTabKeydown(event)}
        >
          Z-Library / 可选连接
        </button>
      </div>

      <section
        className="import-panel"
        id="local-import-panel"
        role="tabpanel"
        aria-labelledby="local-import-tab"
        hidden={!localActive}
      >
        <form
          id="local-import-form"
          noValidate
          aria-busy={localBusy || undefined}
          onSubmit={(event) => {
            event.preventDefault();
            void controller.submitLocalImport();
          }}
        >
          <div className="form-intro">
            <div>
              <p className="card-kicker">RECOMMENDED</p>
              <h2>Upload a local PDF or EPUB</h2>
              <p>文件字节直接发送到同源 API；页面只显示文件名，不读取或显示物理路径。</p>
            </div>
            <span className="format-chip">PDF · EPUB</span>
          </div>

          <div className="field full-field">
            <label htmlFor="local-file">Book file / 书籍文件</label>
            <input
              id="local-file"
              name="file"
              type="file"
              accept=".pdf,.epub,application/pdf,application/epub+zip"
              required
              aria-describedby="local-file-help"
              disabled={localBusy}
            />
            <p className="field-help" id="local-file-help">
              选择一个你有权处理的 PDF 或 EPUB 文件。
            </p>
          </div>

          <div className="form-grid">
            <div className="field">
              <label htmlFor="local-notebooklm-profile">NotebookLM profile / 配置名称</label>
              <input
                id="local-notebooklm-profile"
                name="notebooklm_profile"
                type="text"
                maxLength={128}
                autoComplete="off"
                required
                placeholder="例如：default"
                disabled={localBusy}
              />
            </div>
            <div className="field">
              <label htmlFor="local-rights-basis">Rights basis / 权利依据</label>
              <select id="local-rights-basis" name="rights_basis" required defaultValue="" disabled={localBusy}>
                <option value="">请选择 / Select one</option>
                <option value="owned_copy">Owned copy / 合法持有副本</option>
                <option value="public_domain">Public domain / 公版</option>
                <option value="open_license">Open license / 开放许可</option>
              </select>
            </div>
            <div className="field full-field">
              <label htmlFor="local-license-identifier">License identifier / 许可标识（可选）</label>
              <input
                id="local-license-identifier"
                name="license_identifier"
                type="text"
                maxLength={256}
                autoComplete="off"
                placeholder="例如：CC BY 4.0"
                disabled={localBusy}
              />
            </div>
          </div>

          <label className="confirmation" htmlFor="local-rights-confirmed">
            <input
              id="local-rights-confirmed"
              name="rights_confirmed"
              type="checkbox"
              required
              disabled={localBusy}
            />
            <span>
              <strong>I confirm my rights / 我确认拥有处理权利</strong>
              <small>我确认此单项资料的使用符合所选依据，并理解该声明会被记录用于本地审计。</small>
            </span>
          </label>

          <div className="form-actions">
            <button className="button button-primary" type="submit" disabled={localBusy}>
              Start import / 开始导入
            </button>
            <p
              className="form-status"
              id="local-import-status"
              role="status"
              aria-live="polite"
              data-state={state.localImportStatus.state || undefined}
            >
              {state.localImportStatus.text}
            </p>
          </div>
        </form>
      </section>

      <section
        className="import-panel"
        id="zlibrary-import-panel"
        role="tabpanel"
        aria-labelledby="zlibrary-import-tab"
        hidden={localActive}
      >
        <form
          id="zlibrary-import-form"
          noValidate
          aria-busy={zlibraryBusy || undefined}
          onSubmit={(event) => {
            event.preventDefault();
            void controller.submitZlibraryImport();
          }}
        >
          <div className="form-intro">
            <div>
              <p className="card-kicker">OPTIONAL · EXPLICIT ATTESTATION</p>
              <h2>Import from an approved location</h2>
              <p>仅提交你有合法访问权的 HTTPS 位置。此入口不会绕过 DRM、访问控制或站点授权。</p>
            </div>
          </div>

          <div className="field full-field">
            <label htmlFor="zlibrary-location">Book location / 资料位置</label>
            <input
              id="zlibrary-location"
              name="location"
              type="url"
              inputMode="url"
              maxLength={2048}
              autoComplete="off"
              required
              placeholder="https://…"
              aria-describedby="zlibrary-location-help"
              disabled={zlibraryBusy}
            />
            <p className="field-help" id="zlibrary-location-help">
              必须是已配置连接允许的 HTTPS 地址，且不得包含 URL 用户名或密码。
            </p>
          </div>

          <div className="form-grid">
            <div className="field">
              <label htmlFor="zlibrary-title">Book title / 书名</label>
              <input
                id="zlibrary-title"
                name="title"
                type="text"
                maxLength={200}
                autoComplete="off"
                required
                disabled={zlibraryBusy}
              />
            </div>
            <div className="field">
              <label htmlFor="zlibrary-author">Author / 作者（可选）</label>
              <input
                id="zlibrary-author"
                name="author"
                type="text"
                maxLength={200}
                autoComplete="off"
                disabled={zlibraryBusy}
              />
            </div>
            <div className="field">
              <label htmlFor="zlibrary-profile">Z-Library profile / 配置名称</label>
              <input
                id="zlibrary-profile"
                name="zlibrary_profile"
                type="text"
                maxLength={128}
                autoComplete="off"
                required
                placeholder="例如：default"
                disabled={zlibraryBusy}
              />
            </div>
            <div className="field">
              <label htmlFor="zlibrary-notebooklm-profile">NotebookLM profile / 配置名称</label>
              <input
                id="zlibrary-notebooklm-profile"
                name="notebooklm_profile"
                type="text"
                maxLength={128}
                autoComplete="off"
                required
                placeholder="例如：default"
                disabled={zlibraryBusy}
              />
            </div>
            <div className="field">
              <label htmlFor="zlibrary-rights-basis">Rights basis / 权利依据</label>
              <select
                id="zlibrary-rights-basis"
                name="rights_basis"
                required
                defaultValue=""
                disabled={zlibraryBusy}
              >
                <option value="">请选择 / Select one</option>
                <option value="owned_copy">Owned copy / 合法持有副本</option>
                <option value="public_domain">Public domain / 公版</option>
                <option value="open_license">Open license / 开放许可</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="zlibrary-license-identifier">
                License identifier / 许可标识（可选）
              </label>
              <input
                id="zlibrary-license-identifier"
                name="license_identifier"
                type="text"
                maxLength={256}
                autoComplete="off"
                placeholder="例如：CC BY 4.0"
                disabled={zlibraryBusy}
              />
            </div>
          </div>

          <label className="confirmation" htmlFor="zlibrary-rights-confirmed">
            <input
              id="zlibrary-rights-confirmed"
              name="rights_confirmed"
              type="checkbox"
              required
              disabled={zlibraryBusy}
            />
            <span>
              <strong>I confirm this specific acquisition / 我确认本次单项获取</strong>
              <small>
                我确认有权从所填位置获取并处理该资料；确认不会被预选，也不能用于批量或通用下载。
              </small>
            </span>
          </label>

          <div className="form-actions">
            <button className="button button-primary" type="submit" disabled={zlibraryBusy}>
              Start import / 开始导入
            </button>
            <p
              className="form-status"
              id="zlibrary-import-status"
              role="status"
              aria-live="polite"
              data-state={state.zlibraryImportStatus.state || undefined}
            >
              {state.zlibraryImportStatus.text}
            </p>
          </div>
        </form>
      </section>
    </section>
  );
}
