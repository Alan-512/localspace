export type CommandRiskLevel = "none" | "notice" | "warning" | "danger";

export interface CommandSafetyFinding {
  level: Exclude<CommandRiskLevel, "none">;
  category: string;
  message: string;
}

export interface CommandSafetyAnalysis {
  level: CommandRiskLevel;
  findings: CommandSafetyFinding[];
}

interface Rule {
  level: Exclude<CommandRiskLevel, "none">;
  category: string;
  pattern: RegExp;
  message: string;
}

const RULES: Rule[] = [
  {
    level: "danger",
    category: "filesystem",
    pattern: /(^|[;&|\n])\s*(rm\s+(-[^\n;|&]*[rf][^\n;|&]*|-[^\n;|&]*[fr][^\n;|&]*)|rimraf|rd\s+\/s|rmdir\s+\/s|del\s+\/s|remove-item\b[^\n;|&]*\b-recurse\b[^\n;|&]*\b-force\b)/i,
    message: "Deletes files recursively or forcefully. Verify the target path is scoped to the workspace.",
  },
  {
    level: "danger",
    category: "filesystem",
    pattern: /(^|[;&|\n])\s*(format(?:\.com)?(?=\s|$)|mkfs\b|diskpart\b)/i,
    message: "Can modify disks or filesystems outside the workspace.",
  },
  {
    level: "danger",
    category: "git",
    pattern: /\bgit\s+(reset\s+--hard|push\b[^\n;|&]*(--force|-f)\b|branch\s+-D\b)/i,
    message: "Can discard history, delete untracked files, or force-update a remote branch.",
  },
  {
    level: "warning",
    category: "git",
    pattern: /\bgit\s+(rebase|checkout\s+-f|restore\b[^\n;|&]*\s--worktree|switch\b[^\n;|&]*\s--discard-changes)\b/i,
    message: "Can rewrite history or discard local workspace changes.",
  },
  {
    level: "warning",
    category: "publish/deploy",
    pattern: /\b(npm|pnpm|yarn|bun)\s+publish\b|\b(vercel\b[^\n;|&]*\s--prod|wrangler\s+deploy|firebase\s+deploy|netlify\s+deploy|docker\s+push)\b/i,
    message: "Can publish or deploy externally. Confirm target account, project, and environment.",
  },
  {
    level: "warning",
    category: "privilege",
    pattern: /(^|[;&|\n])\s*(sudo\b|runas\b|set-executionpolicy\b|start-process\b[^\n;|&]*\b-verb\s+runas\b)/i,
    message: "Requests elevated privileges or changes system-level execution policy.",
  },
  {
    level: "warning",
    category: "permissions",
    pattern: /\bchmod\s+(-R\s+)?777\b/i,
    message: "Can make files broadly writable. Prefer narrower permissions.",
  },
  {
    level: "notice",
    category: "network",
    pattern: /\b(curl|wget|irm|iwr|invoke-webrequest|invoke-restmethod)\b[^\n;|&]*(\||>)/i,
    message: "Downloads or pipes remote content. Verify the URL and destination before executing.",
  },
  {
    level: "notice",
    category: "shell-write",
    pattern: /(^|\s)(>|>>|tee\b|sed\s+-i\b|perl\s+-i\b)/i,
    message: "Writes files through the shell. Prefer apply_patch for project file modifications.",
  },
];

const LEVEL_SCORE: Record<CommandRiskLevel, number> = {
  none: 0,
  notice: 1,
  warning: 2,
  danger: 3,
};

const GIT_COMMIT_EXECUTABLE = new RegExp(
  String.raw`^git(?:\s+(?:-C\s+(?:"[^"]+"|'[^']+'|\S+)|-c\s+\S+|--(?:git-dir|work-tree|namespace)(?:=\S+|\s+\S+)|--(?:no-pager|paginate|literal-pathspecs|glob-pathspecs|noglob-pathspecs|icase-pathspecs)))*\s+commit(?=\s|$)`,
  "i",
);

export function commandInvokesGitCommit(command: string): boolean {
  return command
    .split(/&&|\|\||[;|\n]/)
    .some((segment) => segmentInvokesGitCommit(segment));
}

function segmentInvokesGitCommit(segment: string): boolean {
  let normalized = segment
    .trim()
    .replace(/^[('"`]+/, "")
    .replace(/[)'"`]+$/, "")
    .trim();
  if (!normalized) return false;

  const shellWrapper = /^(?:sh|bash|zsh|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh)\b[\s\S]*?(?:-c|\/c|-command)\s+["']?([\s\S]+)$/i.exec(normalized);
  if (shellWrapper?.[1]) return commandInvokesGitCommit(shellWrapper[1]);

  normalized = normalized.replace(/^(?:command|sudo|npx)\s+/i, "");
  normalized = normalized.replace(/^env(?:\s+[A-Za-z_][A-Za-z0-9_]*=\S+)*\s+/i, "");
  return GIT_COMMIT_EXECUTABLE.test(normalized);
}

export function analyzeCommandSafety(command: string): CommandSafetyAnalysis {
  const normalized = command.trim();
  if (!normalized) return { level: "none", findings: [] };

  const findings: CommandSafetyFinding[] = [];
  const seen = new Set<string>();
  for (const rule of RULES) {
    if (!rule.pattern.test(normalized)) continue;
    const key = `${rule.level}:${rule.category}:${rule.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ level: rule.level, category: rule.category, message: rule.message });
  }

  if (commandInvokesDestructiveGitClean(normalized)) {
    const finding: CommandSafetyFinding = {
      level: "danger",
      category: "git",
      message: "Can discard history, delete untracked files, or force-update a remote branch.",
    };
    const key = `${finding.level}:${finding.category}:${finding.message}`;
    if (!seen.has(key)) findings.push(finding);
  }

  return {
    level: findings.reduce<CommandRiskLevel>(
      (current, finding) => (LEVEL_SCORE[finding.level] > LEVEL_SCORE[current] ? finding.level : current),
      "none",
    ),
    findings,
  };
}

function commandInvokesDestructiveGitClean(command: string): boolean {
  return command
    .split(/&&|\|\||[;|\n]/)
    .some((segment) => {
      const match = /\bgit(?:\s+(?:-C\s+(?:"[^"]+"|'[^']+'|\S+)|-c\s+\S+|--(?:git-dir|work-tree|namespace)(?:=\S+|\s+\S+)|--(?:no-pager|paginate|literal-pathspecs|glob-pathspecs|noglob-pathspecs|icase-pathspecs)))*\s+clean\b([\s\S]*)/i.exec(segment);
      if (!match) return false;
      const args = match[1]?.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
      const dryRun = args.some((arg) => arg === "--dry-run" || /^-[^-]*n/i.test(arg));
      if (dryRun) return false;
      return args.some((arg) => arg === "--force" || /^-[^-]*f/i.test(arg));
    });
}

export function formatCommandSafetyWarning(analysis: CommandSafetyAnalysis): string | undefined {
  if (analysis.level === "none") return undefined;
  const lines = [`Command safety: ${analysis.level.toUpperCase()}`];
  for (const finding of analysis.findings) {
    lines.push(`- ${finding.level.toUpperCase()} ${finding.category}: ${finding.message}`);
  }
  return lines.join("\n");
}
