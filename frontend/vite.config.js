import { resolve } from "node:path";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import neoProxy from "./neo-proxy.json";

export default defineConfig(({ mode }) => {
  const entries = ["index", "main", "side"];
  const entry = entries.includes(mode) ? mode : "index";
  const productTarget = process.env.DBUS_PRODUCT_TARGET || "generic";
  const outputRoot = process.env.DBUS_OUTPUT_ROOT || "..";
  if (!["generic", "ls"].includes(productTarget)) throw new Error(`Unsupported product target: ${productTarget}`);
  return {
    resolve: {
      alias: {
        "@product": resolve(import.meta.dirname, "..", "products", productTarget, "frontend", "index.jsx"),
      },
    },
    plugins: [tailwindcss(), viteSingleFile()],
    server: {
      proxy: neoProxy,
    },
    build: {
      outDir: outputRoot,
      emptyOutDir: false,
      cssCodeSplit: false,
      rollupOptions: {
        input: resolve(import.meta.dirname, `${entry}.html`)
      }
    }
  };
});
