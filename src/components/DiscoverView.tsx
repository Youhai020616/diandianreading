import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConnectionsSnapshot, ZlibBookItem } from "../types/desktop";
import { CustomSelect } from "./CustomSelect";
import { BookDetailSheet } from "./discover/BookDetailSheet";
import { DownloadBanner } from "./discover/DownloadBanner";
import {
  buildDoubanBookUrl, cleanShortTitle, INITIAL_FEED_COUNT, loadRecentQueries, saveRecentQueries,
  type DownloadedEntry, type FeedTab,
} from "./discover/discoverShared";
import { RecommendedShelf } from "./discover/RecommendedShelf";
import { SearchResults } from "./discover/SearchResults";
import { WeReadReadyModal } from "./discover/WeReadReadyModal";
import { isWeReadAuthRequiredError, type WeReadAuthRequest } from "../lib/wereadAuth";
import {
  IconCheck,
  IconClose,
  IconGlobe,
  IconRefresh,
  IconSearch,
} from "./Icons";

export const WEREAD_SHELF_URL = "https://weread.qq.com/web/shelf";

interface DiscoverViewProps {
  onBookMetadataChanged: (previousPath: string, updatedPath: string, title: string) => void;
  onDownloadComplete: () => void;
  onOpenDownloadLibrary: () => void;
  onSendToChat: (prompt: string, autoSend?: boolean) => void;
  onOpenBrowserUrl: (url: string, newTab?: boolean) => void;
  /** Open in a tab dedicated to that site (keeps the current reading tab intact). */
  onOpenSiteUrl?: (url: string) => void;
  onEnsureBrowserOpen: () => void;
  onOpenRouterSettings: () => void;
  onRequestWeReadAuth?: (req: WeReadAuthRequest) => void;
  onNotify: (msg: string, tone?: "info" | "success" | "error") => void;
}

export const DiscoverView: React.FC<DiscoverViewProps> = ({
  onBookMetadataChanged,
  onDownloadComplete,
  onOpenDownloadLibrary,
  onSendToChat,
  onOpenBrowserUrl,
  onOpenSiteUrl,
  onEnsureBrowserOpen,
  onOpenRouterSettings,
  onRequestWeReadAuth,
  onNotify,
}) => {
  // Connection status
  const [connections, setConnections] = useState<ConnectionsSnapshot | null>(null);
  const [loadingConn, setLoadingConn] = useState(true);
  const [authBusy, setAuthBusy] = useState<string | null>(null);

  // Search state
  const [queryInput, setQueryInput] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [formatFilter, setFormatFilter] = useState("");
  const [sortOrder, setSortOrder] = useState("bestmatch");
  const [searching, setSearching] = useState(false);
  const [loadingMoreSearch, setLoadingMoreSearch] = useState(false);
  const [searchPage, setSearchPage] = useState(1);
  const [hasMoreSearch, setHasMoreSearch] = useState(false);
  const [searchResults, setSearchResults] = useState<ZlibBookItem[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [recentQueries, setRecentQueries] = useState<string[]>(() => loadRecentQueries());

  // Personalized / Popular / Favorites feed state
  const [feedTab, setFeedTab] = useState<FeedTab>("recommended");
  const [recommendedBooks, setRecommendedBooks] = useState<ZlibBookItem[]>([]);
  const [popularBooks, setPopularBooks] = useState<ZlibBookItem[]>([]);
  const [favoriteBooks, setFavoriteBooks] = useState<ZlibBookItem[]>([]);
  const [loadingFeed, setLoadingFeed] = useState(false);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(INITIAL_FEED_COUNT);
  const [extraPopularCount, setExtraPopularCount] = useState(0);
  const [loadingMoreFeed, setLoadingMoreFeed] = useState(false);

  // Download & detail drawer state
  const [selectedBook, setSelectedBook] = useState<ZlibBookItem | null>(null);
  const [wereadReadyBook, setWereadReadyBook] = useState<DownloadedEntry | null>(null);
  const [downloadingRef, setDownloadingRef] = useState<string | null>(null);
  const [dispatchBusy, setDispatchBusy] = useState<string | null>(null);
  const [downloadedMap, setDownloadedMap] = useState<Record<string, DownloadedEntry>>({});
  const [lastDownload, setLastDownload] = useState<DownloadedEntry | null>(null);

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  const refreshConnections = useCallback(async () => {
    setLoadingConn(true);
    try {
      const snap = await window.diandian.router.connections();
      setConnections(snap);
      return snap;
    } catch {
      return null;
    } finally {
      setLoadingConn(false);
    }
  }, []);

  const loadFeed = useCallback(
    async (tab: FeedTab, forceRefresh = false) => {
      setLoadingFeed(true);
      setFeedError(null);
      try {
        if (tab === "recommended") {
          const list = await window.diandian.router.recommended(forceRefresh);
          setRecommendedBooks(list);
          setVisibleCount(INITIAL_FEED_COUNT);
          if (forceRefresh) setExtraPopularCount(0);
        } else if (tab === "popular") {
          const list = await window.diandian.router.mostPopular(forceRefresh);
          setPopularBooks(list);
          setVisibleCount(INITIAL_FEED_COUNT);
        } else {
          const list = await window.diandian.router.favorites(forceRefresh);
          setFavoriteBooks(list);
          setVisibleCount(INITIAL_FEED_COUNT);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : "加载推荐书单失败";
        setFeedError(msg);
      } finally {
        setLoadingFeed(false);
      }
    },
    [],
  );

  // Initial load: fetch connection status, then immediately fetch personalized recommendations if logged in
  const wasZlibLoggedInRef = useRef(false);
  useEffect(() => {
    let active = true;
    void refreshConnections().then((snap) => {
      if (!active) return;
      wasZlibLoggedInRef.current = Boolean(snap?.zlib.loggedIn);
      if (snap?.status.installed && snap.zlib.loggedIn) {
        void loadFeed("recommended", false);
      }
    });
    const offConn = window.diandian.router.onConnectionsChanged(({ snapshot }) => {
      if (!active) return;
      const justLoggedIn = !wasZlibLoggedInRef.current && snapshot.zlib.loggedIn;
      wasZlibLoggedInRef.current = snapshot.zlib.loggedIn;
      setConnections(snapshot);
      setLoadingConn(false);
      if (justLoggedIn && snapshot.status.installed) {
        void loadFeed("recommended", true);
      }
    });
    return () => {
      active = false;
      offConn();
    };
  }, [refreshConnections, loadFeed]);

  // Close in-canvas overlays on Escape
  useEffect(() => {
    if (!selectedBook && !wereadReadyBook) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (wereadReadyBook) setWereadReadyBook(null);
        else if (selectedBook) setSelectedBook(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedBook, wereadReadyBook]);

  const handleSwitchFeedTab = (tab: FeedTab) => {
    setFeedTab(tab);
    setFeedError(null);
    setVisibleCount(INITIAL_FEED_COUNT);
    setExtraPopularCount(0);
    if (tab === "recommended" && recommendedBooks.length === 0) {
      void loadFeed("recommended", false);
    } else if (tab === "popular" && popularBooks.length === 0) {
      void loadFeed("popular", false);
    } else if (tab === "favorites" && favoriteBooks.length === 0) {
      void loadFeed("favorites", false);
    }
  };

  const runSearch = useCallback(
    async (
      rawQuery: string,
      opts?: { format?: string; order?: string; page?: number; append?: boolean },
    ) => {
      const q = rawQuery.trim();
      if (!q) {
        setActiveQuery("");
        setSearchResults([]);
        setSearchError(null);
        setHasMoreSearch(false);
        return;
      }
      const nextFormat = opts?.format !== undefined ? opts.format : formatFilter;
      const nextOrder = opts?.order !== undefined ? opts.order : sortOrder;
      const nextPage = opts?.page ?? 1;
      const append = opts?.append === true;

      if (append) {
        setLoadingMoreSearch(true);
      } else {
        setSearching(true);
        setSearchError(null);
        setActiveQuery(q);
        setQueryInput(q);
        const nextRecent = [q, ...recentQueries.filter((x) => x !== q)].slice(0, 6);
        setRecentQueries(nextRecent);
        saveRecentQueries(nextRecent);
      }

      try {
        const pageSize = 15;
        const items = await window.diandian.router.search({
          query: q,
          format: nextFormat || undefined,
          order: nextOrder === "bestmatch" ? undefined : nextOrder,
          page: nextPage,
          limit: pageSize,
        });
        setSearchPage(nextPage);
        setHasMoreSearch(items.length >= pageSize);
        if (append) {
          setSearchResults((prev) => {
            const seen = new Set(prev.map((b) => b.bookRef || `${b.title}:${b.author}`));
            const merged = [...prev];
            for (const item of items) {
              const key = item.bookRef || `${item.title}:${item.author}`;
              if (!seen.has(key)) {
                seen.add(key);
                merged.push(item);
              }
            }
            return merged;
          });
        } else {
          setSearchResults(items);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : "检索失败";
        setSearchError(msg);
        onNotify(msg, "error");
      } finally {
        setSearching(false);
        setLoadingMoreSearch(false);
      }
    },
    [formatFilter, sortOrder, recentQueries, onNotify],
  );

  const handleClearInput = () => {
    setQueryInput("");
    searchInputRef.current?.focus();
  };

  const handleReturnHome = () => {
    setQueryInput("");
    setActiveQuery("");
    setSearchResults([]);
    setSearchError(null);
    setHasMoreSearch(false);
    setSearchPage(1);
  };

  const handleRemoveRecent = (term: string) => {
    const next = recentQueries.filter((x) => x !== term);
    setRecentQueries(next);
    saveRecentQueries(next);
  };

  const handleOpenZlibLogin = async () => {
    setAuthBusy("open");
    onEnsureBrowserOpen();
    try {
      const res = await window.diandian.router.openZlibLogin();
      if (res.reachable === false) {
        onNotify(
          `正在右侧尝试打开 ${res.openedUrl}；若页面无法加载，请检查网络代理或前往「连接与偏好」切换镜像`,
          "info",
        );
      } else if (res.switched) {
        onNotify(
          `已自动为你切换到可用镜像 ${res.openedUrl}，在右侧网页完成登录后将自动同步连接！`,
          "info",
        );
      } else {
        onNotify(`已在右侧浏览器打开 ${res.openedUrl}，完成登录后将自动同步书源连接！`, "info");
      }
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "打开登录页失败", "error");
    } finally {
      setAuthBusy(null);
    }
  };

  const handleSyncZlibFromBrowser = async () => {
    setAuthBusy("sync");
    try {
      const res = await window.diandian.router.syncZlibFromBrowser();
      setConnections(res.snapshot);
      onNotify(`已成功同步 Z-Library 登录态（${res.origin}）`, "success");
      if (res.snapshot.zlib.loggedIn) {
        void loadFeed("recommended", true);
      }
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "同步登录态失败", "error");
    } finally {
      setAuthBusy(null);
    }
  };

  const handleOpenDoubanReview = (book: ZlibBookItem) => {
    const { url, directIsbn } = buildDoubanBookUrl(book);
    if (onOpenSiteUrl) onOpenSiteUrl(url);
    else onOpenBrowserUrl(url, false);
    onNotify(
      directIsbn
        ? `正在右侧按 ISBN 打开《${cleanShortTitle(book.title)}》豆瓣页面…`
        : `正在右侧打开《${cleanShortTitle(book.title)}》豆瓣评分与书评检索…`,
      "info",
    );
  };

  const handleDownloadBook = async (book: ZlibBookItem) => {
    if (!book.bookRef) {
      onNotify("该书目缺少下载标识，已为你搜索同书可用版本", "info");
      void runSearch(cleanShortTitle(book.title));
      return;
    }
    setDownloadingRef(book.bookRef);
    try {
      const { title, author, isbn, publisher, year, coverUrl } = book;
      const res = await window.diandian.router.download(book.bookRef, { title, author, isbn, publisher, year, coverUrl });
      const entry: DownloadedEntry = {
        bookRef: book.bookRef,
        title: book.title,
        directory: res.directory,
        filePath: res.filePath,
      };
      setDownloadedMap((prev) => ({ ...prev, [book.bookRef]: entry }));
      setLastDownload(entry);
      onDownloadComplete();
      onNotify(`《${cleanShortTitle(book.title)}》已下载到 Downloads/diandianreading`, "success");
      // Refresh quota silently
      void window.diandian.router.connections().then(setConnections).catch(() => {});
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "下载失败", "error");
    } finally {
      setDownloadingRef(null);
    }
  };

  const handleOpenWeReadShelf = (title?: string) => {
    setWereadReadyBook(null);
    setSelectedBook(null);
    onOpenBrowserUrl(WEREAD_SHELF_URL, false);
    if (title) {
      onNotify(`已在右侧刷新微信读书书架，点击《${cleanShortTitle(title)}》即可开始阅读`, "info");
    }
  };

  const handleDispatchDownloaded = async (
    entry: DownloadedEntry,
    target: "weread" | "kindle",
    opts?: { skipAuthPrecheck?: boolean },
  ) => {
    if (!entry.filePath) {
      onNotify("请先在「连接与偏好」中选择下载目录里的电子书文件再分发", "info");
      return;
    }
    if (
      target === "weread"
      && !opts?.skipAuthPrecheck
      && connections
      && !connections.weread.loggedIn
      && onRequestWeReadAuth
    ) {
      onRequestWeReadAuth({
        bookTitle: cleanShortTitle(entry.title),
        expired: false,
        onAuthenticated: () => handleDispatchDownloaded(entry, "weread", { skipAuthPrecheck: true }),
      });
      return;
    }
    setDispatchBusy(`${entry.bookRef}:${target}`);
    try {
      if (target === "weread") {
        const res = await window.diandian.router.importWeRead(entry.filePath);
        if (res.alreadyExisted) {
          onNotify(`微信读书已收录《${cleanShortTitle(entry.title)}》，可在微信读书中查找。`, "info");
          return;
        }
        const updatedEntry: DownloadedEntry = { ...entry, wereadUploaded: true };
        setDownloadedMap((prev) => ({ ...prev, [entry.bookRef]: updatedEntry }));
        setLastDownload((curr) => (curr?.bookRef === entry.bookRef ? updatedEntry : curr));
        setSelectedBook(null);
        setWereadReadyBook(updatedEntry);
        onNotify(`已将《${cleanShortTitle(entry.title)}》导入微信读书书架`, "success");
      } else {
        await window.diandian.router.sendKindle(entry.filePath);
        const updatedEntry: DownloadedEntry = { ...entry, kindleSent: true };
        setDownloadedMap((prev) => ({ ...prev, [entry.bookRef]: updatedEntry }));
        setLastDownload((curr) => (curr?.bookRef === entry.bookRef ? updatedEntry : curr));
        onNotify(`已将《${cleanShortTitle(entry.title)}》推送到 Kindle`, "success");
      }
    } catch (error) {
      if (target === "weread" && isWeReadAuthRequiredError(error) && onRequestWeReadAuth) {
        onRequestWeReadAuth({
          bookTitle: cleanShortTitle(entry.title),
          expired: connections ? connections.weread.loggedIn : undefined,
          onAuthenticated: () => handleDispatchDownloaded(entry, "weread", { skipAuthPrecheck: true }),
        });
        return;
      }
      onNotify(error instanceof Error ? error.message : "分发失败", "error");
    } finally {
      setDispatchBusy(null);
    }
  };

  const handleAutoRepairMeta = async (entry: DownloadedEntry) => {
    if (!entry.filePath) {
      onNotify("未找到本地文件路径，请在访达中查看", "info");
      return;
    }
    setDispatchBusy(`${entry.bookRef}:meta`);
    try {
      const matches = await window.diandian.router.fetchBookMetaMatches(entry.filePath);
      const best = matches[0];
      if (!best) {
        onNotify("豆瓣与微信读书暂未找到更完整的元数据匹配", "info");
        return;
      }
      const result = await window.diandian.router.applyBookMeta({
        filePath: entry.filePath,
        ...best,
        rename: false,
      });
      onBookMetadataChanged(entry.filePath, result.filePath, result.metadata.title);
      const updatedEntry: DownloadedEntry = { ...entry, filePath: result.filePath, metaFixed: true };
      setDownloadedMap((prev) => ({ ...prev, [entry.bookRef]: updatedEntry }));
      setLastDownload((curr) => (curr?.bookRef === entry.bookRef ? updatedEntry : curr));
      onNotify(
        `已更新《${best.title || cleanShortTitle(entry.title)}》的书目信息`,
        "success",
      );
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "自动补全元数据失败", "error");
    } finally {
      setDispatchBusy(null);
    }
  };

  const handleOpenDownloadFolder = async (filePath?: string) => {
    try {
      await window.diandian.router.openDownloadDir(filePath);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "打开下载目录失败", "error");
    }
  };

  const handleLoadMoreFeed = async () => {
    if (feedTab === "recommended") {
      if (visibleCount < recommendedBooks.length) {
        setVisibleCount((c) => Math.min(recommendedBooks.length, c + 10));
        return;
      }
      // All personalized recommendations shown: seamlessly append curated popular books!
      setLoadingMoreFeed(true);
      try {
        let pool = popularBooks;
        if (pool.length === 0) {
          pool = await window.diandian.router.mostPopular(false);
          setPopularBooks(pool);
        }
        setExtraPopularCount((c) => c + 10);
      } catch (error) {
        onNotify(error instanceof Error ? error.message : "加载更多书目失败", "error");
      } finally {
        setLoadingMoreFeed(false);
      }
      return;
    }

    const total = feedTab === "popular" ? popularBooks.length : favoriteBooks.length;
    setVisibleCount((c) => Math.min(total, c + 10));
  };

  const handleCollapseFeed = () => {
    setVisibleCount(INITIAL_FEED_COUNT);
    setExtraPopularCount(0);
    scrollContainerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  // Compute displayed feed books
  const displayedFeedBooks = useMemo(() => {
    if (feedTab === "popular") {
      return popularBooks.slice(0, visibleCount);
    }
    if (feedTab === "favorites") {
      return favoriteBooks.slice(0, visibleCount);
    }
    const base = recommendedBooks.slice(0, visibleCount);
    if (extraPopularCount <= 0 || popularBooks.length === 0) return base;
    const seen = new Set(base.map((b) => b.bookRef || b.title));
    const extras: ZlibBookItem[] = [];
    for (const b of popularBooks) {
      const key = b.bookRef || b.title;
      if (!seen.has(key)) {
        seen.add(key);
        extras.push(b);
        if (extras.length >= extraPopularCount) break;
      }
    }
    return [...base, ...extras];
  }, [feedTab, recommendedBooks, popularBooks, favoriteBooks, visibleCount, extraPopularCount]);

  const canLoadMoreFeed = useMemo(() => {
    if (feedTab === "popular") return visibleCount < popularBooks.length;
    if (feedTab === "favorites") return visibleCount < favoriteBooks.length;
    if (recommendedBooks.length === 0) return false;
    if (visibleCount < recommendedBooks.length) return true;
    // Allow loading more from popular pool up to 60 extras
    return extraPopularCount < 60 && (popularBooks.length === 0 || extraPopularCount < popularBooks.length);
  }, [feedTab, recommendedBooks.length, popularBooks.length, favoriteBooks.length, visibleCount, extraPopularCount]);

  const isFeedExpanded = displayedFeedBooks.length > INITIAL_FEED_COUNT;
  const isSearchMode = Boolean(activeQuery);
  const zlibInstalled = connections?.status.installed ?? true;
  const zlibLoggedIn = connections?.zlib.loggedIn ?? false;

  const feedTitle =
    feedTab === "recommended"
      ? { zh: "为你推荐", en: "Personally recommended" }
      : feedTab === "popular"
        ? { zh: "全站热门", en: "Most popular" }
        : { zh: "我的收藏", en: "Saved favorites" };

  return (
    <div className="discover-view">
      {/* Subtle Top Status Bar */}
      <div className="discover-status-bar">
        <div className="discover-status-left">
          {loadingConn ? (
            <span className="discover-conn-pill">
              <span className="discover-dot pending" />
              正在检查书源连接…
            </span>
          ) : !zlibInstalled ? (
            <span className="discover-conn-pill warn">
              <span className="discover-dot warn" />
              未检测到 zlib CLI
            </span>
          ) : zlibLoggedIn ? (
            <button
              type="button"
              className="discover-conn-pill ok"
              onClick={onOpenRouterSettings}
              title="点击管理镜像域名、微信读书书架与 Kindle 推送"
            >
              <span className="discover-dot ok" />
              <span>{connections?.zlib.userName || "Z-Library 已登录"}</span>
              {connections?.zlib.dailyRemaining !== null && connections?.zlib.dailyRemaining !== undefined && (
                <span className="discover-quota-tag">
                  余 {connections.zlib.dailyRemaining}/{connections.zlib.dailyAllowed ?? 10}
                </span>
              )}
            </button>
          ) : (
            <button
              type="button"
              className="discover-conn-pill warn"
              onClick={() => void handleOpenZlibLogin()}
              title="点击在右侧浏览器打开 Z-Library 登录"
            >
              <span className="discover-dot warn" />
              <span>Z-Library 未登录 · 点击连接</span>
            </button>
          )}
        </div>
      </div>

      {/* Main Scroll Canvas */}
      <div ref={scrollContainerRef} className="discover-scroll">
        <div className={`discover-container ${!isSearchMode ? "is-home" : ""}`}>
          {/* Google-Style Centered Search Hero */}
          <section className={`discover-hero ${isSearchMode ? "compact" : ""}`}>
            {!isSearchMode && (
              <div className="discover-brand-header">
                <h1 className="discover-brand-title">点点搜书</h1>
                <p className="discover-brand-sub">
                  搜好书、一键下载到书架，再带进右侧共读与写作
                </p>
              </div>
            )}

            <div className={`discover-search-row ${isSearchMode ? "is-search" : ""}`}>
              <form
                className="discover-search-pill"
                onSubmit={(e) => {
                  e.preventDefault();
                  // Read the live DOM value: React state can lag behind the last IME-committed character.
                  void runSearch(searchInputRef.current?.value ?? queryInput);
                }}
              >
                <span className="discover-search-icon">
                  <IconSearch size={17} />
                </span>
                <input
                  ref={searchInputRef}
                  className="discover-search-input"
                  value={queryInput}
                  onChange={(e) => setQueryInput(e.target.value)}
                  onKeyDown={(e) => {
                    // Enter that confirms an IME candidate must not submit a half-composed query.
                    if (e.key === "Enter" && (e.nativeEvent.isComposing || e.keyCode === 229)) {
                      e.preventDefault();
                      return;
                    }
                    if (e.key === "Escape" && queryInput) {
                      e.preventDefault();
                      handleClearInput();
                    }
                  }}
                  placeholder="搜书名、作者、ISBN 或关键词…"
                  aria-label="搜索电子书"
                />
                {queryInput && (
                  <button
                    type="button"
                    className="discover-search-clear"
                    onClick={handleClearInput}
                    title="清空搜索框"
                    aria-label="清空搜索框"
                  >
                    <IconClose size={13} />
                  </button>
                )}
                <span className="discover-search-sep" />
                <div className="discover-format-wrap">
                  <CustomSelect
                    size="sm"
                    value={formatFilter}
                    onChange={(nextFmt) => {
                      setFormatFilter(nextFmt);
                      if (activeQuery) {
                        void runSearch(activeQuery, { format: nextFmt, page: 1 });
                      }
                    }}
                    ariaLabel="文件格式"
                    options={[
                      { value: "", label: "全部格式" },
                      { value: "epub", label: "EPUB" },
                      { value: "pdf", label: "PDF" },
                      { value: "mobi", label: "MOBI" },
                      { value: "azw3", label: "AZW3" },
                    ]}
                  />
                </div>
                <button
                  type="submit"
                  className="discover-search-submit"
                  disabled={searching || !queryInput.trim() || !zlibInstalled}
                >
                  {searching ? "检索中…" : "搜索"}
                </button>
              </form>

              {isSearchMode && (
                <div className="discover-sort-wrap">
                  <CustomSelect
                    size="sm"
                    value={sortOrder}
                    onChange={(nextOrder) => {
                      setSortOrder(nextOrder);
                      void runSearch(activeQuery, { order: nextOrder, page: 1 });
                    }}
                    ariaLabel="排序方式"
                    options={[
                      { value: "bestmatch", label: "综合匹配" },
                      { value: "popular", label: "最受欢迎" },
                      { value: "year", label: "出版年份" },
                      { value: "date", label: "最新入库" },
                      { value: "filesize", label: "文件由大到小" },
                    ]}
                  />
                </div>
              )}
            </div>

            {/* Recent Searches */}
            {!isSearchMode && recentQueries.length > 0 && (
              <div className="discover-recent-row">
                <span className="discover-recent-label">最近搜索</span>
                {recentQueries.map((term) => (
                  <span key={term} className="discover-recent-chip">
                    <button
                      type="button"
                      className="discover-recent-text"
                      onClick={() => void runSearch(term)}
                    >
                      {term}
                    </button>
                    <button
                      type="button"
                      className="discover-recent-del"
                      onClick={() => handleRemoveRecent(term)}
                      title="移除"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </section>

          {/* Post-Download Quick Action Toast Banner */}
          {lastDownload && (
            <DownloadBanner
              entry={lastDownload}
              connections={connections}
              dispatchBusy={dispatchBusy}
              onOpenDownloadLibrary={onOpenDownloadLibrary}
              onOpenFolder={(filePath) => void handleOpenDownloadFolder(filePath)}
              onRepairMeta={(entry) => void handleAutoRepairMeta(entry)}
              onOpenWeReadShelf={handleOpenWeReadShelf}
              onDispatch={(entry, target) => void handleDispatchDownloaded(entry, target)}
              onDismiss={() => setLastDownload(null)}
            />
          )}

          {/* Case 1: the bundled zlib CLI is missing (damaged install) */}
          {!loadingConn && !zlibInstalled && (
            <section className="discover-onboarding-card">
              <div className="discover-onboarding-title">书源组件缺失，暂时无法搜书</div>
              <p className="discover-onboarding-desc">
                {connections?.status.installHint} 共读对话、书库与创作不受影响。
              </p>
              <div className="discover-onboarding-actions">
                <button
                  type="button"
                  className="btn sm ghost"
                  onClick={() => void refreshConnections()}
                >
                  <IconRefresh size={12} />
                  <span>重新检测</span>
                </button>
              </div>
            </section>
          )}

          {/* Case 2: Installed, but not logged into Z-Library yet */}
          {!loadingConn && zlibInstalled && !zlibLoggedIn && !isSearchMode && (
            <section className="discover-onboarding-card">
              <div className="discover-onboarding-title">连接你的 Z-Library，解锁搜书与个性推荐</div>
              <p className="discover-onboarding-desc">
                点击「1. 右侧打开登录」在右侧浏览器登录账号，登录完成后会自动同步书源并呈现你的专属推荐书墙（也可点右侧按钮手动立即同步）。
              </p>
              <div className="discover-onboarding-actions">
                <button
                  type="button"
                  className="btn sm soft"
                  disabled={authBusy !== null}
                  onClick={() => void handleOpenZlibLogin()}
                >
                  <IconGlobe size={13} />
                  <span>{authBusy === "open" ? "探测镜像并打开中…" : "1. 右侧打开登录"}</span>
                </button>
                <button
                  type="button"
                  className="btn sm primary"
                  disabled={authBusy !== null}
                  onClick={() => void handleSyncZlibFromBrowser()}
                >
                  <IconCheck size={13} />
                  <span>{authBusy === "sync" ? "同步中…" : "2. 手动同步登录态"}</span>
                </button>
              </div>
            </section>
          )}

          {/* Case 3: Search Results Mode */}
          {isSearchMode && (
            <SearchResults
              query={activeQuery}
              searching={searching}
              results={searchResults}
              error={searchError}
              hasMore={hasMoreSearch}
              loadingMore={loadingMoreSearch}
              downloadingRef={downloadingRef}
              downloadedMap={downloadedMap}
              onReturnHome={handleReturnHome}
              onOpenLogin={() => void handleOpenZlibLogin()}
              onSyncLogin={() => void handleSyncZlibFromBrowser()}
              onSelect={setSelectedBook}
              onOpenFolder={(filePath) => void handleOpenDownloadFolder(filePath)}
              onDownload={(book) => void handleDownloadBook(book)}
              onOpenDouban={handleOpenDoubanReview}
              onSendToChat={onSendToChat}
              onLoadMore={() => void runSearch(activeQuery, { page: searchPage + 1, append: true })}
            />
          )}

          {/* Case 4: Default Personally Recommended Cover Grid */}
          {!isSearchMode && zlibInstalled && zlibLoggedIn && (
            <RecommendedShelf
              title={feedTitle}
              tab={feedTab}
              books={displayedFeedBooks}
              loading={loadingFeed}
              error={feedError}
              loadingMore={loadingMoreFeed}
              canLoadMore={canLoadMoreFeed}
              expanded={isFeedExpanded}
              downloadingRef={downloadingRef}
              downloadedMap={downloadedMap}
              onSwitchTab={handleSwitchFeedTab}
              onRefresh={() => void loadFeed(feedTab, true)}
              onSyncLogin={() => void handleSyncZlibFromBrowser()}
              onSelect={setSelectedBook}
              onOpenFolder={(filePath) => void handleOpenDownloadFolder(filePath)}
              onDownload={(book) => void handleDownloadBook(book)}
              onLoadMore={() => void handleLoadMoreFeed()}
              onCollapse={handleCollapseFeed}
            />
          )}
        </div>
      </div>

      {selectedBook && (
        <BookDetailSheet
          book={selectedBook}
          downloaded={selectedBook.bookRef ? downloadedMap[selectedBook.bookRef] : undefined}
          connections={connections}
          downloading={Boolean(selectedBook.bookRef && downloadingRef === selectedBook.bookRef)}
          dispatchBusy={dispatchBusy}
          onClose={() => setSelectedBook(null)}
          onOpenFolder={(filePath) => void handleOpenDownloadFolder(filePath)}
          onRepairMeta={(entry) => void handleAutoRepairMeta(entry)}
          onOpenWeReadShelf={handleOpenWeReadShelf}
          onDispatch={(entry, target) => void handleDispatchDownloaded(entry, target)}
          onDownload={(book) => void handleDownloadBook(book)}
          onOpenDouban={handleOpenDoubanReview}
          onSearchMore={(title) => {
            setSelectedBook(null);
            void runSearch(title);
          }}
          onSendToChat={onSendToChat}
          onOpenBrowserUrl={onOpenBrowserUrl}
        />
      )}
      {wereadReadyBook && (
        <WeReadReadyModal
          entry={wereadReadyBook}
          onClose={() => setWereadReadyBook(null)}
          onOpenShelf={handleOpenWeReadShelf}
        />
      )}
    </div>
  );
};
