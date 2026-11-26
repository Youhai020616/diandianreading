import { useEffect, useState } from "react";
import { IconFolder } from "../Icons";
import { ObsidianVaultPicker } from "../ObsidianVaultPicker";

/** Which Obsidian vault exports go to, and how exports handle renames and edits. */
export function ObsidianExportSettings() {
  const [vaultPath, setVaultPath] = useState<string | null>(null);
  const [changingVault, setChangingVault] = useState(false);
  const [readError, setReadError] = useState(false);
  const [readAttempt, setReadAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setReadError(false);
    void window.diandian.obsidian.getVault().then(
      ({ vaultPath: path }) => {
        if (active) setVaultPath(path);
      },
      () => {
        if (active) setReadError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [readAttempt]);

  const vaultName = vaultPath?.split(/[\\/]/).filter(Boolean).pop() || vaultPath;

  return (
    <section className="editorial-card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h3 style={{ margin: 0, fontFamily: "var(--font-serif)", fontSize: 16 }}>导出到 Obsidian</h3>
        <p style={{ margin: "6px 0 0", color: "var(--ink-secondary)", lineHeight: 1.6 }}>
          从「阅读笔记」导出一本书的全部划线，或从「创作草稿」导出草稿最新保存的版本。
        </p>
      </div>

      {readError && (
        <div role="alert">
          <span>暂时无法读取当前连接的笔记库。</span>{" "}
          <button className="btn sm" type="button" onClick={() => setReadAttempt((n) => n + 1)}>重试</button>
        </div>
      )}
      {vaultPath === null && !readError && <div role="status">正在读取笔记库连接…</div>}
      {vaultPath && !changingVault && (
        <div className="conn-group">
          <div className="conn-row">
            <div className="conn-card-head">
              <strong className="conn-card-title" style={{ overflowWrap: "anywhere" }}>
                <IconFolder size={15} /> {vaultName}
              </strong>
              <span className="badge sage">已连接</span>
            </div>
            <div className="conn-card-meta" style={{ overflowWrap: "anywhere", userSelect: "text" }}>{vaultPath}</div>
            <div className="conn-card-actions">
              <button className="btn sm" type="button" onClick={() => setChangingVault(true)}>更换笔记库</button>
            </div>
          </div>
        </div>
      )}
      {(vaultPath === "" || changingVault) && (
        <ObsidianVaultPicker
          actionLabel="连接这个笔记库"
          onConnect={async (path) => {
            setVaultPath(path);
            setChangingVault(false);
          }}
          onCancel={changingVault ? () => setChangingVault(false) : undefined}
          cancelLabel="取消更换"
        />
      )}

      <details style={{ color: "var(--ink-secondary)", fontSize: 12.5, lineHeight: 1.65 }}>
        <summary style={{ cursor: "pointer" }}>了解导出规则</summary>
        <p>书籍划线默认保存到笔记库的 <code>DiandianReading/Books</code>，创作草稿保存到 <code>DiandianReading/Drafts</code>。</p>
        <p style={{ marginBottom: 0 }}>再次导出时，点点读书会按笔记标识查找改名或移动过的文件。如果你在 Obsidian 里编辑过笔记，原稿会保留，新导出的内容会另存为冲突副本。</p>
      </details>
    </section>
  );
}
