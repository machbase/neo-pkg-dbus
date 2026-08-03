import React from "react";
import { createRoot } from "react-dom/client";
import { StarterView } from "./StarterView";
import "./styles.css";

const hasSide = true;

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <div className={hasSide ? "starter-index starter-index--split" : "starter-index"}>
      {hasSide && (
        <aside className="starter-index-side" aria-label="Side package view">
          <StarterView surface="side" />
        </aside>
      )}
      <main className="starter-index-main" aria-label="Main package view">
        <StarterView surface="main" />
      </main>
    </div>
  </React.StrictMode>
);
