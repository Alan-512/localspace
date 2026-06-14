import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";
import { GitWorktreeError } from "./git-worktrees.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { formatAgentsNotice, WorkspaceRegistry } from "./workspaces.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "devspace-workspace-test-"));

try {
  await writeFile(join(root, "AGENTS.md"), "root instructions\n");
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "AGENTS.md"), "nested instructions\n");
  await writeFile(join(root, "nested", "file.txt"), "hello\n");

  const config = loadConfig({
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".devspace", "worktrees"),
    PORT: "1",
  });
  const registry = new WorkspaceRegistry(config);
  const { workspace, agentsFiles } = await registry.openWorkspace(root);

  assert.equal(workspace.mode, "checkout");
  assert.match(formatAgentsNotice(agentsFiles, workspace.root) ?? "", /<project_context>/);
  assert.match(formatAgentsNotice(agentsFiles, workspace.root) ?? "", /<project_instructions path="AGENTS\.md">/);
  assert.match(formatAgentsNotice(agentsFiles, workspace.root) ?? "", /root instructions/);

  const missingWorkspaceRoot = join(root, "missing", "workspace");
  const missingWorkspace = await registry.openWorkspace(missingWorkspaceRoot);
  assert.equal(missingWorkspace.workspace.root, missingWorkspaceRoot);
  assert.equal(missingWorkspace.workspace.mode, "checkout");
  assert.equal((await stat(missingWorkspaceRoot)).isDirectory(), true);

  const rootAgain = await registry.loadAgentsForDirectory(workspace, root);
  assert.equal(formatAgentsNotice(rootAgain, workspace.root), undefined);

  const nestedPath = registry.resolvePath(workspace, "nested/file.txt");
  const nestedFirst = await registry.loadAgentsForPath(workspace, nestedPath);
  const nestedFirstNotice = formatAgentsNotice(nestedFirst, workspace.root) ?? "";
  assert.doesNotMatch(nestedFirstNotice, /root instructions/);
  assert.match(nestedFirstNotice, /<project_instructions path="nested\/AGENTS\.md">/);
  assert.match(nestedFirstNotice, /nested instructions/);

  const nestedAgain = await registry.loadAgentsForPath(workspace, nestedPath);
  assert.equal(formatAgentsNotice(nestedAgain, workspace.root), undefined);

  const manualAgentsConfig = loadConfig({
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_AUTO_LOAD_AGENTS_MD: "0",
    PORT: "1",
  });
  const manualAgentsRegistry = new WorkspaceRegistry(manualAgentsConfig);
  const manualAgentsWorkspace = await manualAgentsRegistry.openWorkspace(root);
  assert.equal(manualAgentsWorkspace.agentsFiles.length, 0);
  assert.deepEqual(
    await manualAgentsRegistry.loadAgentsForPath(
      manualAgentsWorkspace.workspace,
      manualAgentsRegistry.resolvePath(manualAgentsWorkspace.workspace, "nested/file.txt"),
    ),
    [],
  );

  await assert.rejects(
    () => registry.openWorkspace({ path: root, mode: "worktree" }),
    (error: unknown) =>
      error instanceof GitWorktreeError && error.code === "GIT_REPOSITORY_NOT_FOUND",
  );

  const gitRoot = join(root, "git-project");
  await mkdir(gitRoot);
  await writeFile(join(gitRoot, "AGENTS.md"), "git root instructions\n");
  await writeFile(join(gitRoot, "README.md"), "hello\n");
  await git(gitRoot, ["init"]);
  await git(gitRoot, ["config", "user.email", "devspace@example.com"]);
  await git(gitRoot, ["config", "user.name", "DevSpace Test"]);
  await git(gitRoot, ["add", "."]);
  await git(gitRoot, ["commit", "-m", "Initial commit"]);
  await writeFile(join(gitRoot, "dirty.txt"), "not copied\n");

  const worktreeWorkspace = await registry.openWorkspace({
    path: gitRoot,
    mode: "worktree",
  });
  assert.equal(worktreeWorkspace.workspace.mode, "worktree");
  assert.notEqual(worktreeWorkspace.workspace.root, gitRoot);
  assert.match(worktreeWorkspace.workspace.root, /git-project-[a-f0-9]{8}$/);
  assert.equal(worktreeWorkspace.workspace.sourceRoot, gitRoot);
  assert.equal(worktreeWorkspace.workspace.worktree?.baseRef, "HEAD");
  assert.equal(worktreeWorkspace.workspace.worktree?.dirtySource, true);
  assert.equal(worktreeWorkspace.workspace.worktree?.managed, true);
  assert.equal((await stat(worktreeWorkspace.workspace.root)).isDirectory(), true);
  assert.match(formatAgentsNotice(worktreeWorkspace.agentsFiles, worktreeWorkspace.workspace.root) ?? "", /<project_instructions path="AGENTS\.md">/);
  assert.match(formatAgentsNotice(worktreeWorkspace.agentsFiles, worktreeWorkspace.workspace.root) ?? "", /git root instructions/);

  const worktreeReadmePath = registry.resolvePath(worktreeWorkspace.workspace, "README.md");
  assert.equal(worktreeReadmePath.startsWith(worktreeWorkspace.workspace.root), true);

  const stateDir = join(root, ".state");
  const firstStore = new SqliteWorkspaceStore(stateDir);
  const persistentRegistry = new WorkspaceRegistry(config, firstStore);
  const persistentWorkspace = await persistentRegistry.openWorkspace(root);
  const persistentNestedPath = persistentRegistry.resolvePath(
    persistentWorkspace.workspace,
    "nested/file.txt",
  );
  await persistentRegistry.loadAgentsForPath(
    persistentWorkspace.workspace,
    persistentNestedPath,
  );
  const persistentWorktree = await persistentRegistry.openWorkspace({
    path: gitRoot,
    mode: "worktree",
  });
  firstStore.close();

  const secondStore = new SqliteWorkspaceStore(stateDir);
  const restoredRegistry = new WorkspaceRegistry(config, secondStore);
  const restoredWorkspace = restoredRegistry.getWorkspace(persistentWorkspace.workspace.id);
  assert.equal(restoredWorkspace.root, root);
  assert.equal(restoredWorkspace.mode, "checkout");

  const restoredWorktree = restoredRegistry.getWorkspace(persistentWorktree.workspace.id);
  assert.equal(restoredWorktree.mode, "worktree");
  assert.equal(restoredWorktree.sourceRoot, gitRoot);
  assert.equal(restoredWorktree.root, persistentWorktree.workspace.root);
  assert.equal(restoredWorktree.worktree?.managed, true);

  const restoredRootAgents = await restoredRegistry.loadAgentsForDirectory(
    restoredWorkspace,
    root,
  );
  assert.equal(formatAgentsNotice(restoredRootAgents, restoredWorkspace.root), undefined);

  const restoredNestedAgents = await restoredRegistry.loadAgentsForPath(
    restoredWorkspace,
    restoredRegistry.resolvePath(restoredWorkspace, "nested/file.txt"),
  );
  assert.equal(formatAgentsNotice(restoredNestedAgents, restoredWorkspace.root), undefined);
  secondStore.close();
} finally {
  await rm(root, { recursive: true, force: true });
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
