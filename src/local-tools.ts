import { constants } from "node:fs";
import {
  spawn,
  execFile,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";
import { createTwoFilesPatch } from "diff";
import { KeyedMutex } from "./concurrency.js";
import { resolveShellCommand, terminateProcessTree } from "./process-platform.js";
import { assertAllowedPath, isPathInsideRoot, resolveAllowedPath } from "./roots.js";

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_LINES = 2_000;
const DEFAULT_MAX_BYTES = 50 * 1024;
const DEFAULT_GREP_LIMIT = 100;
const DEFAULT_GLOB_LIMIT = 1_000;
const DEFAULT_LS_LIMIT = 500;
const MAX_SEARCH_FILES = 50_000;
const MAX_SEARCH_FILE_BYTES = 10 * 1024 * 1024;
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_GREP_LINE_LENGTH = 500;
const MAX_SHELL_BUFFER_BYTES = 1024 * 1024;

const SEARCH_SKIPPED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".localspace",
  ".worktrees",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  ".venv",
  "coverage",
  "target",
]);

const fileMutations = new KeyedMutex();

export interface ReadToolInput {
  path: string;
  offset?: number;
  limit?: number;
}

export interface WriteToolInput {
  path: string;
  content: string;
}

export interface EditToolInput {
  path: string;
  edits: Array<{ oldText: string; newText: string }>;
}

export interface EditToolDetails {
  diff: string;
  patch: string;
  firstChangedLine?: number;
}

export interface GrepToolInput {
  pattern: string;
  path?: string;
  include?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
}

export interface FindToolInput {
  pattern: string;
  path?: string;
  limit?: number;
}

export interface LsToolInput {
  path?: string;
  limit?: number;
}

export interface ShellToolInput {
  command: string;
  timeout?: number;
}

type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type ToolResponse<TDetails = unknown> = {
  content: McpContent[];
  details?: TDetails;
  isError?: boolean;
};

interface ToolContext {
  cwd: string;
  root: string;
  readRoots?: string[];
}

export async function readFileTool(
  input: ReadToolInput,
  context: ToolContext,
): Promise<ToolResponse> {
  return safeTool(async () => {
    const roots = context.readRoots ?? [context.root];
    const requestedPath = resolveAllowedPath(input.path, context.cwd, roots);
    const path = await resolveExistingAllowedPath(requestedPath, roots);
    await access(path, constants.R_OK);
    const buffer = await readFile(path);
    const mimeType = detectImageMimeType(buffer);

    if (mimeType) {
      if (buffer.length > MAX_INLINE_IMAGE_BYTES) {
        return {
          content: [{
            type: "text",
            text: `Read image file [${mimeType}]\n[Image omitted: file exceeds ${formatSize(MAX_INLINE_IMAGE_BYTES)} inline limit.]`,
          }],
        };
      }
      return {
        content: [
          { type: "text", text: `Read image file [${mimeType}]` },
          { type: "image", data: buffer.toString("base64"), mimeType },
        ],
      };
    }

    const text = buffer.toString("utf8");
    const lines = text.split("\n");
    const start = input.offset === undefined ? 0 : Math.max(0, input.offset - 1);
    if (start >= lines.length) {
      throw new Error(`Offset ${input.offset} is beyond end of file (${lines.length} lines total)`);
    }

    const end = input.limit === undefined ? lines.length : Math.min(lines.length, start + input.limit);
    const selected = lines.slice(start, end).join("\n");
    const truncated = truncateHead(selected);
    const startLine = start + 1;
    let output = truncated.content;
    if (truncated.firstLineExceedsLimit) {
      output = `[Line ${startLine} exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use a smaller line range or a bounded shell command.]`;
    } else if (truncated.truncated) {
      const lastLine = startLine + truncated.outputLines - 1;
      output += `\n\n[Showing lines ${startLine}-${lastLine} of ${lines.length}. Use offset=${lastLine + 1} to continue.]`;
    } else if (end < lines.length) {
      output += `\n\n[${lines.length - end} more lines in file. Use offset=${end + 1} to continue.]`;
    }

    return { content: [{ type: "text", text: output }] };
  });
}

export async function writeFileTool(
  input: WriteToolInput,
  context: ToolContext,
): Promise<ToolResponse> {
  return safeTool(async () => {
    const path = resolveAllowedPath(input.path, context.cwd, [context.root]);
    await assertMutationPathAllowed(path, context.root);
    return fileMutations.run(normalizePathKey(path), async () => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, input.content, "utf8");
      return {
        content: [{ type: "text", text: `Successfully wrote ${input.content.length} bytes to ${input.path}` }],
      };
    });
  });
}

export async function editFileTool(
  input: EditToolInput,
  context: ToolContext,
): Promise<ToolResponse<EditToolDetails>> {
  return safeTool(async () => {
    if (!Array.isArray(input.edits) || input.edits.length === 0) {
      throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
    }
    const requestedPath = resolveAllowedPath(input.path, context.cwd, [context.root]);
    const path = await resolveExistingAllowedPath(requestedPath, [context.root]);
    await access(path, constants.R_OK | constants.W_OK);

    return fileMutations.run(normalizePathKey(path), async () => {
      const raw = await readFile(path, "utf8");
      const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
      const withoutBom = bom ? raw.slice(1) : raw;
      const lineEnding = detectLineEnding(withoutBom);
      const original = normalizeLineEndings(withoutBom);
      const replacements = input.edits.map((edit, index) => {
        const oldText = normalizeLineEndings(edit.oldText);
        const newText = normalizeLineEndings(edit.newText);
        if (!oldText) throw new Error(`Edit ${index + 1} has empty oldText.`);
        const first = original.indexOf(oldText);
        if (first < 0) throw new Error(`Could not find exact oldText for edit ${index + 1} in ${input.path}.`);
        if (original.indexOf(oldText, first + oldText.length) >= 0) {
          throw new Error(`oldText for edit ${index + 1} is not unique in ${input.path}.`);
        }
        return { index, start: first, end: first + oldText.length, oldText, newText };
      }).sort((a, b) => a.start - b.start);

      for (let index = 1; index < replacements.length; index += 1) {
        const previous = replacements[index - 1];
        const current = replacements[index];
        if (previous && current && current.start < previous.end) {
          throw new Error(`Edits ${previous.index + 1} and ${current.index + 1} overlap in ${input.path}.`);
        }
      }

      let next = original;
      for (const replacement of [...replacements].reverse()) {
        next = next.slice(0, replacement.start) + replacement.newText + next.slice(replacement.end);
      }

      const restored = bom + restoreLineEndings(next, lineEnding);
      await writeFile(path, restored, "utf8");
      const patch = createTwoFilesPatch(input.path, input.path, original, next, "before", "after", {
        context: 3,
      });
      const firstChangedLine = lineNumberAt(original, replacements[0]?.start ?? 0);
      return {
        content: [{ type: "text", text: `Successfully replaced ${input.edits.length} block(s) in ${input.path}.` }],
        details: { diff: patch, patch, firstChangedLine },
      };
    });
  });
}

export async function grepFilesTool(
  input: GrepToolInput,
  context: ToolContext,
): Promise<ToolResponse> {
  return safeTool(async () => {
    const scope = resolveAllowedPath(input.path ?? ".", context.cwd, [context.root]);
    const files = await collectSearchFiles(scope, context.root);
    const matcher = input.literal
      ? undefined
      : new RegExp(input.pattern, input.ignoreCase ? "i" : "");
    const literal = input.ignoreCase ? input.pattern.toLowerCase() : input.pattern;
    const limit = Math.max(1, Math.floor(input.limit ?? DEFAULT_GREP_LIMIT));
    const contextLines = Math.max(0, Math.floor(input.context ?? 0));
    const output: string[] = [];
    let matches = 0;

    for (const file of files) {
      const relativePath = toPosix(relative(scope, file) || basename(file));
      if (input.include && !matchesFileGlob(relativePath, input.include)) continue;
      const info = await stat(file);
      if (!info.isFile() || info.size > MAX_SEARCH_FILE_BYTES) continue;
      const buffer = await readFile(file);
      if (buffer.subarray(0, 8_192).includes(0)) continue;
      const lines = buffer.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const comparable = input.ignoreCase ? line.toLowerCase() : line;
        const matched = input.literal ? comparable.includes(literal) : Boolean(matcher?.test(line));
        matcher?.lastIndex && (matcher.lastIndex = 0);
        if (!matched) continue;
        matches += 1;
        const start = Math.max(0, index - contextLines);
        const end = Math.min(lines.length - 1, index + contextLines);
        for (let current = start; current <= end; current += 1) {
          const marker = current === index ? ":" : "-";
          const text = truncateLine(lines[current] ?? "");
          output.push(`${relativePath}${marker}${current + 1}${marker} ${text}`);
        }
        if (matches >= limit) break;
      }
      if (matches >= limit) break;
    }

    if (output.length === 0) return { content: [{ type: "text", text: "No matches found" }] };
    let text = truncateHead(output.join("\n"), Number.MAX_SAFE_INTEGER).content;
    if (matches >= limit) text += `\n\n[${limit} matches limit reached]`;
    return { content: [{ type: "text", text }] };
  });
}

export async function findFilesTool(
  input: FindToolInput,
  context: ToolContext,
): Promise<ToolResponse> {
  return safeTool(async () => {
    const scope = resolveAllowedPath(input.path ?? ".", context.cwd, [context.root]);
    const files = await collectSearchFiles(scope, context.root);
    const limit = Math.max(1, Math.floor(input.limit ?? DEFAULT_GLOB_LIMIT));
    const matches = files
      .map((file) => toPosix(relative(scope, file)))
      .filter((file) => file && matchesFileGlob(file, input.pattern))
      .sort((a, b) => a.localeCompare(b))
      .slice(0, limit);

    if (matches.length === 0) {
      return { content: [{ type: "text", text: "No files found matching pattern" }] };
    }
    let text = truncateHead(matches.join("\n"), Number.MAX_SAFE_INTEGER).content;
    if (matches.length >= limit) text += `\n\n[${limit} results limit reached]`;
    return { content: [{ type: "text", text }] };
  });
}

export async function listDirectoryTool(
  input: LsToolInput,
  context: ToolContext,
): Promise<ToolResponse> {
  return safeTool(async () => {
    const requestedPath = resolveAllowedPath(input.path ?? ".", context.cwd, [context.root]);
    const path = await resolveExistingAllowedPath(requestedPath, [context.root]);
    const info = await stat(path);
    if (!info.isDirectory()) throw new Error(`Not a directory: ${path}`);
    const limit = Math.max(1, Math.floor(input.limit ?? DEFAULT_LS_LIMIT));
    const entries = await readdir(path, { withFileTypes: true });
    const results = entries
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
      .slice(0, limit)
      .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`);
    if (results.length === 0) return { content: [{ type: "text", text: "(empty directory)" }] };
    let text = truncateHead(results.join("\n"), Number.MAX_SAFE_INTEGER).content;
    if (entries.length > limit) text += `\n\n[${limit} entries limit reached. Use limit=${limit * 2} for more]`;
    return { content: [{ type: "text", text }] };
  });
}

export async function runShellTool(
  input: ShellToolInput,
  context: ToolContext,
): Promise<ToolResponse> {
  return safeTool(async () => {
    const timeoutSeconds = Math.max(1, Math.min(300, Math.floor(input.timeout ?? 30)));
    const shell = resolveShellCommand(input.command);
    const detached = process.platform !== "win32";
    const result = await new Promise<{ output: string; exitCode: number | null; timedOut: boolean }>((resolvePromise, reject) => {
      const spawnOptions: SpawnOptionsWithoutStdio = {
        cwd: context.cwd,
        env: toolEnvironment(),
        windowsHide: true,
        detached,
      };
      const child: ChildProcessWithoutNullStreams = process.platform === "win32" && !process.env.LOCALSPACE_SHELL
        ? spawn(input.command, [], { ...spawnOptions, shell: shell.executable })
        : spawn(shell.executable, shell.args, spawnOptions);
      child.stdin.end();
      const buffer = new BoundedByteTailBuffer(MAX_SHELL_BUFFER_BYTES);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        terminateProcessTree(child, "SIGTERM", detached);
      }, timeoutSeconds * 1_000);
      timer.unref();
      child.stdout.on("data", (chunk: Buffer) => buffer.append(chunk));
      child.stderr.on("data", (chunk: Buffer) => buffer.append(chunk));
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (exitCode) => {
        clearTimeout(timer);
        resolvePromise({ output: buffer.text(), exitCode, timedOut });
      });
    });
    const output = truncateTail(result.output).content;
    if (result.timedOut) throw new Error(appendStatus(output, `Command timed out after ${timeoutSeconds} seconds`));
    if (result.exitCode !== 0) throw new Error(appendStatus(output, `Command exited with code ${result.exitCode ?? "unknown"}`));
    return { content: [{ type: "text", text: output }] };
  });
}

async function safeTool<TDetails>(
  operation: () => Promise<ToolResponse<TDetails>>,
): Promise<ToolResponse<TDetails>> {
  try {
    return await operation();
  } catch (error) {
    return {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }
}

async function resolveExistingAllowedPath(path: string, roots: string[]): Promise<string> {
  const resolved = await realpath(path);
  return assertAllowedPath(resolved, roots);
}

async function assertMutationPathAllowed(path: string, root: string): Promise<void> {
  let current = path;
  while (true) {
    try {
      const resolved = await realpath(current);
      assertAllowedPath(resolved, [root]);
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
      if (code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function collectSearchFiles(scope: string, workspaceRoot: string): Promise<string[]> {
  const resolvedScope = await resolveExistingAllowedPath(scope, [workspaceRoot]);
  const info = await stat(resolvedScope);
  if (info.isFile()) return [resolvedScope];
  if (!info.isDirectory()) return [];

  const gitFiles = await collectGitFiles(resolvedScope, workspaceRoot);
  if (gitFiles) return gitFiles;
  return collectWalkedFiles(resolvedScope);
}

async function collectGitFiles(scope: string, workspaceRoot: string): Promise<string[] | undefined> {
  try {
    const gitRoot = await detectGitRoot(workspaceRoot);
    const scopePathspec = toPosix(relative(gitRoot, scope)) || ".";
    const output = (await execFileAsync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", scopePathspec],
      { cwd: gitRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    )).stdout;
    const files: string[] = [];
    for (const entry of output.split("\0")) {
      if (!entry) continue;
      const path = resolve(gitRoot, entry);
      if (!isPathInsideRoot(path, workspaceRoot) || !isPathInsideRoot(path, scope)) continue;
      try {
        if ((await lstat(path)).isFile()) files.push(path);
      } catch {
        // Ignore entries removed during discovery.
      }
      if (files.length >= MAX_SEARCH_FILES) break;
    }
    return files.sort((a, b) => a.localeCompare(b));
  } catch {
    return undefined;
  }
}

async function detectGitRoot(workspaceRoot: string): Promise<string> {
  try {
    await lstat(join(workspaceRoot, ".git"));
    return workspaceRoot;
  } catch {
    return (await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd: workspaceRoot,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    })).stdout.trim();
  }
}

async function collectWalkedFiles(root: string): Promise<string[]> {
  const rootIgnoreRules = await loadIgnoreRules(root);
  const files: string[] = [];
  const pending = [root];
  let entriesVisited = 0;
  while (pending.length > 0 && files.length < MAX_SEARCH_FILES) {
    const directory = pending.pop();
    if (!directory) break;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      entriesVisited += 1;
      if (entriesVisited > MAX_SEARCH_FILES * 4) return files.sort((a, b) => a.localeCompare(b));
      const path = join(directory, entry.name);
      const relativePath = toPosix(relative(root, path));
      if (isIgnored(relativePath, entry.isDirectory(), rootIgnoreRules)) continue;
      if (entry.isDirectory()) {
        if (!SEARCH_SKIPPED_DIRS.has(entry.name)) pending.push(path);
      } else if (entry.isFile()) {
        files.push(path);
        if (files.length >= MAX_SEARCH_FILES) break;
      }
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

interface IgnoreRule {
  pattern: string;
  negated: boolean;
  directoryOnly: boolean;
}

async function loadIgnoreRules(root: string): Promise<IgnoreRule[]> {
  try {
    const content = await readFile(join(root, ".gitignore"), "utf8");
    return content.split(/\r?\n/).flatMap((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return [];
      const negated = trimmed.startsWith("!");
      let pattern = negated ? trimmed.slice(1) : trimmed;
      const directoryOnly = pattern.endsWith("/");
      if (directoryOnly) pattern = pattern.slice(0, -1);
      if (pattern.startsWith("/")) pattern = pattern.slice(1);
      return pattern ? [{ pattern, negated, directoryOnly }] : [];
    });
  } catch {
    return [];
  }
}

function isIgnored(path: string, directory: boolean, rules: IgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.directoryOnly && !directory && !path.startsWith(`${rule.pattern}/`)) continue;
    if (!matchesFileGlob(path, rule.pattern) && !path.startsWith(`${rule.pattern}/`)) continue;
    ignored = !rule.negated;
  }
  return ignored;
}

function matchesFileGlob(path: string, pattern: string): boolean {
  const normalizedPath = toPosix(path);
  const normalizedPattern = toPosix(pattern).replace(/^\.\//, "");
  const expression = globExpression(normalizedPattern);
  if (expression.test(normalizedPath)) return true;
  return !normalizedPattern.includes("/") && expression.test(basename(normalizedPath));
}

function globExpression(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "[") {
      const close = pattern.indexOf("]", index + 1);
      if (close > index + 1) {
        source += pattern.slice(index, close + 1);
        index = close;
      } else {
        source += "\\[";
      }
    } else {
      source += char.replace(/[\\^$+?.()|{}]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

function truncateHead(content: string, maxLines = DEFAULT_MAX_LINES): {
  content: string;
  truncated: boolean;
  firstLineExceedsLimit: boolean;
  outputLines: number;
} {
  const lines = content.split("\n");
  if (Buffer.byteLength(lines[0] ?? "", "utf8") > DEFAULT_MAX_BYTES) {
    return { content: "", truncated: true, firstLineExceedsLimit: true, outputLines: 0 };
  }
  const output: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, "utf8") + (output.length > 0 ? 1 : 0);
    if (output.length >= maxLines || bytes + lineBytes > DEFAULT_MAX_BYTES) break;
    output.push(line);
    bytes += lineBytes;
  }
  return {
    content: output.join("\n"),
    truncated: output.length < lines.length,
    firstLineExceedsLimit: false,
    outputLines: output.length,
  };
}

function truncateTail(content: string): { content: string } {
  if (Buffer.byteLength(content, "utf8") <= DEFAULT_MAX_BYTES) return { content };
  const lines = content.split("\n");
  const output: string[] = [];
  let bytes = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    const lineBytes = Buffer.byteLength(line, "utf8") + (output.length > 0 ? 1 : 0);
    if (bytes + lineBytes > DEFAULT_MAX_BYTES) break;
    output.unshift(line);
    bytes += lineBytes;
  }
  return { content: `[Output truncated to last ${formatSize(DEFAULT_MAX_BYTES)}]\n${output.join("\n")}` };
}

function truncateLine(line: string): string {
  return line.length <= MAX_GREP_LINE_LENGTH
    ? line
    : `${line.slice(0, MAX_GREP_LINE_LENGTH)}...`;
}

function appendStatus(output: string, status: string): string {
  return output ? `${output.replace(/\n$/, "")}\n${status}` : status;
}

function detectLineEnding(content: string): "\n" | "\r\n" | "\r" {
  if (content.includes("\r\n")) return "\r\n";
  if (content.includes("\r")) return "\r";
  return "\n";
}

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(content: string, lineEnding: "\n" | "\r\n" | "\r"): string {
  return lineEnding === "\n" ? content : content.replace(/\n/g, lineEnding);
}

function lineNumberAt(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

function normalizePathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(1)}KB`;
}

function detectImageMimeType(buffer: Buffer): string | undefined {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  const prefix = buffer.subarray(0, 6).toString("ascii");
  if (prefix === "GIF87a" || prefix === "GIF89a") return "image/gif";
  if (
    buffer.length >= 12
    && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }

  return undefined;
}

function toolEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NO_COLOR: "1",
    TERM: "dumb",
    PAGER: "cat",
    GIT_PAGER: "cat",
    GH_PAGER: "cat",
    CODEX_CI: "1",
  };
}

class BoundedByteTailBuffer {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private omitted = 0;

  constructor(private readonly maximumBytes: number) {}

  append(chunk: Buffer): void {
    const value = Buffer.from(chunk);
    this.chunks.push(value);
    this.bytes += value.length;
    while (this.bytes > this.maximumBytes && this.chunks.length > 0) {
      const first = this.chunks[0];
      if (!first) break;
      const excess = this.bytes - this.maximumBytes;
      if (first.length <= excess) {
        this.chunks.shift();
        this.bytes -= first.length;
        this.omitted += first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.bytes -= excess;
        this.omitted += excess;
      }
    }
  }

  text(): string {
    const output = Buffer.concat(this.chunks).toString("utf8");
    return this.omitted > 0
      ? `[Earlier shell output omitted: ${formatSize(this.omitted)}]\n${output}`
      : output;
  }
}
