import assert from "node:assert/strict";
import test from "node:test";

import { applyLsTagCsv } from "../../products/ls/frontend/tagCsv.mjs";
import { tagCsvImporter as genericImporter } from "../../products/generic/frontend/model.mjs";
import { tagCsvImporter as lsImporter } from "../../products/ls/frontend/model.mjs";
import { createDefaultJobConfig, serializeJobConfig } from "../src/model.js";

const tags = [
  { name: "MB0", nameMode: "auto", bias: 0, multiplier: 1, transformOrder: ["bias", "multiplier"] },
  { name: "MB1", nameMode: "auto", bias: 0, multiplier: 1, transformOrder: ["bias", "multiplier"] },
  { name: "MB2", nameMode: "auto", bias: 0, multiplier: 1, transformOrder: ["bias", "multiplier"] },
];

test("LS CSV 기본값과 order를 기존 Tag 저장 구조로 바꾼다", () => {
  const result = applyLsTagCsv(
    "name,bias,multiplier,order\nTAG_A,,,\nTAG_B,10,2,1\n",
    tags,
    3,
  );
  assert.deepEqual(result[0], {
    ...tags[0], name: "TAG_A", nameMode: "manual", bias: 0, multiplier: 1,
    transformOrder: ["bias", "multiplier"], signed: false,
  });
  assert.deepEqual(result[1], {
    ...tags[1], name: "TAG_B", nameMode: "manual", bias: 10, multiplier: 2,
    transformOrder: ["multiplier", "bias"], signed: false,
  });
  assert.deepEqual(result[2], tags[2]);
});

test("LS CSV는 DataCount 초과 행을 의미 검증하지 않고 무시한다", () => {
  const result = applyLsTagCsv(
    "name,bias,multiplier,order\nFIRST,1,2,0\nIGNORED,broken,broken,9\n",
    tags,
    1,
  );
  assert.equal(result[0].name, "FIRST");
  assert.deepEqual(result.slice(1), tags.slice(1));
});

test("LS CSV 적용 대상 오류는 원본을 바꾸지 않는다", () => {
  const before = structuredClone(tags);
  assert.throws(
    () => applyLsTagCsv("name,bias,multiplier,order\n,0,1,0\n", tags, 3),
    (error) => error.code === "TAG_CSV_NAME_REQUIRED" && error.row === 2,
  );
  assert.deepEqual(tags, before);
});

test("LS CSV는 BOM, CRLF, quote와 escaped quote를 읽는다", () => {
  const result = applyLsTagCsv("\uFEFFname,bias,multiplier,order\r\n\"TAG\"\"A\",0,1,0\r\n", tags, 3);
  assert.equal(result[0].name, 'TAG"A');
});

test("LS CSV는 헤더가 정확하지 않으면 거부한다", () => {
  assert.throws(
    () => applyLsTagCsv("name,multiplier,bias,order\nTAG,1,0,0\n", tags, 3),
    (error) => error.code === "TAG_CSV_HEADER_INVALID" && error.row === 1,
  );
});

test("LS CSV는 적용할 데이터 행이 없으면 거부한다", () => {
  assert.throws(
    () => applyLsTagCsv("name,bias,multiplier,order\n", tags, 3),
    (error) => error.code === "TAG_CSV_EMPTY",
  );
});

for (const [column, csv] of [
  ["bias", "TAG,NaN,1,0"],
  ["multiplier", "TAG,0,Infinity,0"],
]) {
  test(`LS CSV는 유한하지 않은 ${column}를 거부한다`, () => {
    assert.throws(
      () => applyLsTagCsv(`name,bias,multiplier,order\n${csv}\n`, tags, 3),
      (error) => error.code === "TAG_CSV_NUMBER_INVALID" && error.row === 2 && error.column === column,
    );
  });
}

test("LS CSV는 0 또는 1이 아닌 order를 거부한다", () => {
  assert.throws(
    () => applyLsTagCsv("name,bias,multiplier,order\nTAG,0,1,2\n", tags, 3),
    (error) => error.code === "TAG_CSV_ORDER_INVALID" && error.row === 2,
  );
});

test("LS CSV는 닫히지 않은 quote를 거부한다", () => {
  assert.throws(
    () => applyLsTagCsv('name,bias,multiplier,order\n"TAG,0,1,0\n', tags, 3),
    (error) => error.code === "TAG_CSV_STRUCTURE_INVALID",
  );
});

test("제품 경계는 LS에만 importer를 제공한다", () => {
  assert.equal(genericImporter, null);
  assert.equal(lsImporter.apply, applyLsTagCsv);
});

test("LS CSV 결과는 기존 Job Tag 형식만 직렬화한다", () => {
  const imported = applyLsTagCsv("name,bias,multiplier,order\nCUSTOM,2,3,1\n", tags, 1);
  const config = createDefaultJobConfig(null, "localhost");
  config.methodCalls = [{
    id: "get-device-data-1",
    name: "get-device-data-1",
    interfaceId: "ls-plc-device",
    methodId: "get-device-data",
    inputs: { DeviceString: "%MB0", DataCount: 1 },
    outputSelections: [{
      id: "return-data",
      sourceIndex: 0,
      interpretation: "json",
      selector: "/data",
      valueType: "array",
      elementType: "numeric",
      tags: imported,
    }],
  }];

  assert.deepEqual(serializeJobConfig(config).methodCalls[0].outputSelections[0].tags[0], {
    name: "CUSTOM",
    bias: 2,
    multiplier: 3,
    transformOrder: ["multiplier", "bias"],
    signed: false,
  });
});
