import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConnectionsSnapshot, ZlibBookItem } from "../types/desktop";
import { CustomSelect } from "./CustomSelect";
import {
  IconArrowLeft,
  IconBookOpen,
  IconCheck,
  IconClose,
  IconCopy,
  IconDownload,
  IconExternalLink,
  IconFolder,
  IconGlobe,
  IconRefresh,
  IconSearch,
  IconSparkles,
  IconUpload,
  IconWand,
} from "./Icons";

type FeedTab = "recommended" | "popular" | "favorites";

interface DownloadedEntry {
  bookRef: string;
  title: string;
  directory: string;
  filePath?: string;
  metaFixed?: boolean;
  wereadUploaded?: boolean;
  kindleSent?: boolean;
}

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
  onNotify: (msg: string, tone?: "info" | "success" | "error") => void;
}

const RECENT_SEARCHES_KEY = "diandian.discover.recentQueries.v1";
const INITIAL_FEED_COUNT = 5;

const COVER_PALETTES = [
  "linear-gradient(155deg, #689cf2 0%, #3b6fd8 100%)",
  "linear-gradient(155deg, #5e8de6 0%, #2d55b8 100%)",
  "linear-gradient(155deg, #5ea5c9 0%, #2c6f94 100%)",
  "linear-gradient(155deg, #6b88c9 0%, #3f558f 100%)",
  "linear-gradient(155deg, #5c9e8d 0%, #2d6c5d 100%)",
  "linear-gradient(155deg, #7c84d6 0%, #4d54a3 100%)",
];

function hashTitleToPalette(title: string): string {
  let h = 0;
  for (let i = 0; i < title.length; i++) {
    h = (h * 31 + title.charCodeAt(i)) | 0;
  }
  return COVER_PALETTES[Math.abs(h) % COVER_PALETTES.length] ?? "linear-gradient(155deg, #689cf2 0%, #3b6fd8 100%)";
}

function cleanShortTitle(raw: string): string {
  const split = raw.split(/\s*[=:：]\s*/)[0]?.trim() || raw.trim();
  return split.length >= 2 ? split : raw.trim();
}

function buildDoubanBookUrl(book: ZlibBookItem): { url: string; directIsbn: boolean } {
  const rawIsbn = (book.isbn ?? "").replace(/[-\s]/g, "");
  const cnIsbnMatch = rawIsbn.match(/9787\d{9}/);
  if (cnIsbnMatch) {
    return {
      url: `https://book.douban.com/isbn/${cnIsbnMatch[0]}/`,
      directIsbn: true,
    };
  }
  const keyword = cleanShortTitle(book.title);
  return {
    url: `https://search.douban.com/book/subject_search?search_text=${encodeURIComponent(keyword)}&cat=1001`,
    directIsbn: false,
  };
}

function loadRecentQueries(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_SEARCHES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .slice(0, 6);
  } catch {
    return [];
  }
}

function saveRecentQueries(list: string[]): void {
  try {
    window.localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(list.slice(0, 6)));
  } catch {
    // Ignore storage errors.
  }
}

interface BookCoverMediaProps {
  book: ZlibBookItem;
  size?: "tile" | "thumb" | "detail";
}

const BookCoverMedia: React.FC<BookCoverMediaProps> = ({ book, size = "tile" }) => {
  const [imgFailed, setImgFailed] = useState(false);

  useEffect(() => {
    setImgFailed(false);
  }, [book.coverUrl]);

  const showImage = Boolean(book.coverUrl) && !imgFailed;

  if (showImage) {
    return (
      <img
        src={book.coverUrl}
        alt={book.title}
        referrerPolicy="no-referrer"
        loading="lazy"
        onError={() => setImgFailed(true)}
        className="discover-cover-img"
      />
    );
  }

  const palette = hashTitleToPalette(book.title);
  return (
    <div
      className={`discover-cover-fallback size-${size}`}
      style={{ background: palette }}
    >
      <div className="discover-cover-fallback-spine" />
      <div className="discover-cover-fallback-title">{book.title}</div>
      {book.author && size !== "thumb" && (
        <div className="discover-cover-fallback-author">{book.author}</div>
      )}
    </div>
  );
};

export const DiscoverView: React.FC<DiscoverViewProps> = ({
  onBookMetadataChanged,
  onDownloadComplete,
  onOpenDownloadLibrary,
  onSendToChat,
  onOpenBrowserUrl,
  onOpenSiteUrl,
  onEnsureBrowserOpen,
  onOpenRouterSettings,
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
  useEffect(() => {
    let active = true;
    void refreshConnections().then((snap) => {
      if (!active) return;
      if (snap?.status.installed && snap.zlib.loggedIn) {
        void loadFeed("recommended", false);
      }
    });
    return () => {
      active = false;
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
      onNotify(`已在右侧浏览器打开 ${res.openedUrl}，请登录后点击「同步右侧登录态」`, "info");
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

  const handleDispatchDownloaded = async (entry: DownloadedEntry, target: "weread" | "kindle") => {
    if (!entry.filePath) {
      onNotify("请先在「连接与偏好」中选择下载目录里的电子书文件再分发", "info");
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
            <div className="discover-download-banner">
              <div className="discover-download-banner-left">
                <span className="discover-download-check">
                  <IconCheck size={13} />
                </span>
                <span className="discover-download-text">
                  已下载 <strong>《{cleanShortTitle(lastDownload.title)}》</strong>
                </span>
              </div>
              <div className="discover-download-banner-actions">
                <button type="button" className="btn sm soft" onClick={onOpenDownloadLibrary}>
                  <IconBookOpen size={12} />
                  <span>查看本地书库</span>
                </button>
                <button
                  type="button"
                  className="btn sm ghost"
                  onClick={() => void handleOpenDownloadFolder(lastDownload.filePath)}
                >
                  <IconFolder size={12} />
                  <span>在访达中显示</span>
                </button>
                {lastDownload.filePath && connections?.status.supportsMeta && (
                  <button
                    type="button"
                    className={`btn sm ${lastDownload.metaFixed ? "ghost" : "soft"}`}
                    disabled={dispatchBusy !== null || lastDownload.metaFixed}
                    onClick={() => void handleAutoRepairMeta(lastDownload)}
                    title="在线匹配并更新书名、作者等书目信息"
                  >
                    {lastDownload.metaFixed ? <IconCheck size={12} /> : <IconWand size={12} />}
                    <span>
                      {dispatchBusy === `${lastDownload.bookRef}:meta`
                        ? "补全中…"
                        : lastDownload.metaFixed
                          ? "已补元数据"
                          : "补全书目信息"}
                    </span>
                  </button>
                )}
                {lastDownload.filePath && connections?.weread.loggedIn && (
                  lastDownload.wereadUploaded ? (
                    <button
                      type="button"
                      className="btn sm primary"
                      onClick={() => handleOpenWeReadShelf(lastDownload.title)}
                      title="在右侧内置浏览器打开并刷新微信读书书架"
                    >
                      <IconBookOpen size={12} />
                      <span>已传微信读书 · 去开读</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn sm sage"
                      disabled={dispatchBusy !== null}
                      onClick={() => void handleDispatchDownloaded(lastDownload, "weread")}
                    >
                      <IconUpload size={12} />
                      <span>
                        {dispatchBusy === `${lastDownload.bookRef}:weread` ? "上传中…" : "传微信读书"}
                      </span>
                    </button>
                  )
                )}
                {lastDownload.filePath && connections?.kindle.configured && (
                  <button
                    type="button"
                    className="btn sm soft"
                    disabled={dispatchBusy !== null}
                    onClick={() => void handleDispatchDownloaded(lastDownload, "kindle")}
                  >
                    <IconUpload size={12} />
                    <span>
                      {dispatchBusy === `${lastDownload.bookRef}:kindle` ? "推送中…" : "推 Kindle"}
                    </span>
                  </button>
                )}
                <button
                  type="button"
                  className="btn icon-only ghost"
                  style={{ width: 22, height: 22 }}
                  onClick={() => setLastDownload(null)}
                  title="关闭提示"
                >
                  <IconClose size={12} />
                </button>
              </div>
            </div>
          )}

          {/* Case 1: zlib CLI not installed */}
          {!loadingConn && !zlibInstalled && (
            <section className="discover-onboarding-card">
              <div className="discover-onboarding-title">安装书源组件后即可全网搜书</div>
              <p className="discover-onboarding-desc">
                点点读书通过本机可选组件 <span className="code-inline">heartleo/zlib-cli</span>{" "}
                安全调用你自有 Z-Library 账号检索与下载电子书（未安装不影响共读对话、书库与创作）。
              </p>
              <div className="discover-onboarding-actions">
                <span className="code-inline">brew install heartleo/tap/zlib-cli</span>
                <button
                  type="button"
                  className="btn sm primary"
                  onClick={async () => {
                    await navigator.clipboard.writeText("brew install heartleo/tap/zlib-cli");
                    onNotify("已复制安装命令", "success");
                  }}
                >
                  <IconCopy size={12} />
                  <span>复制命令</span>
                </button>
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
              <div className="discover-onboarding-title">两步连接你的 Z-Library，解锁搜索与个性推荐</div>
              <p className="discover-onboarding-desc">
                在右侧内置浏览器登录你的 Z-Library 账号后，点击「同步右侧登录态」，这里就会自动呈现你的专属推荐书墙。
              </p>
              <div className="discover-onboarding-actions">
                <button
                  type="button"
                  className="btn sm soft"
                  disabled={authBusy !== null}
                  onClick={() => void handleOpenZlibLogin()}
                >
                  <IconGlobe size={13} />
                  <span>{authBusy === "open" ? "打开中…" : "1. 右侧打开登录"}</span>
                </button>
                <button
                  type="button"
                  className="btn sm primary"
                  disabled={authBusy !== null}
                  onClick={() => void handleSyncZlibFromBrowser()}
                >
                  <IconCheck size={13} />
                  <span>{authBusy === "sync" ? "同步中…" : "2. 同步右侧登录态"}</span>
                </button>
              </div>
            </section>
          )}

          {/* Case 3: Search Results Mode */}
          {isSearchMode && (
            <section className="discover-section">
              <div className="discover-results-header">
                <div className="discover-results-header-left">
                  <button
                    type="button"
                    className="btn sm ghost"
                    onClick={handleReturnHome}
                  >
                    <IconArrowLeft size={13} />
                    <span>返回为你推荐</span>
                  </button>
                  <span className="discover-results-summary">
                    「{activeQuery}」{searching ? "检索中…" : `已加载 ${searchResults.length} 本`}
                  </span>
                </div>
              </div>

              {searchError && (
                <div className="discover-error-box">
                  <div>{searchError}</div>
                  <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                    <button
                      type="button"
                      className="btn sm soft"
                      onClick={() => void handleOpenZlibLogin()}
                    >
                      右侧打开登录
                    </button>
                    <button
                      type="button"
                      className="btn sm primary"
                      onClick={() => void handleSyncZlibFromBrowser()}
                    >
                      同步登录态
                    </button>
                  </div>
                </div>
              )}

              {searching ? (
                <div className="discover-search-skeletons">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <div key={i} className="discover-result-skeleton">
                      <div className="discover-skeleton-thumb" />
                      <div className="discover-skeleton-lines">
                        <div className="discover-skeleton-bar w-60" />
                        <div className="discover-skeleton-bar w-40" />
                        <div className="discover-skeleton-bar w-28" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : searchResults.length === 0 && !searchError ? (
                <div className="muted-box">
                  未检索到与「{activeQuery}」匹配的电子书，试试更换关键词或切换为「全部格式」。
                </div>
              ) : (
                <>
                  <div className="discover-search-list">
                    {searchResults.map((book, idx) => {
                      const isDownloading = Boolean(book.bookRef && downloadingRef === book.bookRef);
                      const downloaded = book.bookRef ? downloadedMap[book.bookRef] : undefined;
                      return (
                        <article
                          key={`${book.bookRef || book.id || book.title}-${idx}`}
                          className="discover-result-card"
                          onClick={() => setSelectedBook(book)}
                        >
                          <div className="discover-result-cover">
                            <BookCoverMedia book={book} size="thumb" />
                          </div>
                          <div className="discover-result-body">
                            <h3 className="discover-result-title">{book.title}</h3>
                            {book.author && (
                              <div className="discover-result-author">{book.author}</div>
                            )}
                            <div className="discover-result-meta">
                              {book.extension && (
                                <span className={`discover-fmt-badge fmt-${book.extension}`}>
                                  {book.extension.toUpperCase()}
                                </span>
                              )}
                              {book.size && <span>{book.size}</span>}
                              {book.year && <span>{book.year}</span>}
                              {book.language && <span>{book.language}</span>}
                              {book.publisher && <span className="discover-meta-pub">{book.publisher}</span>}
                            </div>
                          </div>
                          <div
                            className="discover-result-actions"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {downloaded ? (
                              <button
                                type="button"
                                className="btn sm sage"
                                onClick={() => void handleOpenDownloadFolder(downloaded.filePath)}
                                title="点击在访达中显示"
                              >
                                <IconCheck size={12} />
                                <span>已下载</span>
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="btn sm primary"
                                disabled={isDownloading}
                                onClick={() => void handleDownloadBook(book)}
                              >
                                <IconDownload size={12} />
                                <span>{isDownloading ? "下载中…" : "下载"}</span>
                              </button>
                            )}
                            <button
                              type="button"
                              className="btn sm discover-douban-btn"
                              onClick={() => handleOpenDoubanReview(book)}
                              title="在右侧浏览器查看豆瓣评分与书评"
                            >
                              <IconBookOpen size={12} />
                              <span>豆瓣</span>
                            </button>
                            <button
                              type="button"
                              className="btn sm ghost"
                              onClick={() => {
                                onSendToChat(
                                  `我对《${cleanShortTitle(book.title)}》${book.author ? `（${book.author}）` : ""}很感兴趣，请结合我的阅读画像简介核心观点、最值得优先读的章节，以及值不值得读。`,
                                  true,
                                );
                              }}
                              title="和 AI 聊聊这本书"
                            >
                              <IconSparkles size={12} />
                            </button>
                          </div>
                        </article>
                      );
                    })}
                  </div>

                  {hasMoreSearch && (
                    <div className="discover-load-more-row">
                      <span className="discover-load-more-line" />
                      <button
                        type="button"
                        className="discover-load-more-btn"
                        disabled={loadingMoreSearch}
                        onClick={() =>
                          void runSearch(activeQuery, { page: searchPage + 1, append: true })
                        }
                      >
                        {loadingMoreSearch ? "正在加载下一页…" : "加载更多 ↓"}
                      </button>
                      <span className="discover-load-more-line" />
                    </div>
                  )}
                </>
              )}
            </section>
          )}

          {/* Case 4: Default Personally Recommended Cover Grid */}
          {!isSearchMode && zlibInstalled && zlibLoggedIn && (
            <section className="discover-section">
              <div className="discover-feed-header">
                <div className="discover-feed-title-group">
                  <h2 className="discover-feed-title">{feedTitle.zh}</h2>
                  <span className="discover-feed-en">{feedTitle.en}</span>
                </div>

                <div className="discover-feed-controls">
                  <div className="discover-feed-tabs" role="tablist" aria-label="书单分类">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={feedTab === "recommended"}
                      className={`discover-feed-tab ${feedTab === "recommended" ? "active" : ""}`}
                      onClick={() => handleSwitchFeedTab("recommended")}
                    >
                      为你推荐
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={feedTab === "popular"}
                      className={`discover-feed-tab ${feedTab === "popular" ? "active" : ""}`}
                      onClick={() => handleSwitchFeedTab("popular")}
                    >
                      全站热门
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={feedTab === "favorites"}
                      className={`discover-feed-tab ${feedTab === "favorites" ? "active" : ""}`}
                      onClick={() => handleSwitchFeedTab("favorites")}
                    >
                      我的收藏
                    </button>
                  </div>

                  <button
                    type="button"
                    className="btn icon-only ghost"
                    style={{ width: 26, height: 26 }}
                    disabled={loadingFeed}
                    onClick={() => void loadFeed(feedTab, true)}
                    title="刷新推荐书单"
                  >
                    <IconRefresh size={13} className={loadingFeed ? "spin-icon" : undefined} />
                  </button>
                </div>
              </div>

              {feedError && (
                <div className="discover-error-box">
                  <div>{feedError}</div>
                  <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                    <button
                      type="button"
                      className="btn sm soft"
                      onClick={() => void loadFeed(feedTab, true)}
                    >
                      重试加载
                    </button>
                    <button
                      type="button"
                      className="btn sm ghost"
                      onClick={() => void handleSyncZlibFromBrowser()}
                    >
                      重新同步右侧登录态
                    </button>
                  </div>
                </div>
              )}

              {loadingFeed && displayedFeedBooks.length === 0 ? (
                <div className="discover-cover-shelf">
                  <div className="discover-cover-grid">
                    {Array.from({ length: INITIAL_FEED_COUNT }).map((_, i) => (
                      <div key={i} className="discover-cover-skeleton" />
                    ))}
                  </div>
                </div>
              ) : displayedFeedBooks.length === 0 && !feedError ? (
                <div className="muted-box">
                  {feedTab === "favorites"
                    ? "你的 Z-Library 收藏夹目前为空，去搜几本喜欢的书吧。"
                    : "暂时没有推荐书目，可以直接在上方搜索框输入书名或作者检索。"}
                </div>
              ) : (
                <>
                  <div className="discover-cover-shelf">
                    <div className="discover-cover-grid">
                      {displayedFeedBooks.map((book, idx) => {
                        const isDownloading = Boolean(book.bookRef && downloadingRef === book.bookRef);
                        const isDone = Boolean(book.bookRef && downloadedMap[book.bookRef]);
                        return (
                          <div
                            key={`${book.bookRef || book.id || book.title}-${idx}`}
                            className={`discover-book-tile ${isDone ? "is-downloaded" : ""}`}
                            role="button"
                            tabIndex={0}
                            title={`${book.title}${book.author ? ` — ${book.author}` : ""}`}
                            onClick={() => setSelectedBook(book)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                setSelectedBook(book);
                              }
                            }}
                          >
                            <div className="discover-book-cover-frame">
                              <BookCoverMedia book={book} size="tile" />

                              {book.extension && (
                                <span className="discover-tile-ext">{book.extension.toUpperCase()}</span>
                              )}

                              {/* Quick 1-click download button on hover */}
                              <button
                                type="button"
                                className={`discover-tile-dl-btn ${isDone ? "done" : ""} ${isDownloading ? "busy" : ""}`}
                                disabled={isDownloading}
                                title={isDone ? "已下载到 Downloads/diandianreading" : "一键下载本书"}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (isDone && book.bookRef) {
                                    void handleOpenDownloadFolder(downloadedMap[book.bookRef]?.filePath);
                                  } else {
                                    void handleDownloadBook(book);
                                  }
                                }}
                              >
                                {isDone ? (
                                  <IconCheck size={12} />
                                ) : isDownloading ? (
                                  <IconRefresh size={12} className="spin-icon" />
                                ) : (
                                  <IconDownload size={12} />
                                )}
                              </button>

                              {/* Floating frosted title caption on hover (Z-Library hover feel) */}
                              <div className="discover-tile-caption">
                                <div className="discover-tile-title">{book.title}</div>
                                {book.author && (
                                  <div className="discover-tile-author">{book.author}</div>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {(canLoadMoreFeed || isFeedExpanded) && (
                    <div className="discover-load-more-row">
                      <span className="discover-load-more-line" />
                      <div className="discover-load-more-actions">
                        {canLoadMoreFeed && (
                          <button
                            type="button"
                            className="discover-load-more-btn"
                            disabled={loadingMoreFeed}
                            onClick={() => void handleLoadMoreFeed()}
                          >
                            {loadingMoreFeed
                              ? "正在加载更多…"
                              : isFeedExpanded
                                ? "加载更多 ↓"
                                : "展开更多推荐 ↓"}
                          </button>
                        )}
                        {isFeedExpanded && (
                          <button
                            type="button"
                            className="discover-load-more-btn subtle"
                            onClick={handleCollapseFeed}
                          >
                            收起 ↑
                          </button>
                        )}
                      </div>
                      <span className="discover-load-more-line" />
                    </div>
                  )}
                </>
              )}
            </section>
          )}
        </div>
      </div>

      {/* In-Canvas Book Detail Sheet (Scoped inside DiscoverView so Right Browser stays 100% live) */}
      {selectedBook && (
        <div
          className="discover-drawer-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={selectedBook.title}
          onClick={() => setSelectedBook(null)}
        >
          <div className="discover-drawer-card" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="discover-drawer-close"
              onClick={() => setSelectedBook(null)}
              title="关闭（Esc）"
            >
              <IconClose size={14} />
            </button>

            <div className="discover-drawer-top">
              <div className="discover-drawer-cover">
                <BookCoverMedia book={selectedBook} size="detail" />
              </div>

              <div className="discover-drawer-info">
                <h2 className="discover-drawer-title">{selectedBook.title}</h2>
                {selectedBook.author && (
                  <div className="discover-drawer-author">{selectedBook.author}</div>
                )}

                <div className="discover-drawer-badges">
                  {selectedBook.extension && (
                    <span className={`discover-fmt-badge fmt-${selectedBook.extension}`}>
                      {selectedBook.extension.toUpperCase()}
                    </span>
                  )}
                  {selectedBook.size && <span className="badge">{selectedBook.size}</span>}
                  {selectedBook.year && <span className="badge">{selectedBook.year}</span>}
                  {selectedBook.language && <span className="badge">{selectedBook.language}</span>}
                  {selectedBook.rating && <span className="badge sage">★ {selectedBook.rating}</span>}
                </div>

                {(selectedBook.publisher || selectedBook.isbn) && (
                  <div className="discover-drawer-meta-lines">
                    {selectedBook.publisher && <div>出版社：{selectedBook.publisher}</div>}
                    {selectedBook.isbn && <div>ISBN：{selectedBook.isbn}</div>}
                  </div>
                )}
              </div>
            </div>

            {selectedBook.description && (
              <p className="discover-drawer-desc">{selectedBook.description}</p>
            )}

            <div className="discover-drawer-actions">
              {selectedBook.bookRef && downloadedMap[selectedBook.bookRef] ? (
                <>
                  <button
                    type="button"
                    className="btn sage"
                    onClick={() =>
                      void handleOpenDownloadFolder(downloadedMap[selectedBook.bookRef]?.filePath)
                    }
                  >
                    <IconFolder size={14} />
                    <span>已下载 · 在访达中显示</span>
                  </button>
                  {downloadedMap[selectedBook.bookRef]?.filePath && connections?.status.supportsMeta && (
                    <button
                      type="button"
                      className="btn soft"
                      disabled={dispatchBusy !== null || Boolean(downloadedMap[selectedBook.bookRef]?.metaFixed)}
                      onClick={() => void handleAutoRepairMeta(downloadedMap[selectedBook.bookRef]!)}
                    >
                      {downloadedMap[selectedBook.bookRef]?.metaFixed ? (
                        <IconCheck size={14} />
                      ) : (
                        <IconWand size={14} />
                      )}
                      <span>
                        {dispatchBusy === `${selectedBook.bookRef}:meta`
                          ? "正在补全书目信息…"
                          : downloadedMap[selectedBook.bookRef]?.metaFixed
                            ? "已补全书目信息"
                            : "补全书目信息"}
                      </span>
                    </button>
                  )}
                  {downloadedMap[selectedBook.bookRef]?.filePath && connections?.weread.loggedIn && (
                    downloadedMap[selectedBook.bookRef]?.wereadUploaded ? (
                      <button
                        type="button"
                        className="btn primary"
                        onClick={() => handleOpenWeReadShelf(selectedBook.title)}
                      >
                        <IconBookOpen size={14} />
                        <span>已传微信读书 · 去书架开读</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn soft"
                        disabled={dispatchBusy !== null}
                        onClick={() =>
                          void handleDispatchDownloaded(downloadedMap[selectedBook.bookRef]!, "weread")
                        }
                      >
                        <IconUpload size={14} />
                        <span>
                          {dispatchBusy === `${selectedBook.bookRef}:weread`
                            ? "正在上传到微信读书…"
                            : "导入微信读书"}
                        </span>
                      </button>
                    )
                  )}
                  {downloadedMap[selectedBook.bookRef]?.filePath && connections?.kindle.configured && (
                    <button
                      type="button"
                      className="btn soft"
                      disabled={dispatchBusy !== null}
                      onClick={() =>
                        void handleDispatchDownloaded(downloadedMap[selectedBook.bookRef]!, "kindle")
                      }
                    >
                      <IconUpload size={14} />
                      <span>推送到 Kindle</span>
                    </button>
                  )}
                </>
              ) : (
                <button
                  type="button"
                  className="btn primary"
                  disabled={Boolean(selectedBook.bookRef && downloadingRef === selectedBook.bookRef)}
                  onClick={() => void handleDownloadBook(selectedBook)}
                >
                  <IconDownload size={14} />
                  <span>
                    {selectedBook.bookRef && downloadingRef === selectedBook.bookRef
                      ? "正在下载到 Downloads/diandianreading…"
                      : "下载到 Downloads/diandianreading"}
                  </span>
                </button>
              )}

              <button
                type="button"
                className="btn discover-douban-btn"
                onClick={() => handleOpenDoubanReview(selectedBook)}
              >
                <IconBookOpen size={14} />
                <span>右侧看豆瓣评分与书评</span>
              </button>

              <button
                type="button"
                className="btn soft"
                onClick={() => {
                  const shortName = cleanShortTitle(selectedBook.title);
                  setSelectedBook(null);
                  void runSearch(shortName);
                }}
              >
                <IconSearch size={14} />
                <span>搜更多版本 (EPUB/PDF)</span>
              </button>

              <button
                type="button"
                className="btn"
                onClick={() => {
                  const title = cleanShortTitle(selectedBook.title);
                  setSelectedBook(null);
                  onSendToChat(
                    `我对《${title}》${selectedBook.author ? `（${selectedBook.author}）` : ""}很感兴趣，请结合我的阅读画像为我拆解它的核心观点、推荐阅读路径，以及它和我已读过的书有什么关联。`,
                    true,
                  );
                }}
              >
                <IconSparkles size={14} />
                <span>和 AI 聊这本书</span>
              </button>

              {selectedBook.url && (
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => {
                    onOpenBrowserUrl(selectedBook.url!, false);
                    setSelectedBook(null);
                  }}
                >
                  <IconExternalLink size={14} />
                  <span>右侧打开详情页</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {/* In-Canvas WeRead Upload Success Jump Modal (Keeps Right Browser 100% Live) */}
      {wereadReadyBook && (
        <div
          className="discover-drawer-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="已上传到微信读书书架"
          onClick={() => setWereadReadyBook(null)}
        >
          <div className="discover-weread-modal" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="discover-drawer-close"
              onClick={() => setWereadReadyBook(null)}
              title="关闭（Esc）"
            >
              <IconClose size={14} />
            </button>

            <div className="discover-weread-badge">
              <IconCheck size={20} />
            </div>

            <h3 className="discover-weread-title">已上架到微信读书书架</h3>
            <p className="discover-weread-desc">
              <strong>《{cleanShortTitle(wereadReadyBook.title)}》</strong>{" "}
              已导入完成。点击下方按钮将在右侧刷新「我的书架」，新书通常会出现在第一位。
            </p>

            <div className="discover-weread-actions">
              <button
                type="button"
                className="btn primary"
                onClick={() => handleOpenWeReadShelf(wereadReadyBook.title)}
              >
                <IconBookOpen size={14} />
                <span>去右侧书架开读</span>
              </button>
              <button
                type="button"
                className="btn ghost"
                onClick={() => setWereadReadyBook(null)}
              >
                继续搜书
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
