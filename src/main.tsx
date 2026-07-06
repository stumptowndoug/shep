import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { isWindows } from "./lib/platform";
import "./styles/globals.css";

// Set before first paint so platform-specific CSS (titlebar chrome) applies
// without a flash of the wrong layout.
document.documentElement.dataset.platform = isWindows ? "windows" : "mac";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
