import { resolve } from "node:path";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import neoProxy from "./neo-proxy.json";

export default defineConfig(({ mode }) => {
  const entries = ["index", "main", "side"];
  const entry = entries.includes(mode) ? mode : "index";
  return {
    plugins: [tailwindcss(), viteSingleFile()],
    server: {
      proxy: neoProxy,
    },
    build: {
      outDir: "..",
      emptyOutDir: false,
      cssCodeSplit: false,
      rollupOptions: {
        input: resolve(import.meta.dirname, `${entry}.html`)
      }
    }
  };
});
