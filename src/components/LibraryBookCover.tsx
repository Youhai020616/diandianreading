import { useEffect, useState } from "react";

interface LibraryBookCoverProps {
  title: string;
  coverUrl: string;
  bookId?: string;
}

export function LibraryBookCover(props: LibraryBookCoverProps) {
  // A different book or edition must never inherit the last image's pixels or error state.
  return <CoverImage key={JSON.stringify([props.bookId, props.coverUrl])} {...props} />;
}

function CoverImage({ title, coverUrl, bookId }: LibraryBookCoverProps) {
  const remoteUrl = /^https?:\/\//i.test(coverUrl) ? coverUrl : "";
  const [src, setSrc] = useState(bookId ? "" : remoteUrl);

  useEffect(() => {
    let active = true;
    const load = async () => {
      let next = remoteUrl;
      if (bookId && remoteUrl) {
        // Older records may contain an external cover outside the supported catalog hosts.
        const cached = await window.diandian.library.getBookCover(bookId).catch(() => null);
        if (cached) next = cached;
      }
      if (active) setSrc(next);
    };
    void load();
    window.addEventListener("online", load);
    return () => {
      active = false;
      window.removeEventListener("online", load);
    };
  }, [bookId, remoteUrl]);

  if (!src) return Array.from(title)[0] ?? "";
  return <img src={src} alt={title} onError={() => setSrc("")} />;
}
