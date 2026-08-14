import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildFrontend, parseBuildArguments } from "../scripts/build-root.mjs";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.resolve(frontendRoot, "..");

test("Frontend build는 명시 target과 output만 허용한다", () => {
  assert.deepEqual(parseBuildArguments(["--target=generic", "--output=./out"]), {
    target: "generic", outputRoot: path.resolve("./out"),
  });
  assert.deepEqual(parseBuildArguments(["--output=./ls-out", "--target=ls"]), {
    target: "ls", outputRoot: path.resolve("./ls-out"),
  });
  assert.throws(() => parseBuildArguments([]), /requires --target and --output/);
  assert.throws(() => parseBuildArguments(["--target=unknown", "--output=./out"]), /Unsupported frontend build option/);
});

test("Frontend build는 세 entry에 같은 target과 output을 전달한다", () => {
  const calls = [];
  buildFrontend({ target: "ls", outputRoot: "/tmp/dbus-build-output", spawn(command, args, options) {
    calls.push({ command, args, env: options.env });
    return { status: 0 };
  } });
  assert.deepEqual(calls.map((call) => call.args.slice(-2)), [["--mode", "index"], ["--mode", "main"], ["--mode", "side"]]);
  assert.ok(calls.every((call) => call.env.DBUS_PRODUCT_TARGET === "ls"));
  assert.ok(calls.every((call) => call.env.DBUS_OUTPUT_ROOT === "/tmp/dbus-build-output"));
});

test("LS 제품 source는 Profile과 읽기 전용 Interface를 함께 가진다", () => {
  const profile = JSON.parse(fs.readFileSync(path.join(packageRoot, "products", "ls", "provider.json"), "utf8"));
  const dbusInterface = JSON.parse(fs.readFileSync(path.join(packageRoot, "products", "ls", "interfaces", "ls-plc-device.json"), "utf8"));
  assert.equal(profile.id, "ls");
  assert.equal(dbusInterface.builtIn, true);
  assert.equal(dbusInterface.methods[0].member, "GetDeviceData");
  assert.equal(dbusInterface.methods[0].inputs[1].validation.pattern, "^%[^%]+[0-9]+$");
});

test("LS main과 index 빌드는 공통 Database 편집 모달을 포함한다", () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dbus-ls-frontend-"));
  try {
    buildFrontend({ target: "ls", outputRoot });
    for (const entry of ["main.html", "index.html"]) {
      assert.match(fs.readFileSync(path.join(outputRoot, entry), "utf8"), /Edit Database/);
    }
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});
