import type { GenerateCommitMetadataInput, MutationTelemetry } from "./types.js";

export function buildCommitMetadataPrompt(input: GenerateCommitMetadataInput): string {
  return [
    "You are generating commit metadata for DevSpace autocommit.",
    "Use the diff as the source of truth.",
    "Use the mutation summary only to understand intent.",
    "Do not mention changes not visible in the diff.",
    "Return JSON only.",
    "Do not edit files.",
    "Do not run commands.",
    "",
    "Commit convention:",
    "- Conventional Commit subject.",
    "- Lowercase type.",
    "- Optional scope.",
    "- Subject <= 72 characters.",
    "- Body optional.",
    "",
    "Expected JSON shape:",
    JSON.stringify(
      {
        shouldCommit: true,
        type: "feat|fix|refactor|docs|test|chore|style|build|perf|ci",
        scope: "optional-scope",
        subject: "short imperative subject without type/scope prefix",
        body: "optional commit body",
        files: ["path/to/file.ts"],
        reason: "why this should or should not be committed",
      },
      null,
      2,
    ),
    "",
    "Mutation summary:",
    formatMutations(input.mutations),
    "",
    "Git status:",
    fence(input.status || "clean"),
    "",
    "Diff stat:",
    fence(input.diffStat || "empty"),
    "",
    "Diff:",
    fence(input.diff || "empty"),
  ].join("\n");
}

function formatMutations(mutations: MutationTelemetry[]): string {
  if (mutations.length === 0) return "- none";

  return mutations.map((mutation) => {
    if (mutation.tool === "bash") {
      const exitCode = mutation.exitCode === undefined ? "unknown" : String(mutation.exitCode);
      return `- bash ${JSON.stringify(mutation.command)} in ${mutation.workingDirectory} (exit ${exitCode})`;
    }

    const stats = [
      mutation.additions === undefined ? undefined : `+${mutation.additions}`,
      mutation.removals === undefined ? undefined : `-${mutation.removals}`,
    ].filter(Boolean).join(" ");
    const suffix = stats ? ` (${stats})` : "";
    return `- ${mutation.tool} ${mutation.path}${suffix}`;
  }).join("\n");
}

function fence(value: string): string {
  return `\`\`\`\n${value}\n\`\`\``;
}
