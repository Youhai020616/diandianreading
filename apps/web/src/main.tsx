import { createRoot } from "react-dom/client";
import { App } from "./App";
import { startBootstrap } from "./lib/bootstrap";
import { AppController } from "./state/controller";
import "./app.css";

// Mirrors the legacy app.js top-of-module behaviour: the one-time nonce is
// taken from the URL fragment and exchanged before the UI finishes mounting.
const bootstrapTask = startBootstrap();
const controller = new AppController();

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<App controller={controller} bootstrapTask={bootstrapTask} />);
}
