export const DEFAULT_READ_MANY_CONCURRENCY = 4;
export const DEFAULT_READ_MANY_TOTAL_CHARACTERS = 50_000;
export const MAX_READ_MANY_TOTAL_CHARACTERS = 200_000;
export const MAX_READ_MANY_FILES = 20;
export const MAX_READ_MANY_FILE_CHARACTERS = 50_000;

export interface ReadManyFileInput {
  path: string;
  offset?: number;
  limit?: number;
}

export interface ReadManyContentBlock {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface ReadManyRawResult {
  content: ReadManyContentBlock[];
  isError?: boolean;
}

export interface ReadManyFileResult {
  path: string;
  success: boolean;
  text?: string;
  error?: string;
  truncated: boolean;
  lineCount: number;
  characters: number;
  offset: number;
  limited: boolean;
}

export interface ReadManySummary {
  requested: number;
  succeeded: number;
  failed: number;
  truncated: number;
  characters: number;
  maxTotalCharacters: number;
  concurrency: number;
}

export interface ReadManyResult {
  results: ReadManyFileResult[];
  summary: ReadManySummary;
  text: string;
}

export async function readManyFiles(
  files: readonly ReadManyFileInput[],
  readOne: (file: ReadManyFileInput, index: number) => Promise<ReadManyRawResult>,
  options: {
    maxTotalCharacters?: number;
    concurrency?: number;
  } = {},
): Promise<ReadManyResult> {
  if (files.length < 1 || files.length > MAX_READ_MANY_FILES) {
    throw new Error(`read_many requires between 1 and ${MAX_READ_MANY_FILES} files.`);
  }
  const maxTotalCharacters = boundedPositiveInteger(
    options.maxTotalCharacters,
    DEFAULT_READ_MANY_TOTAL_CHARACTERS,
    MAX_READ_MANY_TOTAL_CHARACTERS,
    "maxTotalCharacters",
  );
  const concurrency = boundedPositiveInteger(
    options.concurrency,
    DEFAULT_READ_MANY_CONCURRENCY,
    MAX_READ_MANY_FILES,
    "concurrency",
  );

  const raw = await mapWithConcurrency(files, concurrency, async (file, index) => {
    try {
      return normalizeRawResult(file, await readOne(file, index));
    } catch (error) {
      return failedResult(file, error instanceof Error ? error.message : String(error));
    }
  });

  let remaining = maxTotalCharacters;
  const results = raw.map((result) => {
    if (!result.success || result.text === undefined) return result;
    const perFileText = result.text.slice(0, MAX_READ_MANY_FILE_CHARACTERS);
    const perFileTruncated = perFileText.length < result.text.length;
    const text = perFileText.slice(0, remaining);
    const totalTruncated = text.length < perFileText.length;
    remaining -= text.length;
    return {
      ...result,
      text,
      truncated: result.truncated || perFileTruncated || totalTruncated,
      lineCount: lineCount(text),
      characters: text.length,
    };
  });

  const summary: ReadManySummary = {
    requested: results.length,
    succeeded: results.filter((result) => result.success).length,
    failed: results.filter((result) => !result.success).length,
    truncated: results.filter((result) => result.truncated).length,
    characters: results.reduce((sum, result) => sum + result.characters, 0),
    maxTotalCharacters,
    concurrency,
  };
  return {
    results,
    summary,
    text: formatReadManyResult(results, summary),
  };
}

async function mapWithConcurrency<T, TResult>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  const results = new Array<TResult>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= values.length) return;
        results[index] = await operation(values[index] as T, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function normalizeRawResult(
  file: ReadManyFileInput,
  raw: ReadManyRawResult,
): ReadManyFileResult {
  const text = raw.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
  if (raw.isError) return failedResult(file, text || "Read failed.");
  if (raw.content.some((block) => block.type === "image")) {
    return failedResult(file, "Image content is not supported by read_many; use read for this file.");
  }
  return {
    path: file.path,
    success: true,
    text,
    truncated: false,
    lineCount: lineCount(text),
    characters: text.length,
    offset: file.offset ?? 1,
    limited: file.limit !== undefined,
  };
}

function failedResult(file: ReadManyFileInput, error: string): ReadManyFileResult {
  return {
    path: file.path,
    success: false,
    error,
    truncated: false,
    lineCount: 0,
    characters: 0,
    offset: file.offset ?? 1,
    limited: file.limit !== undefined,
  };
}

function formatReadManyResult(
  results: readonly ReadManyFileResult[],
  summary: ReadManySummary,
): string {
  const sections = results.map((result) => {
    const heading = `## ${result.path}`;
    if (!result.success) return `${heading}\nError: ${result.error ?? "Read failed."}`;
    const suffix = result.truncated ? "\n[truncated]" : "";
    return `${heading}\n${result.text ?? ""}${suffix}`;
  });
  sections.push(
    `## Summary\nRequested: ${summary.requested}\nSucceeded: ${summary.succeeded}\nFailed: ${summary.failed}\nTruncated: ${summary.truncated}\nCharacters: ${summary.characters}/${summary.maxTotalCharacters}`,
  );
  return sections.join("\n\n");
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

function lineCount(text: string): number {
  if (!text) return 0;
  return text.split(/\r?\n/).length;
}
