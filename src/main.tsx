import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { BrowserMenuOverlay } from "./components/BrowserMenuOverlay";
import { PetOverlayApp } from "./components/PetOverlayApp";
import "./styles.css";

const isPetMode = window.location.hash === "#pet";
const isBrowserMenuMode = window.location.hash === "#browser-menu";

if (isPetMode || isBrowserMenuMode) {
  document.documentElement.classList.add("pet-mode");
  document.body.classList.add("pet-mode");
}

try {
  const savedTheme = window.localStorage.getItem("diandian.theme") === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = savedTheme;
  document.documentElement.classList.toggle("dark", savedTheme === "dark");
  document.documentElement.classList.toggle("light", savedTheme === "light");
} catch {
  document.documentElement.dataset.theme = "light";
  document.documentElement.classList.add("light");
}

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Missing #root element");
}

createRoot(rootEl).render(
  <StrictMode>
    {isPetMode ? <PetOverlayApp /> : isBrowserMenuMode ? <BrowserMenuOverlay /> : <App />}
  </StrictMode>,
);
