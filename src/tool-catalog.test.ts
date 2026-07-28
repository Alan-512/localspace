import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { ToolMode, ToolPack, WidgetMode } from "./config.js";
import {
  renderToolSurfacesMarkdown,
  toolCatalog,
  toolNames,
  toolNamesForMode,
} from "./tool-catalog.js";
import { buildServerInstructions } from "./server.js";

const baseline = JSON.parse(
  await readFile(new URL("../docs/baselines/v1.0.6-tool-surfaces.json", import.meta.url), "utf8"),
) as {
  widgetsOff: Record<ToolMode, string[]>;
  widgetsChangesAdds: string[];
  widgetsFullAdds: string[];
};
const additions = JSON.parse(
  await readFile(new URL("../docs/baselines/v1.1-tool-surface-additions.json", import.meta.url), "utf8"),
) as {
  baseVersion: string;
  widgetsOffAdds: Record<ToolMode, string[]>;
  toolPackAdds: Record<ToolPack, string[]>;
};
assert.equal(additions.baseVersion, "v1.0.6");

for (const mode of ["minimal", "full", "codex", "hybrid"] as const) {
  const expected = [...baseline.widgetsOff[mode], ...additions.widgetsOffAdds[mode]];
  assert.deepEqual(
    sorted(toolNamesForMode(mode, "off")),
    sorted(expected),
    `${mode} catalog differs from the frozen v1.0.6 baseline plus approved v1.1 additions`,
  );
  assert.deepEqual(
    sorted(toolNamesForMode(mode, "changes")),
    sorted([...expected, ...baseline.widgetsChangesAdds]),
    `${mode} changes overlay differs from the approved current surface`,
  );
  assert.deepEqual(
    sorted(toolNamesForMode(mode, "full")),
    sorted([...expected, ...baseline.widgetsFullAdds]),
    `${mode} full widget mode differs from the approved current surface`,
  );
}

for (const mode of ["minimal", "full", "codex", "hybrid"] as const) {
  assert.deepEqual(
    sorted(toolNamesForMode(mode, "off", ["code-intelligence"])),
    sorted([
      ...baseline.widgetsOff[mode],
      ...additions.widgetsOffAdds[mode],
      ...additions.toolPackAdds["code-intelligence"],
    ]),
    `${mode} code-intelligence pack differs from the approved optional surface`,
  );
}

assert.equal(new Set(toolCatalog.map((tool) => tool.name)).size, toolCatalog.length);
for (const tool of toolCatalog) {
  assert.ok(tool.summary.length >= 20, `${tool.name} summary is too short`);
  assert.doesNotMatch(tool.summary, /call open_workspace first/i, `${tool.name} repeats shared workspace guidance`);
}

const generatedDoc = await readFile(new URL("../docs/tool-surfaces.md", import.meta.url), "utf8");
assert.equal(generatedDoc.replaceAll("\r\n", "\n"), renderToolSurfacesMarkdown());

for (const mode of ["minimal", "full", "codex", "hybrid"] as const) {
  for (const widgets of ["off", "changes", "full"] as const satisfies readonly WidgetMode[]) {
    const available = new Set(toolNamesForMode(mode, widgets));
    const instructions = buildServerInstructions({
      toolMode: mode,
      toolPacks: [],
      widgets,
      skillsEnabled: true,
    });
    for (const tool of toolCatalog) {
      if (containsToolName(instructions, tool.name)) {
        assert.ok(available.has(tool.name), `${mode}/${widgets} instructions mention unavailable ${tool.name}`);
      }
    }
  }
}

const codexInstructions = buildServerInstructions({
  toolMode: "codex",
  toolPacks: [],
  widgets: "off",
  skillsEnabled: true,
});
for (const unavailable of [
  toolNames.nextSteps,
  toolNames.validatePlan,
  toolNames.validationSummary,
  toolNames.reviewChecklist,
  toolNames.taskSummary,
  toolNames.finalReport,
  toolNames.handoffSummary,
]) {
  assert.equal(containsToolName(codexInstructions, unavailable), false, `codex instructions mention ${unavailable}`);
}

const hybridInstructions = buildServerInstructions({
  toolMode: "hybrid",
  toolPacks: [],
  widgets: "off",
  skillsEnabled: true,
});
for (const available of [
  toolNames.nextSteps,
  toolNames.validationSummary,
  toolNames.finalReport,
  toolNames.handoffSummary,
]) {
  assert.equal(containsToolName(hybridInstructions, available), true, `hybrid instructions omit ${available}`);
}
for (const unavailable of [
  toolNames.validatePlan,
  toolNames.reviewChecklist,
  toolNames.taskSummary,
]) {
  assert.equal(containsToolName(hybridInstructions, unavailable), false, `hybrid instructions mention ${unavailable}`);
}

const codeIntelligenceInstructions = buildServerInstructions({
  toolMode: "hybrid",
  toolPacks: ["code-intelligence"],
  widgets: "off",
  skillsEnabled: true,
});
for (const name of [
  toolNames.diagnostics,
  toolNames.definition,
  toolNames.implementations,
  toolNames.renamePreview,
]) {
  assert.equal(containsToolName(codeIntelligenceInstructions, name), true);
}

const concurrencyInstructions = buildServerInstructions({
  toolMode: "hybrid",
  toolPacks: ["code-intelligence"],
  widgets: "changes",
  skillsEnabled: true,
  concurrency: {
    maxConcurrentToolCalls: 11,
    maxConcurrentScans: 3,
    maxConcurrentProcesses: 5,
    maxWorkspaceProcesses: 2,
    queueTimeoutMs: 9_000,
  },
});
assert.match(concurrencyInstructions, /up to 11 tool calls globally/);
assert.match(concurrencyInstructions, /queue for at most 9000 ms/);
assert.match(concurrencyInstructions, /capped at 3 scans/);
assert.match(concurrencyInstructions, /limited to 5 globally and 2 per workspace/);
for (const name of [
  toolNames.read,
  toolNames.grep,
  toolNames.gitStatus,
  toolNames.symbols,
  toolNames.diagnostics,
  toolNames.applyPatch,
  toolNames.gitCommit,
  toolNames.execCommand,
  toolNames.runChecks,
  toolNames.writeStdin,
]) {
  assert.equal(containsToolName(concurrencyInstructions, name), true, `concurrency guidance omits ${name}`);
}
assert.match(concurrencyInstructions, /Prefer `read_many` for multiple known files/);
assert.match(concurrencyInstructions, /Prefer `run_checks` for independent declared package scripts/);
assert.match(concurrencyInstructions, /same process session must be sequential/);
assert.match(concurrencyInstructions, /mode=worktree/);

function containsToolName(text: string, name: string): boolean {
  return text.includes(`\`${name}\``);
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}
