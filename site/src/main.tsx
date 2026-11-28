import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
// 霞鹜文楷 (LXGW WenKai, OFL-1.1), split by unicode-range: a browser fetches only the chunks it needs,
// and none at all when an earlier font in --hand (e.g. macOS 手札体) already covers the text.
import "lxgw-wenkai-webfont/lxgwwenkai-regular.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
