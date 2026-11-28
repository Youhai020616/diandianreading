// Image imports processed by vite-imagetools (see content.ts / App.tsx for the query strings used).
declare module "*&as=srcset" {
  const srcset: string;
  export default srcset;
}

declare module "*format=webp" {
  const src: string;
  export default src;
}

// All feature screenshots provide two widths; imagetools includes both in srcset.
declare module "*&as=img" {
  const image: { src: string; srcset: string; w: number; h: number };
  export default image;
}
