import React, { useEffect, useState } from "react";
import type { ZlibBookItem } from "../../types/desktop";
import { hashTitleToPalette } from "./discoverShared";

interface BookCoverMediaProps {
  book: ZlibBookItem;
  size?: "tile" | "thumb" | "detail";
}

export const BookCoverMedia: React.FC<BookCoverMediaProps> = ({ book, size = "tile" }) => {
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
