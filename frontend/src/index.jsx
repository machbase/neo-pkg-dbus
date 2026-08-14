import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router";
import { CombinedApp } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <HashRouter><CombinedApp /></HashRouter>
  </React.StrictMode>
);
