import { useCallback, useRef, useState } from "react";
import type { ReaderTranslationProvider } from "../types/desktop";
import type { ReaderTranslationMode, ReaderTranslationTarget } from "../reader/types";
import { formatUserError } from "../utils/formatError";

export function useReaderTranslation() {
  const [mode, setMode] = useState<ReaderTranslationMode>("off");
  const [provider, setProvider] = useState<ReaderTranslationProvider>("deepl");
  const [issue, setIssue] = useState("");
  const [working, setWorking] = useState(0);
  const [revision, setRevision] = useState(0);
  const paused = useRef(false);
  const generation = useRef(0);

  const reset = useCallback(() => {
    generation.current++;
    paused.current = false;
    setIssue("");
    setWorking(0);
    setRevision(n => n + 1);
  }, []);

  function changeMode(next: ReaderTranslationMode, nextProvider = provider) {
    reset();
    setProvider(nextProvider);
    setMode(next);
  }

  const translate = useCallback(async (texts: string[], target: ReaderTranslationTarget, signal: AbortSignal) => {
    signal.throwIfAborted();
    const session = generation.current;
    const api = window.diandian.reader;
    const input = { provider, target, texts };
    const readCache = async () => (await api.readCachedTranslations(input)).map(value => value ?? "");
    if (paused.current) return readCache();
    const requestId = crypto.randomUUID();
    const cancel = () => { void api.cancelTranslation(requestId).catch(() => {}); };
    signal.addEventListener("abort", cancel, { once: true });
    setWorking(n => n + 1);
    try {
      return await api.translate({ ...input, requestId });
    } catch (cause) {
      signal.throwIfAborted();
      if (generation.current !== session) throw cause;
      paused.current = true;
      setIssue(formatUserError(cause, "暂时无法翻译"));
      return await readCache();
    } finally {
      signal.removeEventListener("abort", cancel);
      if (generation.current === session) setWorking(n => Math.max(0, n - 1));
    }
  }, [provider]);
  return { mode, provider, changeMode, revision, reset, translate, issue, setIssue, working };
}
