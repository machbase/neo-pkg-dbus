import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseBuildArguments(argumentsList) {
  const result = { target: null, outputRoot: null };
  for (const argument of argumentsList) {
    if (/^--target=(generic|ls)$/.test(argument) && result.target === null) result.target = argument.slice("--target=".length);
    else if (argument.startsWith("--output=") && argument.length > "--output=".length && result.outputRoot === null) result.outputRoot = path.resolve(argument.slice("--output=".length));
    else throw new Error(`Unsupported frontend build option: ${argument}`);
  }
  if (!result.target || !result.outputRoot) throw new Error("Frontend build requires --target and --output.");
  return result;
}

export function buildFrontend({ target, outputRoot, spawn = spawnSync }) {
  const vite = path.join(frontendRoot, "node_modules", "vite", "bin", "vite.js");
  for (const mode of ["index", "main", "side"]) {
    const result = spawn(process.execPath, [vite, "build", "--mode", mode], {
      cwd: frontendRoot,
      stdio: "inherit",
      env: { ...process.env, DBUS_PRODUCT_TARGET: target, DBUS_OUTPUT_ROOT: outputRoot },
    });
    if (result.status !== 0) throw new Error(`Vite ${mode} build failed for ${target}.`);
  }
}

function main() {
  buildFrontend(parseBuildArguments(process.argv.slice(2)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
