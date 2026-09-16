import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(directory, "..", "src", "App.jsx"), "utf8");

assert.match(source, /jobNeedsStringValueColumn\(config\.methodCalls, interfaceDetails\)/);
assert.match(source, /needsStringValueColumn \? "STR_VALUE" : ""/);
assert.doesNotMatch(source, /current\.database\.valueColumn === "VALUE" && current\.database\.stringValueColumn === "STR_VALUE"/);
assert.match(source, /defaultColumnSelectionDisabled = !defaultTablesReady \|\| !defaultTableKnown/);
assert.match(source, /Table not found\. It will be created automatically when the job is saved\./);
assert.match(source, /failure\?\.details\?\.problem/);
assert.match(source, /app\.openCreateModal\(`db-server:\$\{configForSave\.database\.server\}`\)/);

console.log("Job table provisioning frontend contract: ok");
