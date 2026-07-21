import { spawn } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

const MAX_GIT_PATH_OUTPUT_BYTES = 64 * 1024 * 1024;

export async function workspaceRevision(root: string): Promise<string | undefined> {
  const repository = await collectGitOutput(root, ["rev-parse", "--is-inside-work-tree"], true);
  if (repository.code !== 0 || repository.stdout.toString("utf8").trim() !== "true") {
    return undefined;
  }

  const hash = createHash("sha256");
  hash.update("head\0");
  await hashGitOutput(root, ["rev-parse", "--verify", "HEAD"], hash, true);
  hash.update("worktree\0");
  await hashGitOutput(root, ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--"], hash);
  hash.update("index\0");
  await hashGitOutput(root, ["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", "--"], hash);
  hash.update("untracked\0");
  await hashUntrackedFiles(root, hash);
  return hash.digest("base64url");
}

export async function workspaceContentRevision(root: string): Promise<string | undefined> {
  const repository = await collectGitOutput(root, ["rev-parse", "--is-inside-work-tree"], true);
  if (repository.code !== 0 || repository.stdout.toString("utf8").trim() !== "true") {
    return undefined;
  }

  const hash = createHash("sha256");
  const head = await collectGitOutput(root, ["rev-parse", "--verify", "HEAD"], true);
  hash.update("head\0").update(head.stdout).update("\0");
  if (head.code === 0) {
    hash.update("content\0");
    await hashGitOutput(
      root,
      ["diff", "HEAD", "--binary", "--no-ext-diff", "--no-textconv", "--"],
      hash,
    );
  } else {
    hash.update("worktree\0");
    await hashGitOutput(root, ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--"], hash);
    hash.update("index\0");
    await hashGitOutput(root, ["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", "--"], hash);
  }
  hash.update("untracked\0");
  await hashUntrackedFiles(root, hash);
  return hash.digest("base64url");
}

async function hashUntrackedFiles(root: string, hash: Hash): Promise<void> {
  const result = await collectGitOutput(
    root,
    ["ls-files", "--others", "--exclude-standard", "-z"],
    false,
  );
  const paths = result.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();

  for (const path of paths) {
    const absolutePath = resolve(root, path);
    const relativePath = relative(root, absolutePath);
    if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error(`Git returned an untracked path outside the workspace: ${path}`);
    }

    hash.update("path\0").update(path).update("\0");
    try {
      const stats = await lstat(absolutePath, { bigint: true });
      hash
        .update(`mode:${stats.mode.toString()}\0`)
        .update(`size:${stats.size.toString()}\0`)
        .update(`mtime:${stats.mtimeNs.toString()}\0`);
      if (stats.isSymbolicLink()) {
        hash.update("symlink\0").update(await readlink(absolutePath)).update("\0");
      } else if (stats.isFile()) {
        hash.update("file\0");
        await hashFileContents(absolutePath, hash);
      } else {
        hash.update("other\0");
      }
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "unknown";
      hash.update(`unavailable:${code}\0`);
    }
  }
}

async function hashFileContents(path: string, hash: Hash): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
}

async function hashGitOutput(
  root: string,
  args: string[],
  hash: Hash,
  allowFailure = false,
): Promise<void> {
  const result = await runGit(root, args, (chunk) => hash.update(chunk));
  if (result.code === 0) return;
  if (!allowFailure) throw gitFailure(args, result.code, result.stderr);
  hash
    .update(`exit:${result.code ?? "signal"}\0`)
    .update(result.stderr)
    .update("\0");
}

async function collectGitOutput(
  root: string,
  args: string[],
  allowFailure: boolean,
): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const result = await runGit(root, args, (chunk) => {
    totalBytes += chunk.length;
    if (totalBytes > MAX_GIT_PATH_OUTPUT_BYTES) {
      throw new Error(`Git output exceeded ${MAX_GIT_PATH_OUTPUT_BYTES} bytes.`);
    }
    chunks.push(Buffer.from(chunk));
  });
  if (result.code !== 0 && !allowFailure) throw gitFailure(args, result.code, result.stderr);
  return { ...result, stdout: Buffer.concat(chunks) };
}

async function runGit(
  root: string,
  args: string[],
  onStdout: (chunk: Buffer) => void,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        onStdout(chunk);
      } catch (error) {
        child.kill();
        reject(error);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({ code, stderr: Buffer.concat(stderr).toString("utf8").trim() });
    });
  });
}

function gitFailure(args: string[], code: number | null, stderr: string): Error {
  return new Error(
    `git ${args.join(" ")} exited with ${code ?? "signal"}${stderr ? `: ${stderr}` : ""}`,
  );
}
