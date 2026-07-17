import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./server.ts", import.meta.url), "utf8");

const expectedSchemas = new Map([
  ["toolNames.read", "resultOutputSchema"],
  ["toolNames.doctor", "doctorStructuredOutputSchema"],
  ["toolNames.workspaceInfo", "workspaceInfoStructuredOutputSchema"],
  ["toolNames.projectMap", "resultOutputSchema"],
  ["toolNames.symbols", "symbolsStructuredOutputSchema"],
  ["toolNames.imports", "importsStructuredOutputSchema"],
  ["toolNames.references", "referencesStructuredOutputSchema"],
  ["\"show_changes\"", "resultOutputSchema"],
  ["toolNames.changes", "changesStructuredOutputSchema"],
  ["toolNames.gitStatus", "gitStatusStructuredOutputSchema"],
  ["toolNames.gitDiff", "gitDiffStructuredOutputSchema"],
  ["toolNames.gitAdd", "gitAddStructuredOutputSchema"],
  ["toolNames.gitCommit", "gitCommitStructuredOutputSchema"],
  ["toolNames.gitLog", "gitLogStructuredOutputSchema"],
]);

for (const [toolRef, expectedSchema] of expectedSchemas) {
  assert.equal(outputSchemaNameForTool(toolRef), expectedSchema, `${toolRef} outputSchema`);
}

assert.equal(toolWidgetKindForTool('"open_workspace"'), '"open_workspace"');
assert.equal(toolWidgetKindForTool("toolNames.doctor"), '"workspace"');
assert.equal(toolWidgetKindForTool('"exec_command"'), '"shell"');
assert.equal(toolWidgetKindForTool('"write_stdin"'), '"shell"');
assert.equal(toolWidgetKindForTool('"show_changes"'), '"show_changes"');
assert.match(source, /case "changes":\s*return kind === "open_workspace" \|\| kind === "show_changes";/);

function outputSchemaNameForTool(toolRef: string): string {
  const registrationPattern = new RegExp(
    `registerAppTool\\(\\s*server,\\s*${escapeRegExp(toolRef)}\\s*,\\s*\\{([\\s\\S]*?)\\n\\s*\\},\\s*async`,
    "m",
  );
  const registration = registrationPattern.exec(source);
  assert.ok(registration, `Missing registerAppTool block for ${toolRef}`);

  const descriptor = registration[1] ?? "";
  const outputSchema = /outputSchema:\s*([A-Za-z0-9_]+)/.exec(descriptor);
  assert.ok(outputSchema, `Missing outputSchema for ${toolRef}`);
  return outputSchema[1] ?? "";
}

function toolWidgetKindForTool(toolRef: string): string {
  const registrationPattern = new RegExp(
    `registerAppTool\\(\\s*server,\\s*${escapeRegExp(toolRef)}\\s*,\\s*\\{([\\s\\S]*?)\\n\\s*\\},\\s*async`,
    "m",
  );
  const registration = registrationPattern.exec(source);
  assert.ok(registration, `Missing registerAppTool block for ${toolRef}`);

  const descriptor = registration[1] ?? "";
  const widgetMeta = /toolWidgetDescriptorMeta\(config,\s*("[^"]+")\)/.exec(descriptor);
  assert.ok(widgetMeta, `Missing widget metadata for ${toolRef}`);
  return widgetMeta[1] ?? "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
