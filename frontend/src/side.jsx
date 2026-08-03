import React from "react";
import { createRoot } from "react-dom/client";
import { StarterView } from "./StarterView";
import "./styles.css";

function Side() {
  return (
    <aside className="starter-entry" aria-label="Side package view">
      <StarterView surface="side" />
    </aside>
  );
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode><Side /></React.StrictMode>
);
