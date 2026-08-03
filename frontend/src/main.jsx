import React from "react";
import { createRoot } from "react-dom/client";
import { StarterView } from "./StarterView";
import "./styles.css";

function Main() {
  return (
    <main className="starter-entry" aria-label="Main package view">
      <StarterView surface="main" />
    </main>
  );
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode><Main /></React.StrictMode>
);
