import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { ToolMode, WidgetMode } from "./config.js";
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
    const instructions = buildServerInstructions({ toolMode: mode, widgets, skillsEnabled: true });
    for (const tool of toolCatalog) {
      if (containsToolName(instructions, tool.name)) {
        assert.ok(available.has(tool.name), `${mode}/${widgets} instructions mention unavailable ${tool.name}`);
      }
    }
  }
}

for (const mode of ["codex", "hybrid"] as const) {
  const instructions = buildServerInstructions({ toolMode: mode, widgets: "off", skillsEnabled: true });
  for (const unavailable of [
    toolNames.nextSteps,
    toolNames.validatePlan,
    toolNames.validationSummary,
    toolNames.reviewChecklist,
    toolNames.taskSummary,
    toolNames.finalReport,
    toolNames.handoffSummary,
  ]) {
    assert.equal(containsToolName(instructions, unavailable), false, `${mode} instructions mention ${unavailable}`);
  }
}

function containsToolName(text: string, name: string): boolean {
  return text.includes(`\`${name}\``);
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}
