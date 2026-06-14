import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildCommitMetadataPrompt } from "./prompt.js";
import type {
  AutoCommitProvider,
  AutoCommitProviderId,
  CommitMetadata,
  GenerateCommitMetadataInput,
} from "./types.js";

const execFileAsync = promisify(execFile);

const commitTypes = new Set([
  "feat",
  "fix",
  "refactor",
  "docs",
  "test",
  "chore",
  "style",
  "build",
  "perf",
  "ci",
]);

export interface CreateAutoCommitProvidersOptions {
  codexModel?: string;
}

export function createAutoCommitProviders(
  ids: AutoCommitProviderId[],
  options: CreateAutoCommitProvidersOptions = {},
): AutoCommitProvider[] {
  return ids.map((id) => (id === "pi" ? createPiProvider() : createCodexProvider(options)));
}

function createPiProvider(): AutoCommitProvider {
  return {
    id: "pi",
    async isAvailable() {
      try {
        await import("@earendil-works/pi-coding-agent");
        return { available: true };
      } catch (error) {
        return { available: false, reason: errorMessage(error) };
      }
    },
    async generateCommitMetadata(input) {
      const { createAgentSession, SessionManager } = await import("@earendil-works/pi-coding-agent");
      const { session } = await createAgentSession({
        cwd: input.workspaceRoot,
        noTools: "all",
        sessionManager: SessionManager.inMemory(),
      });
      let text = "";

      try {
        const unsubscribe = session.subscribe((event: unknown) => {
          const maybeEvent = event as {
            type?: string;
            assistantMessageEvent?: { type?: string; delta?: string };
          };
          if (
            maybeEvent.type === "message_update" &&
            maybeEvent.assistantMessageEvent?.type === "text_delta" &&
            typeof maybeEvent.assistantMessageEvent.delta === "string"
          ) {
            text += maybeEvent.assistantMessageEvent.delta;
          }
        });

        try {
          await session.prompt(providerPrompt(input), { expandPromptTemplates: false });
        } finally {
          unsubscribe();
        }

        return normalizeCommitMetadata(extractJsonObject(text));
      } finally {
        session.dispose();
      }
    },
  };
}

function createCodexProvider(options: CreateAutoCommitProvidersOptions): AutoCommitProvider {
  return {
    id: "codex",
    async isAvailable() {
      try {
        await execFileAsync("codex", ["--version"], { maxBuffer: 1024 * 1024 });
        return { available: true };
      } catch (error) {
        return { available: false, reason: errorMessage(error) };
      }
    },
    async generateCommitMetadata(input) {
      const prompt = providerPrompt(input);
      const { stdout } = await execFileAsync(
        "codex",
        [
          "exec",
          "--sandbox",
          "read-only",
          ...(options.codexModel ? ["--model", options.codexModel] : []),
          prompt,
        ],
        {
          cwd: input.workspaceRoot,
          env: process.env,
          maxBuffer: 10 * 1024 * 1024,
          timeout: 120_000,
        },
      );

      return normalizeCommitMetadata(extractJsonObject(stdout));
    },
  };
}

export async function generateWithProviderChain(
  providers: AutoCommitProvider[],
  input: GenerateCommitMetadataInput,
): Promise<{ provider: AutoCommitProvider; metadata: CommitMetadata } | undefined> {
  for (const provider of providers) {
    const availability = await provider.isAvailable({ workspaceRoot: input.workspaceRoot });
    if (!availability.available) continue;

    try {
      const metadata = normalizeCommitMetadata(await provider.generateCommitMetadata(input));
      return { provider, metadata };
    } catch {
      // Try the next configured provider.
    }
  }

  return undefined;
}

export function normalizeCommitMetadata(input: unknown): CommitMetadata {
  if (!input || typeof input !== "object") {
    throw new Error("Commit metadata must be an object.");
  }

  const metadata = input as Record<string, unknown>;
  const shouldCommit = metadata.shouldCommit === true;
  const rawType = typeof metadata.type === "string" ? metadata.type : "chore";
  const type = commitTypes.has(rawType) ? (rawType as CommitMetadata["type"]) : "chore";
  const subject = typeof metadata.subject === "string" ? metadata.subject.trim() : "";
  const reason = typeof metadata.reason === "string" ? metadata.reason.trim() : "";

  if (shouldCommit && subject.length === 0) {
    throw new Error("Commit metadata subject is required when shouldCommit is true.");
  }

  return {
    shouldCommit,
    type,
    scope: typeof metadata.scope === "string" && metadata.scope.trim() ? metadata.scope.trim() : undefined,
    subject: subject.slice(0, 100),
    body: typeof metadata.body === "string" && metadata.body.trim() ? metadata.body.trim() : undefined,
    files: Array.isArray(metadata.files)
      ? metadata.files.filter((file): file is string => typeof file === "string" && file.length > 0)
      : undefined,
    reason,
    model: typeof metadata.model === "string" && metadata.model.trim() ? metadata.model.trim() : undefined,
  };
}

export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return JSON.parse(trimmed);

  const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (match) return JSON.parse(match[1].trim());

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));

  throw new Error("Provider response did not contain JSON.");
}

export function providerPrompt(input: GenerateCommitMetadataInput): string {
  return buildCommitMetadataPrompt(input);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
