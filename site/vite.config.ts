import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { imagetools } from "vite-imagetools";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// The site reuses the app's own pieces instead of copying them: the pull-cord lamp from src/ and the
// README screenshots from docs/screenshots. `dedupe` keeps those files on the site's single React copy.
export default defineConfig({
  base: "./",
  // imagetools turns `?w=…&format=webp` imports into resized WebP files at build time.
  plugins: [react(), imagetools()],
  resolve: {
    alias: {
      "@app": fileURLToPath(new URL("../src", import.meta.url)),
      "@shots": fileURLToPath(new URL("../docs/screenshots", import.meta.url)),
      "@icons": fileURLToPath(new URL("../build/icons", import.meta.url)),
    },
    dedupe: ["react", "react-dom"],
  },
  server: { port: 5180, strictPort: true, fs: { allow: [repoRoot] } },
  preview: { port: 5181, strictPort: true },
});
