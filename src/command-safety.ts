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
    pattern: /(^|[;&|\n])\s*(format\b|mkfs\b|diskpart\b)/i,
    message: "Can modify disks or filesystems outside the workspace.",
  },
  {
    level: "danger",
    category: "git",
    pattern: /\bgit\s+(reset\s+--hard|clean\s+-[^\n;|&]*[fd]|push\b[^\n;|&]*(--force|-f)\b|branch\s+-D\b)/i,
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

  return {
    level: findings.reduce<CommandRiskLevel>(
      (current, finding) => (LEVEL_SCORE[finding.level] > LEVEL_SCORE[current] ? finding.level : current),
      "none",
    ),
    findings,
  };
}

export function formatCommandSafetyWarning(analysis: CommandSafetyAnalysis): string | undefined {
  if (analysis.level === "none") return undefined;
  const lines = [`Command safety: ${analysis.level.toUpperCase()}`];
  for (const finding of analysis.findings) {
    lines.push(`- ${finding.level.toUpperCase()} ${finding.category}: ${finding.message}`);
  }
  return lines.join("\n");
}
