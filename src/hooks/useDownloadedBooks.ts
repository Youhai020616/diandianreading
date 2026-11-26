import { useCallback, useEffect, useRef, useState } from "react";
import type { DownloadedBookFile } from "../types/desktop";
import { downloadedBookRevision, type WeReadImportStatus } from "../components/DownloadedBooksView";
import { formatUserError } from "../utils/formatError";

type Notify = (message: string, tone?: "info" | "success" | "error") => void;

/** The download-directory shelf: its file list (refreshed on window focus) and per-file WeRead imports. */
export function useDownloadedBooks(notify: Notify) {
  const [files, setFiles] = useState<DownloadedBookFile[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [weReadImports, setWeReadImports] = useState<Record<string, WeReadImportStatus | undefined>>({});
  const request = useRef(0);

  const refresh = useCallback(async () => {
    const current = ++request.current;
    setLoading(true);
    setError("");
    try {
      const list = await window.diandian.router.listDownloadedBooks();
      if (current === request.current) setFiles(list);
      return list;
    } catch (cause) {
      if (current === request.current) setError(formatUserError(cause, "读取下载目录失败"));
    } finally {
      if (current === request.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    window.addEventListener("focus", refresh);
    return () => {
      ++request.current;
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);

  async function importToWeRead(file: DownloadedBookFile) {
    const revision = downloadedBookRevision(file);
    if (weReadImports[revision] === "uploading") return;
    const setStatus = (status?: WeReadImportStatus) => setWeReadImports(current => ({ ...current, [revision]: status }));
    setStatus("uploading");
    const title = file.fileName.replace(/\.[^.]+$/, "");
    try {
      const result = await window.diandian.router.importWeRead(file.filePath, { fromLibrary: true });
      setStatus("shelf");
      if (result.alreadyExisted) notify(`微信读书已收录《${title}》，可在微信读书中查找。`, "info");
      else notify(`《${title}》已导入微信读书书架。`, "success");
    } catch (cause) {
      const message = formatUserError(cause, "导入微信读书失败，请重试。");
      if (message.includes("连接与偏好")) setStatus("settings");
      else if (message.includes("查看微信读书书架")) setStatus("shelf");
      else setStatus();
      notify(message, "error");
    }
  }

  return { files, loading, error, weReadImports, refresh, importToWeRead };
}
