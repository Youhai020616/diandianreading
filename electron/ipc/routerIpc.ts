import fs from "node:fs";
import path from "node:path";
import { dialog, shell } from "electron";
import { sendBookViaKindleSmtp, verifyKindleSmtp, type KindleSmtpSecurity } from "../router/kindleSmtpService";
import { importBookText, importResult, importSelectedBooks } from "../router/localBookImport";
import { ROUTER_EBOOK_EXTENSIONS, BOOK_FILE_EXTENSIONS, listDownloadedBooks, resolveDownloadedBook } from "../router/downloadedBooks";
import { openReaderBook, resolveReaderHighlight, updateReaderMetadata } from "../router/localReader";
import type { ReaderTranslationInput, ReaderTranslationSettingsInput } from "../../src/types/desktop";
import type { DownloadCoverHint, ReaderAnnotationInput } from "../../src/types/desktop";
import { type ConnectionsSnapshot } from "../router/zlibCliService";
import { state, ipc, sendToMain, requireDb } from "../appState";

export function registerRouterIpc(): void {
  // ---------- Optional Book Router (heartleo/zlib CLI adapter) ----------

  const enrichConnectionsWithKindle = (snapshot: ConnectionsSnapshot): ConnectionsSnapshot => {
    const appKindle = state.kindleStore?.readPublic();
    if (appKindle?.configured) {
      return {
        ...snapshot,
        kindle: {
          configured: true,
          to: appKindle.to,
          from: appKindle.from,
          smtpHost: appKindle.smtpHost,
          smtpPort: String(appKindle.smtpPort),
          smtpSecurity: appKindle.smtpSecurity,
        },
      };
    }
    return snapshot;
  };

  ipc.handle("router:status", async () => {
    if (!state.zlibService) throw new Error("Router service unavailable");
    return state.zlibService.getStatus();
  });

  ipc.handle("router:connections", async () => {
    if (!state.zlibService) throw new Error("Router service unavailable");
    return enrichConnectionsWithKindle(await state.zlibService.getConnectionsSnapshot());
  });

  ipc.handle("router:set-domain", (_win, domain: string) => {
    if (!state.zlibService) throw new Error("Router service unavailable");
    const clean = state.zlibService.setPreferredDomain(domain);
    requireDb().setSetting("router.zlibDomain", clean);
    return { domain: clean };
  });

  ipc.handle("router:doctor", async () => {
    if (!state.zlibService) throw new Error("Router service unavailable");
    return state.zlibService.runDoctor();
  });

  ipc.handle("router:open-zlib-login", async (_win, domain?: string) => {
    if (!state.browserService || !state.zlibService) throw new Error("服务未就绪");
    let target = (domain ?? "").trim() || state.zlibService.getPreferredDomain();
    if (!target) {
      const domains = await state.zlibService.listHealthyDomains().catch(() => []);
      target = domains.find((d) => d.status === "healthy")?.domain || "https://z-lib.by";
    }
    const clean = state.zlibService.setPreferredDomain(target);
    requireDb().setSetting("router.zlibDomain", clean);
    await state.browserService.openUrl(clean, { newTab: false });
    return { openedUrl: clean };
  });

  ipc.handle("router:sync-zlib-from-browser", async (_win, preferredDomain?: string) => {
    if (!state.browserService || !state.zlibService) throw new Error("服务未就绪");
    const activeUrl = state.browserService.getActiveTabUrl();
    const candidateUrl = (preferredDomain ?? "").trim() || activeUrl || state.zlibService.getPreferredDomain();
    if (!candidateUrl || !/^https?:\/\//i.test(candidateUrl)) {
      throw new Error("请先在右侧浏览器打开并登录一个 Z-Library 镜像站点");
    }
    const origin = new URL(candidateUrl).origin;
    const cookies = await state.browserService.exportCookiesForOrigin(origin);
    const snapshot = enrichConnectionsWithKindle(await state.zlibService.loginZlibWithCookies(cookies, origin));
    requireDb().setSetting("router.zlibDomain", origin);
    return { origin, cookieCount: cookies.length, snapshot };
  });

  ipc.handle("router:login-zlib-cookie-file", async (win, domain?: string) => {
    if (!state.zlibService) throw new Error("Router service unavailable");
    const res = await dialog.showOpenDialog(win, {
      title: "选择 Z-Library Netscape cookies.txt 文件",
      properties: ["openFile"],
      filters: [{ name: "Netscape Cookie 文件", extensions: ["txt"] }],
    });
    if (res.canceled || !res.filePaths[0]) {
      return { canceled: true as const };
    }
    const snapshot = enrichConnectionsWithKindle(await state.zlibService.loginZlibWithCookieFile(res.filePaths[0], domain));
    if (snapshot.zlib.currentDomain) {
      requireDb().setSetting("router.zlibDomain", snapshot.zlib.currentDomain);
    }
    return { canceled: false as const, snapshot };
  });

  ipc.handle("router:start-weread-qr", () => {
    if (!state.zlibService) throw new Error("Router service unavailable");
    state.zlibService.startWeReadQrLogin((ev) => sendToMain("router:weread-qr", ev));
    return { started: true };
  });

  ipc.handle("router:cancel-weread-qr", () => {
    state.zlibService?.cancelWeReadQrLogin();
    return { canceled: true };
  });

  ipc.handle("router:logout-zlib", async () => {
    if (!state.zlibService) throw new Error("Router service unavailable");
    const snapshot = enrichConnectionsWithKindle(await state.zlibService.logoutZlib());
    return { snapshot };
  });

  ipc.handle("router:logout-weread", async () => {
    if (!state.zlibService) throw new Error("Router service unavailable");
    const snapshot = enrichConnectionsWithKindle(await state.zlibService.logoutWeRead());
    return { snapshot };
  });

  ipc.handle("router:get-kindle-config", async () => {
    if (!state.kindleStore) throw new Error("Kindle settings unavailable");
    const appCfg = state.kindleStore.readPublic();
    if (appCfg.to || appCfg.from || appCfg.smtpHost || appCfg.hasPassword) {
      return appCfg;
    }
    // Pre-populate non-secret defaults from zlib CLI if user previously ran terminal wizard
    if (state.zlibService) {
      try {
        const snap = await state.zlibService.getConnectionsSnapshot();
        if (snap.kindle.to || snap.kindle.from) {
          return {
            configured: false,
            to: snap.kindle.to,
            from: snap.kindle.from,
            smtpHost: snap.kindle.smtpHost || "smtp.qq.com",
            smtpPort: Number(snap.kindle.smtpPort) || 465,
            smtpSecurity: snap.kindle.smtpSecurity === "starttls" ? ("starttls" as const) : ("tls" as const),
            hasPassword: false,
          };
        }
      } catch {
        // Non-fatal
      }
    }
    return appCfg;
  });

  ipc.handle(
    "router:save-kindle-config",
    async (
      _win,
      input: {
        to?: string;
        from?: string;
        smtpHost?: string;
        smtpPort?: number;
        smtpSecurity?: KindleSmtpSecurity;
        password?: string;
        clearPassword?: boolean;
        clearAll?: boolean;
      },
    ) => {
      if (!state.kindleStore) throw new Error("Kindle settings unavailable");
      const config = input.clearAll
        ? state.kindleStore.clear()
        : state.kindleStore.save({
            to: String(input.to ?? ""),
            from: String(input.from ?? ""),
            smtpHost: String(input.smtpHost ?? ""),
            smtpPort: Number(input.smtpPort ?? 465),
            smtpSecurity: input.smtpSecurity === "starttls" ? "starttls" : "tls",
            password: typeof input.password === "string" ? input.password : undefined,
            clearPassword: input.clearPassword === true,
          });
      const snapshot = state.zlibService
        ? enrichConnectionsWithKindle(await state.zlibService.getConnectionsSnapshot())
        : null;
      return { config, snapshot };
    },
  );

  ipc.handle(
    "router:test-kindle-config",
    async (
      _win,
      input: {
        from: string;
        smtpHost: string;
        smtpPort: number;
        smtpSecurity: KindleSmtpSecurity;
        password?: string;
        useSavedPassword?: boolean;
      },
    ) => {
      const savedPass = input.useSavedPassword ? state.kindleStore?.readRaw().password ?? "" : "";
      const pass = (input.password ?? "").trim() || savedPass;
      return verifyKindleSmtp({
        from: String(input.from ?? ""),
        smtpHost: String(input.smtpHost ?? ""),
        smtpPort: Number(input.smtpPort ?? 465),
        smtpSecurity: input.smtpSecurity === "starttls" ? "starttls" : "tls",
        password: pass,
      });
    },
  );

  ipc.handle("router:open-kindle-config", async () => {
    if (!state.zlibService) throw new Error("Router service unavailable");
    return state.zlibService.openKindleConfigInTerminal();
  });

  ipc.handle(
    "router:search",
    async (_win, input: { query: string; format?: string; limit?: number; page?: number; order?: string }) => {
      if (!state.zlibService) throw new Error("Router service unavailable");
      return state.zlibService.search(input.query, {
        format: input.format,
        limit: input.limit,
        page: input.page,
        order: input.order,
      });
    },
  );

  ipc.handle("router:recommended", async (_win, input?: { forceRefresh?: boolean }) => {
    if (!state.zlibService) throw new Error("Router service unavailable");
    return state.zlibService.getRecommended(input?.forceRefresh === true);
  });

  ipc.handle("router:most-popular", async (_win, input?: { forceRefresh?: boolean }) => {
    if (!state.zlibService) throw new Error("Router service unavailable");
    return state.zlibService.getMostPopular(input?.forceRefresh === true);
  });

  ipc.handle("router:favorites", async (_win, input?: { forceRefresh?: boolean }) => {
    if (!state.zlibService) throw new Error("Router service unavailable");
    return state.zlibService.getFavorites(input?.forceRefresh === true);
  });

  ipc.handle("router:history", async (_win, input?: { forceRefresh?: boolean }) => {
    if (!state.zlibService) throw new Error("Router service unavailable");
    return state.zlibService.getHistory(input?.forceRefresh === true);
  });

  ipc.handle("router:download-history-page", async (_win, input: { page: number; forceRefresh?: boolean }) => {
    if (!state.zlibService) throw new Error("书源服务尚未就绪。");
    const history = await state.zlibService.getDownloadHistoryPage(input.page, input.forceRefresh === true);
    const localRefs = await state.downloadedCovers.localHistoryRefs(history.books);
    const books = history.books.map(book => {
      const format = book.extension.trim().toLowerCase().replace(/^\./, "");
      if (format && !BOOK_FILE_EXTENSIONS.includes(format)) {
        return { ...book, unavailableReason: `书库暂不支持 ${format.toUpperCase()} 格式` };
      }
      return book;
    });
    return { books, hasMore: history.hasMore, localRefs };
  });

  ipc.handle("router:download-history-book", (_win, input: { bookRef: string; hint?: DownloadCoverHint }) =>
    state.downloadedCovers.downloadHistoryBook(input.bookRef, input.hint));

  ipc.handle("router:download", async (_win, input: { bookRef: string; hint?: DownloadCoverHint }) => {
    return state.downloadedCovers.download(input.bookRef, input.hint);
  });

  ipc.handle("router:import-local-books", async (win, mode: "files" | "directory") => {
    if (!state.zlibService) throw new Error("本地书库尚未就绪。");
    if (mode !== "files" && mode !== "directory") throw new Error("无效的导入方式。");
    const choice = await dialog.showOpenDialog(win, mode === "files" ? {
      title: "选择要导入的电子书", buttonLabel: "导入", properties: ["openFile", "multiSelections"],
      filters: [{ name: "电子书", extensions: BOOK_FILE_EXTENSIONS }],
    } : { title: "选择包含电子书的文件夹", buttonLabel: "导入文件夹", properties: ["openDirectory"] });
    if (choice.canceled || !choice.filePaths.length) return importResult(true);
    return importSelectedBooks(state.zlibService.getDownloadDir(), mode, choice.filePaths, state.downloadedCovers);
  });

  ipc.handle("router:import-book-text", (_win, input: { title: string; text: string }) => {
    if (!state.zlibService) throw new Error("本地书库尚未就绪。");
    return importBookText(state.zlibService.getDownloadDir(), input, state.downloadedCovers);
  });

  ipc.handle("router:list-downloaded-books", () => {
    if (!state.zlibService) throw new Error("下载目录尚未就绪。");
    return listDownloadedBooks(state.zlibService.getDownloadDir());
  });

  ipc.handle("reader:open", (_win, filePath: string) => {
    if (!state.zlibService) throw new Error("下载目录尚未就绪。");
    return openReaderBook(requireDb(), state.zlibService.getDownloadDir(), filePath);
  });

  ipc.handle("reader:get-translation-settings", () => state.readerTranslationSettings.readPublic());
  ipc.handle("reader:save-translation-settings", (_win, input: ReaderTranslationSettingsInput) => state.readerTranslationSettings.save(input));
  ipc.handle("reader:open-deepl-portal", () => shell.openExternal("https://www.deepl.com/your-account/keys"));
  ipc.handle("reader:translate", (win, input: ReaderTranslationInput) => state.readerTranslations.translate(win.id, input));
  ipc.handle("reader:cached-translations", (_win, input: ReaderTranslationInput) => state.readerTranslations.readCached(input));
  ipc.handle("reader:cancel-translation", (win, requestId: string) => state.readerTranslations.cancel(win.id, requestId));

  ipc.handle("reader:save-location", (_win, documentId: string, cfi: string) =>
    requireDb().saveReaderLocation(documentId, cfi));

  ipc.handle("reader:add-annotation", (_win, input: ReaderAnnotationInput) =>
    requireDb().addReaderAnnotation(input));

  ipc.handle("reader:remove-annotation", (_win, documentId: string, highlightId: string) =>
    requireDb().removeReaderAnnotation(documentId, highlightId));

  ipc.handle("reader:resolve-highlight", (_win, id: string) => {
    if (!state.zlibService) throw new Error("下载目录尚未就绪。");
    return resolveReaderHighlight(requireDb(), state.zlibService.getDownloadDir(), id);
  });

  ipc.handle("router:get-downloaded-book-cover", async (_win, filePath: string) => {
    return state.downloadedCovers.preview(filePath);
  });

  ipc.handle("router:open-downloaded-book", async (_win, filePath: string) => {
    if (!state.zlibService) throw new Error("下载目录尚未就绪。");
    const book = await resolveDownloadedBook(state.zlibService.getDownloadDir(), filePath);
    const error = await shell.openPath(book);
    if (error) throw new Error(`打开电子书失败：${error}`);
  });

  ipc.handle("router:open-download-dir", async (_win, filePath?: string) => {
    if (!state.zlibService) throw new Error("Router service unavailable");
    const rootDir = path.resolve(state.zlibService.getDownloadDir());
    fs.mkdirSync(rootDir, { recursive: true });
    if (typeof filePath === "string" && filePath.trim()) {
      const candidate = path.resolve(filePath.trim());
      if (candidate.startsWith(rootDir + path.sep) && fs.existsSync(candidate)) {
        shell.showItemInFolder(candidate);
        return { opened: true, path: candidate };
      }
    }
    const err = await shell.openPath(rootDir);
    if (err) throw new Error(err);
    return { opened: true, path: rootDir };
  });

  ipc.handle("router:pick-ebook-file", async (win) => {
    const res = await dialog.showOpenDialog(win, {
      title: "选择本地电子书文件（EPUB / PDF / MOBI / AZW3）",
      properties: ["openFile"],
      filters: [{ name: "电子书文件", extensions: ROUTER_EBOOK_EXTENSIONS }],
    });
    if (res.canceled || !res.filePaths[0]) {
      return { canceled: true as const, filePath: "" };
    }
    return { canceled: false as const, filePath: res.filePaths[0] };
  });

  ipc.handle("router:send-kindle", async (_win, filePath: string) => {
    if (state.kindleStore?.readPublic().configured) {
      return sendBookViaKindleSmtp(state.kindleStore.readRaw(), filePath);
    }
    if (!state.zlibService) throw new Error("请先在「连接与偏好」完成 Kindle 推送配置");
    return state.zlibService.sendToKindle(filePath);
  });

  ipc.handle("router:import-weread", async (_win, filePath: string, options?: { fromLibrary?: boolean }) => {
    if (!state.zlibService) throw new Error("微信读书导入尚未就绪，请稍后重试。");
    return state.zlibService.importToWeRead(filePath, options);
  });

  ipc.handle("router:meta-read", async (_win, filePath: string) => {
    if (!state.zlibService) throw new Error("Router service unavailable");
    return state.zlibService.readLocalBookMeta(filePath);
  });

  ipc.handle("router:meta-fetch", async (_win, input: { filePath: string; sources?: string[] }) => {
    if (!state.zlibService) throw new Error("Router service unavailable");
    return state.zlibService.fetchLocalBookMetaMatches(input.filePath, input.sources);
  });

  ipc.handle(
    "router:meta-apply",
    async (
      _win,
      input: {
        filePath: string;
        title?: string;
        authors?: string;
        publisher?: string;
        isbn?: string;
        date?: string;
        language?: string;
        tags?: string;
        comments?: string;
        rename?: boolean;
      },
    ) => {
      if (!state.zlibService) throw new Error("Router service unavailable");
      const { filePath, ...patch } = input;
      const service = state.zlibService;
      return updateReaderMetadata(requireDb(), service.getDownloadDir(), filePath, file => service.applyLocalBookMeta(file, patch),
        (file, hash) => state.downloadedCovers.rememberCoverBeforeMetadataEdit(file, hash));
    },
  );
}
