import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createDefaultJobConfig } from "../src/model.js";
import * as generic from "../../products/generic/frontend/model.mjs";
import * as ls from "../../products/ls/frontend/model.mjs";

const databaseServer = {
  name: "localhost",
  defaultTable: "TAG",
  defaultValueColumn: "VALUE",
  defaultStringValueColumn: "STR_VALUE",
};

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profilePath = path.join(frontendRoot, "..", "products", "ls", "provider.json");

function loadLsProfile() {
  assert.equal(fs.existsSync(profilePath), true, "LS Provider Profile source가 필요합니다.");
  return JSON.parse(fs.readFileSync(profilePath, "utf8"));
}

test("설정 실패는 제품과 관계없이 blocked mode다", () => {
  const context = { settings: null, settingsLoading: false, settingsError: { code: "PROVIDER_PROFILE_INVALID" }, editing: false };
  assert.equal(generic.resolveJobFormMode(context), "blocked");
  assert.equal(ls.resolveJobFormMode(context), "blocked");
});

test("LS fixed Provider는 새 Job과 기존 Job 편집 모두 fixed다", () => {
  const settings = { provider: loadLsProfile() };
  assert.equal(ls.resolveJobFormMode({ settings, settingsLoading: false, settingsError: null, editing: false }), "fixed");
  assert.equal(ls.resolveJobFormMode({ settings, settingsLoading: false, settingsError: null, editing: true }), "fixed");
});

test("generic 새 Job은 Database 기본값만 복사한다", () => {
  const config = createDefaultJobConfig(null, databaseServer, generic.createInitialMethodCalls(null));
  assert.deepEqual(config.database, {
    server: "localhost",
    table: "TAG",
    valueColumn: "VALUE",
    stringValueColumn: "STR_VALUE",
  });
  assert.deepEqual(config.methodCalls, []);
});

test("LS 새 Job은 제품의 고정 Call을 공유하지 않고 복사한다", () => {
  const profile = loadLsProfile();
  const config = createDefaultJobConfig(profile, databaseServer, ls.createInitialMethodCalls(profile));
  assert.equal(config.methodCalls[0].interfaceId, "ls-plc-device");
  assert.deepEqual(config.methodCalls[0].inputs, { DeviceString: "%MB0", DataCount: 1 });
  assert.deepEqual(config.methodCalls[0].outputSelections[0].tags.map((tag) => tag.name), ["MB0"]);
  config.methodCalls[0].outputSelections[0].tags.push({ name: "MB3" });
  assert.deepEqual(profile.outputSelections[0].tags, []);
});

test("LS 제품은 %로 시작하고 숫자로 끝나는 주소를 Tag로 확장한다", () => {
  const profile = loadLsProfile();
  const tags = ls.reconcileProductTags({ DeviceString: "%MB3", DataCount: 3 }, [], profile);
  assert.deepEqual(tags.map((tag) => tag.name), ["MB3", "MB4", "MB5"]);
  assert.ok(tags.every((tag) => tag.nameMode === "auto"));
  assert.deepEqual(ls.reconcileProductTags({ DeviceString: "MB3", DataCount: 2 }, [], profile), []);
});

test("제품 입력 경계는 LS DeviceString에만 고정 % 접두사를 적용한다", () => {
  assert.equal(generic.inputPrefix("DeviceString"), "");
  assert.equal(generic.displayInputValue("DeviceString", "%MB3"), "%MB3");
  assert.equal(generic.storeInputValue("DeviceString", "MB3"), "MB3");

  assert.equal(ls.inputPrefix("DeviceString"), "%");
  assert.equal(ls.displayInputValue("DeviceString", "%MB3"), "MB3");
  assert.equal(ls.storeInputValue("DeviceString", "MB3"), "%MB3");
  assert.equal(ls.inputPrefix("DataCount"), "");
  assert.equal(ls.displayInputValue("DataCount", 3), 3);
  assert.equal(ls.storeInputValue("DataCount", 3), 3);
});

test("LS DeviceString만 마우스 주소 선택기 설정을 제공한다", () => {
  assert.equal(generic.deviceStringBuilder("DeviceString"), null);
  assert.equal(ls.deviceStringBuilder("DataCount"), null);
  assert.deepEqual(ls.deviceStringBuilder("DeviceString"), {
    memoryAreas: ["A", "F", "I", "Q", "M", "K", "R", "W"],
    dataTypes: ["X", "B", "W", "D", "L"],
  });
});

test("LS 제품은 수동 이름을 같은 위치에 유지하고 범위를 벗어난 Tag는 제거한다", () => {
  const profile = loadLsProfile();
  const existing = [
    { name: "MB3", nameMode: "auto", bias: 0, multiplier: 1, transformOrder: ["bias", "multiplier"] },
    { name: "LINE_SPEED", nameMode: "manual", bias: 2, multiplier: 3, transformOrder: ["multiplier", "bias"] },
    { name: "MB5", nameMode: "auto", bias: 0, multiplier: 1, transformOrder: ["bias", "multiplier"] },
  ];
  const tags = ls.reconcileProductTags({ DeviceString: "%MB10", DataCount: 2 }, existing, profile);
  assert.deepEqual(tags.map((tag) => tag.name), ["MB10", "LINE_SPEED"]);
  assert.equal(tags[1].bias, 2);
  assert.equal(tags[1].multiplier, 3);
});

test("generic 제품은 LS Tag 규칙을 적용하지 않는다", () => {
  const existing = [{ name: "KEEP", nameMode: "manual" }];
  assert.deepEqual(generic.reconcileProductTags({ DeviceString: "%MB3", DataCount: 3 }, existing), existing);
});
