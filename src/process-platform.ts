import { existsSync } from "node:fs";
import { basename, win32 } from "node:path";
import { spawnSync } from "node:child_process";

export interface ShellCommand {
  executable: string;
  args: string[];
}

export interface KillableProcess {
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
}

interface ProcessTreeRuntime {
  platform: NodeJS.Platform;
  killGroup(pid: number, signal: NodeJS.Signals): void;
  killWindowsTree(pid: number): boolean;
}

const defaultProcessTreeRuntime: ProcessTreeRuntime = {
  platform: process.platform,
  killGroup: (pid, signal) => process.kill(-pid, signal),
  killWindowsTree: (pid) => {
    const result = spawnSync("taskkill.exe", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return !result.error && result.status === 0;
  },
};

const LOGIN_SHELLS = new Set(["bash", "ksh", "zsh"]);
const POSIX_SHELLS = new Set(["ash", "dash", "sh"]);

export function resolveGitExecutable(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  pathExists: (path: string) => boolean = existsSync,
): string {
  if (platform !== "win32") return "git";

  const pathValue = environment.Path ?? environment.PATH ?? environment.path ?? "";
  for (const rawEntry of pathValue.split(";")) {
    const entry = rawEntry.trim().replace(/^"(.*)"$/, "$1");
    if (!entry) continue;

    const git = win32.join(entry, "git.exe");
    if (!pathExists(git)) continue;

    const parent = win32.basename(win32.dirname(git)).toLowerCase();
    if (parent === "cmd" || parent === "bin") {
      const installRoot = win32.dirname(win32.dirname(git));
      for (const runtime of ["mingw64", "mingw32"]) {
        const realGit = win32.join(installRoot, runtime, "bin", "git.exe");
        if (pathExists(realGit)) return realGit;
      }
    }

    return git;
  }

  return "git";
}

export function resolveShellCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): ShellCommand {
  const localspaceShell = environment.LOCALSPACE_SHELL?.trim();
  if (localspaceShell) return resolveConfiguredShellCommand(command, localspaceShell, platform);

  if (platform === "win32") {
    return {
      executable: environment.ComSpec ?? environment.COMSPEC ?? "cmd.exe",
      args: ["/d", "/s", "/c", command],
    };
  }

  const configuredShell = environment.SHELL;
  const shellName = configuredShell ? basename(configuredShell) : "";
  if (configuredShell && LOGIN_SHELLS.has(shellName)) {
    return { executable: configuredShell, args: ["-lc", command] };
  }
  if (configuredShell && POSIX_SHELLS.has(shellName)) {
    return { executable: configuredShell, args: ["-c", command] };
  }

  return { executable: "/bin/sh", args: ["-c", command] };
}

function resolveConfiguredShellCommand(
  command: string,
  shell: string,
  platform: NodeJS.Platform,
): ShellCommand {
  const shellName = basename(shell).toLowerCase();

  if (shellName === "cmd" || shellName === "cmd.exe") {
    return { executable: shell, args: ["/d", "/s", "/c", command] };
  }

  if (shellName === "powershell" || shellName === "powershell.exe") {
    return {
      executable: shell,
      args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    };
  }

  if (shellName === "pwsh" || shellName === "pwsh.exe") {
    return { executable: shell, args: ["-NoLogo", "-NoProfile", "-Command", command] };
  }

  if (shellName === "wsl" || shellName === "wsl.exe") {
    return { executable: shell, args: ["bash", "-lc", command] };
  }

  if (LOGIN_SHELLS.has(shellName) || shellName === "bash.exe") {
    return { executable: shell, args: ["-lc", command] };
  }

  if (POSIX_SHELLS.has(shellName) || shellName === "sh.exe") {
    return { executable: shell, args: ["-c", command] };
  }

  if (platform === "win32") {
    return { executable: shell, args: ["/d", "/s", "/c", command] };
  }

  return { executable: shell, args: ["-c", command] };
}

export function terminateProcessTree(
  child: KillableProcess,
  signal: NodeJS.Signals,
  detached: boolean,
  runtime: ProcessTreeRuntime = defaultProcessTreeRuntime,
): void {
  if (runtime.platform === "win32" && child.pid) {
    if (runtime.killWindowsTree(child.pid)) return;
  } else if (detached && child.pid) {
    try {
      runtime.killGroup(child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
  }

  child.kill(signal);
}
