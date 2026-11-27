import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BookRecord,
  BrowserStateSnapshot,
  DownloadedBookFile,
  DraftRecord,
  NotebookItemKind,
  NotebookRecord,
  PublicModelSettings,
  SafetyMode,
} from "./types/desktop";
import { BrowserPane } from "./components/BrowserPane";
import { CookieImportModal } from "./components/CookieImportModal";
import { DiscoverView, WEREAD_SHELF_URL } from "./components/DiscoverView";
import { DownloadedBooksView } from "./components/DownloadedBooksView";
import { useDownloadedBooks } from "./hooks/useDownloadedBooks";
import { useAppTheme } from "./hooks/useAppTheme";
import { useBrowserNavigation } from "./hooks/useBrowserNavigation";
import { useWorkspaceLayout } from "./hooks/useWorkspaceLayout";
import { useToasts } from "./hooks/useToasts";
import { ZlibHistoryImport } from "./components/ZlibHistoryImport";
import type { ContextAttachment } from "./components/DockedAskBar";
import {
  IconBookOpen,
  IconCompass,
  IconPenLine,
  IconSearch,
  IconSquarePen,
} from "./components/Icons";
import { LeftWorkspace, type PendingPromptPayload } from "./components/LeftWorkspace";
import { LibraryView } from "./components/LibraryView";
import { LocalReader } from "./components/LocalReader";
import { NotebookView } from "./components/NotebookView";
import { RouterView } from "./components/RouterView";
import { SettingsModal } from "./components/SettingsModal";
import { StudioView } from "./components/StudioView";
import { PullCordLamp } from "./components/ui/pull-cord-lamp";
import { SurfRail, type SurfRailNavItem } from "./components/SurfRail";
import { WorkspaceTopbar } from "./components/WorkspaceTopbar";
import {
  buildNotebookPromptSummary, DEFAULT_AI_WIDTH, DEFAULT_RAIL_WIDTH, isStartPageTabUrl, TAB_LABELS, type StudioTab,
} from "./app/workspace";
import { cleanQuoteDraftTitle, prepareDraftFromAssistantReply } from "./lib/draftCleanup";
import { formatUserError } from "./utils/formatError";

export const App: React.FC = () => {
  const [activeTab, setWorkspaceTab] = useState<StudioTab>("discover");
  const [readerTabs, setReaderTabs] = useState<Array<DownloadedBookFile & { title?: string }>>([]);
  const [readerTarget, setReaderTarget] = useState<{ file: DownloadedBookFile; cfi?: string } | null>(null);
  const reading = readerTarget !== null;
  const readerPath = readerTarget?.file.filePath;
  const readerTitle = readerTabs.find(tab => tab.filePath === readerPath)?.title
    || readerTarget?.file.fileName.replace(/\.epub$/i, "") || "";
  const updateReaderTitle = useCallback((title: string) => {
    if (title) setReaderTabs(tabs => tabs.map(tab => tab.filePath === readerPath ? { ...tab, title } : tab));
  }, [readerPath]);
  const setActiveTab = useCallback((tab: StudioTab) => {
    setReaderTarget(null);
    setWorkspaceTab(tab);
  }, []);
  const { theme, lampPulse, lampDockRef, handleLampThemeChange } = useAppTheme();
  const [routerInitialSection, setRouterInitialSection] = useState<"twin" | "obsidian" | "router">("router");
  const [modelSettings, setModelSettings] = useState<PublicModelSettings | null>(null);
  const [safetyMode, setSafetyMode] = useState<SafetyMode>("confirm");
  const [browserState, setBrowserState] = useState<BrowserStateSnapshot | null>(null);

  // Surf layout visibility & resizable widths
  const {
    railOpen, setRailOpen, railWidth, setRailWidth, workspaceOpen, setWorkspaceOpen, browserOpen, setBrowserOpen,
    aiOpen, setAiOpen, aiWidth, setAiWidth, leftWidth, effectiveLeftWidth, resetLeftWidth, railDrag, splitDrag, aiDrag,
  } = useWorkspaceLayout();

  const [petVisible, setPetVisible] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [cookieModalOpen, setCookieModalOpen] = useState(false);
  const [childModalOpen, setChildModalOpen] = useState(false);
  const [historyImportOpen, setHistoryImportOpen] = useState(false);

  // Shared library + draft + Surf notebook summaries
  const [books, setBooks] = useState<BookRecord[]>([]);
  const [drafts, setDrafts] = useState<DraftRecord[]>([]);
  const [notebooks, setNotebooks] = useState<NotebookRecord[]>([]);
  const [activeNotebookId, setActiveNotebookId] = useState<string | null>(null);
  const [selectedBookId, setSelectedBookId] = useState<string | null>(null);
  const [libraryMode, setLibraryMode] = useState<"shelf" | "collision">("shelf");
  const [libraryMenuCommand, setLibraryMenuCommand] = useState<
    { kind: "new-book" | "import-notes"; nonce: number } | null
  >(null);
  const clearLibraryMenuCommand = useCallback(() => setLibraryMenuCommand(null), []);


  // Cross-view handoff states
  const [pendingPrompt, setPendingPrompt] = useState<PendingPromptPayload | null>(null);
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [libraryRefreshSignal, setLibraryRefreshSignal] = useState(0);

  const { notify, stack: toastStack } = useToasts(() => {
    setRouterInitialSection("obsidian");
    setActiveTab("router");
    setWorkspaceOpen(true);
  });
  const {
    files: downloadFiles, loading: downloadsLoading, error: downloadError, weReadImports,
    refresh: refreshDownloads, importToWeRead: importDownloadedToWeRead,
  } = useDownloadedBooks(notify);

  const openWorkspaceTab = (tab: StudioTab) => {
    if (tab === "library") void refreshDownloads();
    setActiveTab(tab);
    setWorkspaceOpen(true);
  };

  async function handleBookMetadataChanged(previousPath: string, updatedPath: string, title: string) {
    const files = await refreshDownloads();
    const file = files?.find(item => item.filePath === updatedPath);
    if (!file) return;
    setReaderTabs(tabs => tabs.map(tab => tab.filePath === previousPath ? { ...file, title } : tab));
    setReaderTarget(current => current?.file.filePath === previousPath ? { file } : current);
  }

  function readLocalBook(file: DownloadedBookFile, cfi?: string) {
    setReaderTabs(tabs => tabs.some(tab => tab.filePath === file.filePath) ? tabs : [...tabs, file]);
    setReaderTarget({ file, cfi });
  }

  async function openHighlightInBook(id: string) {
    try {
      const { file, cfi } = await window.diandian.reader.resolveHighlight(id);
      readLocalBook(file, cfi);
    } catch (error) {
      notify(formatUserError(error, "无法定位这条划线的原文"), "error");
    }
  }

  const refreshWorkspaceData = useCallback(async () => {
    try {
      const [bookList, draftList, nbList] = await Promise.all([
        window.diandian.library.listBooks(""),
        window.diandian.drafts.list(),
        window.diandian.notebooks.list(),
      ]);
      setBooks(bookList);
      setDrafts(draftList);
      setNotebooks(nbList);
      setSelectedBookId((prev) => {
        if (prev && bookList.some((b) => b.id === prev)) return prev;
        return bookList[0]?.id ?? null;
      });
      setActiveDraftId((prev) => {
        if (prev && draftList.some((d) => d.id === prev)) return prev;
        return draftList[0]?.id ?? null;
      });
      setActiveNotebookId((prev) => {
        if (prev && nbList.some((n) => n.id === prev)) return prev;
        return nbList[0]?.id ?? null;
      });
    } catch {
      // Ignore transient load error during boot
    }
  }, []);

  useEffect(() => {
    void refreshWorkspaceData();
  }, [refreshWorkspaceData, libraryRefreshSignal]);

  const handleSendQuoteToDraft = useCallback(
    async (data: { quote: string; comment?: string; bookTitle?: string; author?: string }) => {
      const cleanQuote = data.quote.trim();
      const title = cleanQuoteDraftTitle(data.bookTitle, cleanQuote);
      const rawBookLabel = (data.bookTitle || "").trim();
      const showBookHeader = rawBookLabel && !/^(微信读书|豆瓣读书|小红书|微信公众号|新标签页)$/i.test(rawBookLabel);
      const lines = [
        showBookHeader ? `## 摘自《${rawBookLabel}》${data.author ? ` · ${data.author}` : ""}` : "## 读书摘录",
        "",
        `> ${cleanQuote}`,
        "",
      ];
      if (data.comment?.trim()) {
        lines.push("## 我的批注", "", data.comment.trim(), "");
      } else {
        lines.push("## 我的思考", "", "在这里写下你的延伸观点或亲身经历…", "");
      }
      try {
        const created = await window.diandian.drafts.create({
          title,
          kind: "thread",
          authorKind: "human",
          content: lines.join("\n"),
          promptSummary: "从书摘一键写入草稿",
        });
        await refreshWorkspaceData();
        setActiveDraftId(created.id);
        setActiveTab("studio");
        setWorkspaceOpen(true);
        notify("已将这段摘录写入创作草稿", "success");
      } catch (error) {
        notify(error instanceof Error ? error.message : "写入草稿失败", "error");
      }
    },
    [notify, refreshWorkspaceData],
  );

  useEffect(() => {
    void window.diandian.settings.getModel().then(setModelSettings);
    void window.diandian.safety.getMode().then((res) => setSafetyMode(res.mode));
    void window.diandian.browser.getState().then(setBrowserState);
    void window.diandian.pet.getState().then((st) => setPetVisible(st.visible));
    const offBrowser = window.diandian.browser.onStateChanged(setBrowserState);
    const offPet = window.diandian.pet.onStateChanged((st) => setPetVisible(st.visible));
    const offConn = window.diandian.router.onConnectionsChanged((ev) => {
      if (ev.autoSynced && ev.snapshot.zlib.loggedIn) {
        notify(
          `检测到右侧 Z-Library 登录成功，已自动同步书源连接（${ev.origin || ev.snapshot.zlib.currentDomain}）`,
          "success",
        );
      }
    });
    const offQuick = window.diandian.app.onQuickAction((ev) => {
      if (ev.kind === "saved") {
        setLibraryRefreshSignal((n) => n + 1);
        notify(
          ev.deduplicated
            ? `该划线已在《${ev.title}》中，已自动去重`
            : `已存入《${ev.title}》的阅读笔记`,
          "success",
        );
      } else if (ev.kind === "draft") {
        void handleSendQuoteToDraft({
          quote: ev.text,
          comment: ev.comment ?? "",
          bookTitle: ev.title,
          author: ev.author ?? "",
        });
      } else if (ev.kind === "ask") {
        // Like every other "问点点" entry: prefill the composer, the user edits or sends it.
        setPendingPrompt({
          text: `关于《${ev.title}》中我选中的这段话：\n\n「${ev.text}」\n\n请帮我深度解读并给一个延伸反问。`,
        });
        setAiOpen(true);
      }
    });
    return () => {
      offBrowser();
      offPet();
      offConn();
      offQuick();
    };
  }, [notify, handleSendQuoteToDraft]);

  // Native app menu (文件 / 偏好设置) → existing renderer actions.
  const selectedBookIdRef = useRef(selectedBookId);
  selectedBookIdRef.current = selectedBookId;
  useEffect(() => {
    return window.diandian.app.onMenuAction(({ action }) => {
      if (action === "preferences") {
        setRouterInitialSection("router");
        setActiveTab("router");
        setWorkspaceOpen(true);
      } else if (action === "new-book" || action === "import-notes") {
        setActiveTab("library");
        setLibraryMode("shelf");
        setWorkspaceOpen(true);
        setLibraryMenuCommand({ kind: action, nonce: Date.now() });
      } else if (action === "sync-obsidian") {
        const bookId = selectedBookIdRef.current;
        if (!bookId) {
          setActiveTab("library");
          setWorkspaceOpen(true);
          notify("请先在「我的书库」中选中一本书，再同步到 Obsidian", "info");
          return;
        }
        void window.diandian.obsidian
          .exportBook(bookId)
          .then((res) => notify(res.message, res.status === "conflict" ? "info" : "success"))
          .catch((error: unknown) => notify(error instanceof Error ? error.message : "同步到 Obsidian 失败", "error"));
      } else if (action === "open-downloads") {
        void window.diandian.router
          .openDownloadDir()
          .catch((error: unknown) => notify(error instanceof Error ? error.message : "打开下载目录失败", "error"));
      }
    });
  }, [notify]);

  // Native WebContentsView always sits above HTML overlays; suppress whenever ANY modal opens.
  useEffect(() => {
    void window.diandian.browser.setSuppressed(reading || settingsOpen || cookieModalOpen || childModalOpen || historyImportOpen);
  }, [reading, settingsOpen, cookieModalOpen, childModalOpen, historyImportOpen]);

  // Sync browser visibility when user toggles collapse/expand.
  useEffect(() => {
    void window.diandian.browser.setVisible(browserOpen);
  }, [browserOpen]);

  // Keyboard shortcuts: Cmd/Ctrl + \ toggles right browser, Cmd/Ctrl + B toggles left rail,
  // Cmd/Ctrl + Shift + B toggles left workspace (focus reading mode), Cmd/Ctrl + L toggles AI drawer
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        if (reading) {
          setReaderTarget(null);
          setBrowserOpen(true);
          return;
        }
        setBrowserOpen((v) => {
          if (v) setWorkspaceOpen(true);
          return !v;
        });
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        if (reading) {
          setReaderTarget(null);
          setWorkspaceOpen(true);
          return;
        }
        setWorkspaceOpen((v) => (browserOpen ? !v : true));
      } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setRailOpen((v) => !v);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "l") {
        e.preventDefault();
        setAiOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [browserOpen, reading]);

  const handleSaveReplyAsDraft = async (content: string): Promise<string | null> => {
    const activeTabNow = browserState?.tabs.find((t) => t.id === browserState.activeTabId) ?? null;
    const prepared = prepareDraftFromAssistantReply(content, {
      bookHint: readerTarget ? readerTitle : selectedBook?.title ?? null,
      pageTitle: !readerTarget && activeTabNow && !isStartPageTabUrl(activeTabNow.url) ? activeTabNow.title : null,
    });
    const matchedBook = prepared.bookTitle
      ? books.find(
          (b) =>
            b.title === prepared.bookTitle
            || b.title.includes(prepared.bookTitle!)
            || prepared.bookTitle!.includes(b.title),
        )
      : undefined;
    try {
      const created = await window.diandian.drafts.create({
        title: prepared.title,
        kind: prepared.kind,
        ...(matchedBook ? { bookId: matchedBook.id } : {}),
        authorKind: "ai",
        content: prepared.content,
        promptSummary: "从共读对话一键沉淀（已自动去除对话寒暄）",
      });
      setActiveDraftId(created.id);
      setActiveTab("studio");
      setWorkspaceOpen(true);
      void refreshWorkspaceData();
      notify(`已存入创作工作台：《${created.title}》`, "success");
      return created.id;
    } catch (error) {
      notify(error instanceof Error ? error.message : "保存草稿失败", "error");
      return null;
    }
  };

  const handleOpenDraftFromChat = (draftId: string) => {
    setActiveDraftId(draftId);
    setActiveTab("studio");
    setWorkspaceOpen(true);
  };

  const handleSelectSafety = useCallback(
    async (mode: SafetyMode) => {
      try {
        const res = await window.diandian.safety.setMode(mode);
        setSafetyMode(res.mode);
        const label = res.mode === "plan" ? "只读规划" : res.mode === "auto" ? "全自动工作流" : "安全确认";
        notify(`工具执行守卫已切换为「${label}」（实时生效）`, "success");
      } catch (error) {
        notify(error instanceof Error ? error.message : "切换安全模式失败", "error");
      }
    },
    [notify],
  );

  const handleSelectModel = useCallback(
    async (nextModelId: string) => {
      if (!modelSettings) return;
      const trimmed = nextModelId.trim();
      if (!trimmed || trimmed === modelSettings.model) return;
      try {
        const saved = await window.diandian.settings.saveModel({
          provider: modelSettings.provider,
          model: trimmed,
          baseUrl: modelSettings.baseUrl,
        });
        setModelSettings(saved);
        notify(`已切换模型为 ${saved.model}`, "success");
      } catch (error) {
        notify(error instanceof Error ? error.message : "切换模型失败", "error");
      }
    },
    [modelSettings, notify],
  );

  const handleSendToChat = (prompt: string, autoSend = false, standalone = false) => {
    setPendingPrompt({ text: prompt, autoSend, standalone });
    setAiOpen(true);
  };

  const {
    openUrl: handleOpenBrowserUrl, openSiteUrl: handleOpenSiteUrl, openQuickSite: handleOpenQuickSite,
  } = useBrowserNavigation({
    browserState,
    showBrowser: () => {
      setReaderTarget(null);
      setBrowserOpen(true);
    },
    notify,
  });

  const selectedBook = useMemo(
    () => books.find((b) => b.id === selectedBookId) ?? null,
    [books, selectedBookId],
  );

  const selectedDraft = useMemo(
    () => drafts.find((d) => d.id === activeDraftId) ?? null,
    [drafts, activeDraftId],
  );

  const selectedNotebook = useMemo(
    () => notebooks.find((n) => n.id === activeNotebookId) ?? null,
    [notebooks, activeNotebookId],
  );

  const handleCreateNotebook = async (name: string): Promise<boolean> => {
    try {
      const created = await window.diandian.notebooks.create({ name, icon: "✦" });
      await refreshWorkspaceData();
      setActiveNotebookId(created.id);
      setActiveTab("notebook");
      setWorkspaceOpen(true);
      notify(`已新建主题空间「${created.name}」`, "success");
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : "新建主题空间失败", "error");
      return false;
    }
  };

  const handleAddNotebookItem = async (
    notebookId: string,
    item: { itemKind: NotebookItemKind; itemRef: string; title: string; meta?: string },
  ) => {
    try {
      await window.diandian.notebooks.addItem({ notebookId, ...item });
      await refreshWorkspaceData();
      notify(`已将「${item.title}」收入主题空间`, "success");
    } catch (error) {
      notify(error instanceof Error ? error.message : "添加素材失败", "error");
    }
  };

  const handleRemoveNotebookItem = async (notebookId: string, itemId: string) => {
    try {
      await window.diandian.notebooks.removeItem(notebookId, itemId);
      await refreshWorkspaceData();
    } catch (error) {
      notify(error instanceof Error ? error.message : "移除失败", "error");
    }
  };

  const handleDeleteNotebook = async (notebookId: string) => {
    try {
      await window.diandian.notebooks.delete(notebookId);
      await refreshWorkspaceData();
      setActiveTab("discover");
      notify("主题空间已删除", "info");
    } catch (error) {
      notify(error instanceof Error ? error.message : "删除失败", "error");
    }
  };

  const breadcrumbDetail = useMemo(() => {
    if (activeTab === "notes") {
      return libraryMode === "collision" ? "跨书观点碰撞" : selectedBook?.title || null;
    }
    if (activeTab === "studio") {
      return selectedDraft?.title || "草稿箱";
    }
    if (activeTab === "notebook") {
      return selectedNotebook?.name || "主题空间";
    }
    return null;
  }, [activeTab, libraryMode, selectedBook?.title, selectedDraft?.title, selectedNotebook?.name]);

  const activeBrowserTab = useMemo(
    () => browserState?.tabs.find((t) => t.id === browserState.activeTabId) ?? null,
    [browserState?.tabs, browserState?.activeTabId],
  );

  // Dynamic Surf-style "Active Context" chip automatically attached inside the AI drawer
  const autoContext = useMemo<ContextAttachment | null>(() => {
    if (readerTarget) {
      return { id: `reader:${readerTarget.file.filePath}`, kind: "reader", label: `《${readerTitle}》` };
    }
    if (workspaceOpen && activeTab === "notebook" && selectedNotebook) {
      return {
        id: `notebook:${selectedNotebook.id}`,
        kind: "notebook",
        label: `主题：${selectedNotebook.name.slice(0, 14)} (${selectedNotebook.items.length})`,
        promptSummary: buildNotebookPromptSummary(selectedNotebook),
      };
    }
    if (workspaceOpen && activeTab === "studio" && selectedDraft) {
      return {
        id: `draft:${selectedDraft.id}`,
        kind: "draft",
        label: `草稿：${selectedDraft.title.slice(0, 16)}`,
      };
    }
    if (workspaceOpen && activeTab === "notes" && selectedBook) {
      return {
        id: `book:${selectedBook.id}`,
        kind: "book",
        label: `《${selectedBook.title.slice(0, 15)}》`,
      };
    }
    if (browserOpen && activeBrowserTab && !isStartPageTabUrl(activeBrowserTab.url)) {
      const cleanedTitle = (activeBrowserTab.title || "阅读页")
        .replace(/\s*[-–—|]\s*(微信读书|WeRead|豆瓣读书|豆瓣|小红书|知乎|哔哩哔哩).*$/i, "")
        .replace(/^《|》$/g, "")
        .split(/\s+[-–—]\s+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 2)
        .join(" · ");
      const compactTitle =
        cleanedTitle.length > 20 ? `${cleanedTitle.slice(0, 19).replace(/[·\-—\s]+$/, "")}…` : cleanedTitle;
      return {
        id: `web:${activeBrowserTab.id}`,
        kind: "web",
        label: `当前页：${compactTitle || "阅读页"}`,
        meta: activeBrowserTab.url,
      };
    }
    return null;
  }, [
    readerTarget,
    readerTitle,
    workspaceOpen,
    activeTab,
    selectedNotebook,
    selectedDraft,
    selectedBook,
    browserOpen,
    activeBrowserTab,
  ]);

  const navItems: SurfRailNavItem[] = [
    { id: "discover", label: "搜书发现", icon: <IconSearch size={15} /> },
    { id: "library", label: TAB_LABELS.library, icon: <IconBookOpen size={15} />, count: downloadError ? undefined : downloadFiles?.length },
    { id: "notes", label: TAB_LABELS.notes, icon: <IconSquarePen size={15} />, count: books.length || undefined },
    { id: "studio", label: "创作草稿", icon: <IconPenLine size={15} />, count: drafts.length || undefined },
    { id: "router", label: "连接与偏好", icon: <IconCompass size={15} /> },
  ];


  return (
    <div className="app-shell">
      {/* 1. Far-Left Resizable Frosted Cloud-Blue Surf Sidebar */}
      {railOpen && (
        <SurfRail
          width={railWidth}
          drag={railDrag}
          onResetWidth={() => setRailWidth(DEFAULT_RAIL_WIDTH)}
          navItems={navItems}
          activeTab={!reading && workspaceOpen ? activeTab : null}
          onOpenTab={openWorkspaceTab}
          notebooks={notebooks}
          activeNotebookId={!reading && workspaceOpen && activeTab === "notebook" ? activeNotebookId : null}
          onSelectNotebook={(id) => {
            setActiveNotebookId(id);
            setActiveTab("notebook");
            setWorkspaceOpen(true);
          }}
          onCreateNotebook={handleCreateNotebook}
          readerTabs={readerTabs}
          currentReaderPath={readerTarget?.file.filePath ?? null}
          onReadBook={(file) => readLocalBook(file)}
          onCloseReaderTab={(file) => {
            setReaderTabs(tabs => tabs.filter(tab => tab.filePath !== file.filePath));
            if (readerTarget?.file.filePath === file.filePath) openWorkspaceTab("library");
          }}
          browserState={browserState}
          currentBrowserTabId={!reading && browserOpen ? browserState?.activeTabId ?? null : null}
          onSelectBrowserTab={(id) => {
            setReaderTarget(null);
            setBrowserOpen(true);
            void window.diandian.browser.selectTab(id);
          }}
          onCloseBrowserTab={(id) => void window.diandian.browser.closeTab(id)}
          onNewBrowserTab={() => void handleOpenBrowserUrl(undefined, true)}
          onOpenQuickSite={(site) => void handleOpenQuickSite(site)}
          petVisible={petVisible}
          onTogglePet={() => void window.diandian.pet.toggle()}
          onOpenModelSettings={() => setSettingsOpen(true)}
        />
      )}

      {/* 2. Main Split Stage */}
      <main className={`main-stage ${railOpen ? "" : "rail-collapsed"} ${aiOpen ? "ai-open" : ""}`}>
        <div
          className={`workspace-column ${browserOpen ? "" : "full-width"}`}
          style={{
            display: workspaceOpen && !reading ? "flex" : "none",
            ...(browserOpen ? { width: `${effectiveLeftWidth}px`, flex: "0 0 auto" } : {}),
          }}
        >
          <WorkspaceTopbar
            railOpen={railOpen}
            browserOpen={browserOpen}
            aiOpen={aiOpen}
            activeTab={activeTab}
            breadcrumbDetail={breadcrumbDetail}
            onToggleRail={() => setRailOpen((v) => !v)}
            onSelectTab={setActiveTab}
            onCollapseWorkspace={() => setWorkspaceOpen(false)}
            onOpenBrowser={() => setBrowserOpen(true)}
            onOpenAi={() => setAiOpen(true)}
          />

          {/* Body Row: Full-Width Active Canvas */}
          <div className="surf-body-row">
            <div className="surf-canvas-shell">
              {/* Warm Tungsten Aura Bloom Synchronized With Lamp Toggle */}
              {lampPulse && (
                <div
                  key={lampPulse.id}
                  className={`lamp-light-burst ${lampPulse.mode === "on" ? "is-on" : "is-off"}`}
                  aria-hidden="true"
                />
              )}

              {/* Ceiling-Mounted Tactile Pull-Cord Reading Lamp (Light <-> Dark Theme Switch) */}
              <div
                ref={lampDockRef}
                className="theme-lamp-dock"
                title={theme === "light" ? "拉绳关灯 · 切换暗黑夜读模式" : "拉绳开灯 · 切换云蓝白昼模式"}
              >
                <PullCordLamp
                  size="fill"
                  shade="dome"
                  bulb="clear"
                  finish="theme"
                  cord={0.85}
                  warmth={2650}
                  sound
                  on={theme === "light"}
                  onChange={handleLampThemeChange}
                  label={theme === "light" ? "拉绳关灯切换夜间模式" : "拉绳开灯切换白昼模式"}
                />
              </div>

              <div style={{ display: activeTab === "discover" ? "flex" : "none", flexDirection: "column", height: "100%" }}>
                <DiscoverView
                  onDownloadComplete={refreshDownloads}
                  onBookMetadataChanged={handleBookMetadataChanged}
                  onOpenDownloadLibrary={() => openWorkspaceTab("library")}
                  onSendToChat={(prompt, autoSend) => handleSendToChat(prompt, autoSend)}
                  onOpenBrowserUrl={(url, newTab) => void handleOpenBrowserUrl(url, newTab)}
                  onOpenSiteUrl={(url) => void handleOpenSiteUrl(url)}
                  onEnsureBrowserOpen={() => setBrowserOpen(true)}
                  onOpenRouterSettings={() => {
                    setRouterInitialSection("router");
                    setActiveTab("router");
                  }}
                  onNotify={notify}
                />
              </div>

              {activeTab === "library" && (
                <DownloadedBooksView
                  onRead={readLocalBook}
                  files={downloadFiles ?? []}
                  loading={downloadsLoading}
                  error={downloadError}
                  onRefresh={refreshDownloads}
                  onDiscover={() => setActiveTab("discover")}
                  onOpenHistoryImport={() => setHistoryImportOpen(true)}
                  imports={weReadImports}
                  onImport={importDownloadedToWeRead}
                  onOpenWeReadShelf={() => void handleOpenBrowserUrl(WEREAD_SHELF_URL)}
                  onOpenConnections={() => {
                    setRouterInitialSection("router");
                    openWorkspaceTab("router");
                  }}
                  onNotify={notify}
                />
              )}

              {activeTab === "notes" && (
                <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
                  <LibraryView
                    onOpenOriginal={openHighlightInBook}
                    refreshSignal={libraryRefreshSignal}
                    selectedBookId={selectedBookId}
                    onSelectBookId={setSelectedBookId}
                    viewMode={libraryMode}
                    onViewModeChange={setLibraryMode}
                    onDataChanged={() => void refreshWorkspaceData()}
                    onModalToggle={setChildModalOpen}
                    onSendToChat={(p, options) => handleSendToChat(p, false, options?.standalone)}
                    onSendToDraft={(data) => void handleSendQuoteToDraft(data)}
                    onNotify={notify}
                    menuCommand={libraryMenuCommand}
                    onMenuCommandHandled={clearLibraryMenuCommand}
                  />
                </div>
              )}

              {activeTab === "studio" && (
                <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
                  <StudioView
                    activeDraftId={activeDraftId}
                    onSelectDraftId={setActiveDraftId}
                    onDataChanged={() => void refreshWorkspaceData()}
                    onModalToggle={setChildModalOpen}
                    onSendToChat={(p) => handleSendToChat(p, false)}
                    onOpenBrowserUrl={(url) => void handleOpenBrowserUrl(url)}
                    onNotify={notify}
                  />
                </div>
              )}

              {activeTab === "notebook" && selectedNotebook && (
                <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
                  <NotebookView
                    notebook={selectedNotebook}
                    books={books}
                    drafts={drafts}
                    activeBrowserTab={activeBrowserTab}
                    onAddItem={handleAddNotebookItem}
                    onRemoveItem={handleRemoveNotebookItem}
                    onDeleteNotebook={handleDeleteNotebook}
                    onOpenBook={(bookId) => {
                      setSelectedBookId(bookId);
                      setLibraryMode("shelf");
                      setActiveTab("notes");
                    }}
                    onOpenDraft={(draftId) => {
                      setActiveDraftId(draftId);
                      setActiveTab("studio");
                    }}
                    onOpenWebUrl={(url) => void handleOpenBrowserUrl(url, false)}
                    onAskNotebook={(nb) => {
                      handleSendToChat(
                        `请基于主题空间「${nb.name}」的关联素材：\n${buildNotebookPromptSummary(nb)}\n\n帮我做一次跨书与跨素材的结构化整合，梳理核心共识、矛盾观点，并给出一个适合写成深度长文或小红书干货的切入角度。`,
                        false,
                      );
                    }}
                  />
                </div>
              )}

              {activeTab === "router" && (
                <RouterView
                  initialSection={routerInitialSection}
                  onBookMetadataChanged={handleBookMetadataChanged}
                  onModalToggle={setChildModalOpen}
                  onEnsureBrowserOpen={() => setBrowserOpen(true)}
                  onNotify={notify}
                />
              )}
            </div>
          </div>
        </div>

        {/* 3. Right Native Split Browser (38px matching chrome) */}
        {readerTarget && (
          <LocalReader
            key={readerTarget.file.filePath}
            file={readerTarget.file}
            railOpen={railOpen}
            onToggleRail={() => setRailOpen(open => !open)}
            modelSettings={modelSettings}
            onOpenModelSettings={() => setSettingsOpen(true)}
            initialLocator={readerTarget.cfi}
            onTitle={updateReaderTitle}
            onBack={() => openWorkspaceTab("library")}
            onAsk={(quote, title) => handleSendToChat(`我在读《${title}》时选中了这段话：\n\n「${quote}」\n\n请帮我解读这段话。`, false)}
            onNotesChanged={() => setLibraryRefreshSignal(n => n + 1)}
          />
        )}
        {browserOpen && !reading && (
          <>
            {workspaceOpen && (
              <div
                {...splitDrag.handleProps(leftWidth)}
                className={`split-handle ${splitDrag.dragging ? "dragging" : ""}`}
                onDoubleClick={resetLeftWidth}
                title="拖动调整左右宽度（拖至最左收起工作台，拖至最右收起阅读窗，双击重置）"
              />
            )}
            <BrowserPane
              browserState={browserState}
              layoutKey={
                (workspaceOpen ? effectiveLeftWidth : 1) +
                (railOpen ? railWidth * 100 : 0) +
                (aiOpen ? aiWidth * 10000 : 0) +
                (workspaceOpen ? 0 : 7777777)
              }
              railOpen={railOpen}
              workspaceOpen={workspaceOpen}
              aiOpen={aiOpen}
              onToggleRail={() => setRailOpen((v) => !v)}
              onToggleWorkspace={() => setWorkspaceOpen((v) => !v)}
              onToggleAi={() => setAiOpen((v) => !v)}
              onCollapse={() => {
                setBrowserOpen(false);
                setWorkspaceOpen(true);
              }}
              onOpenCookieImport={() => setCookieModalOpen(true)}
              onOpenRouterSettings={() => {
                setRouterInitialSection("router");
                setActiveTab("router");
                setWorkspaceOpen(true);
              }}
              onNotify={notify}
            />
          </>
        )}
      </main>

      {/* 4. Far-Right Floating Deta Surf AI Co-Reading Card (⌘L) */}
      {aiOpen && (
        <div
          {...aiDrag.handleProps(aiWidth)}
          className={`ai-split-handle ${aiDrag.dragging ? "dragging" : ""}`}
          onDoubleClick={() => setAiWidth(DEFAULT_AI_WIDTH)}
          title="拖动调整问点点宽度（拖至最右自动收起，双击重置）"
        />
      )}
      <aside
        className={`ai-drawer-pane ${aiOpen ? "open" : ""}`}
        style={{
          display: aiOpen ? "flex" : "none",
          width: `${aiWidth}px`,
          flex: "0 0 auto",
        }}
        aria-label="问点点 AI 共读侧栏"
      >
        <LeftWorkspace
          books={books}
          drafts={drafts}
          browserState={reading ? null : browserState}
          modelSettings={modelSettings}
          safetyMode={safetyMode}
          autoContext={autoContext}
          pendingPrompt={pendingPrompt}
          onConsumePendingPrompt={() => setPendingPrompt(null)}
          onClose={() => setAiOpen(false)}
          onOpenSettings={() => setSettingsOpen(true)}
          onSelectModel={(modelId) => handleSelectModel(modelId)}
          onSelectSafety={(mode) => void handleSelectSafety(mode)}
          onSaveAsDraft={(text) => handleSaveReplyAsDraft(text)}
          onOpenDraft={handleOpenDraftFromChat}
          onNotify={notify}
        />
      </aside>

      <SettingsModal
        open={settingsOpen}
        initial={modelSettings}
        onClose={() => setSettingsOpen(false)}
        onSaved={(saved) => {
          setModelSettings(saved);
          notify("模型设置已保存", "success");
        }}
      />

      {historyImportOpen && (
        <ZlibHistoryImport onClose={() => setHistoryImportOpen(false)} onImported={refreshDownloads} />
      )}

      <CookieImportModal
        open={cookieModalOpen}
        activeAccountLabel={
          browserState?.accounts.find((a) => a.id === browserState.activeAccountId)?.label ?? "主账号"
        }
        onClose={() => setCookieModalOpen(false)}
        onNotify={notify}
      />

      {toastStack}
    </div>
  );
};
