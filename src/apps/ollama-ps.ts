import { execFileSync } from "node:child_process";

export type OllamaPsModel = {
  name: string;
  id: string;
  size: string;
  processor: string;
  context: string;
  until: string;
};

export type OllamaPsSnapshot = {
  ok: boolean;
  status: "ready" | "idle" | "error";
  models: OllamaPsModel[];
  error?: string;
};

function parseOllamaPsLine(line: string): OllamaPsModel | null {
  const parts = line.trim().split(/\s{2,}/);
  if (parts.length < 6) return null;

  const [name, id, size, processor, context, ...untilParts] = parts;
  const until = untilParts.join("  ").trim();

  return {
    name: name.trim(),
    id: id.trim(),
    size: size.trim(),
    processor: processor.trim(),
    context: context.trim(),
    until,
  };
}

export function parseOllamaPsOutput(output: string): OllamaPsModel[] {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  if (lines.length <= 1) return [];

  return lines
    .slice(1)
    .map(parseOllamaPsLine)
    .filter((model): model is OllamaPsModel => Boolean(model));
}

function formatOllamaPsError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return "Failed to query ollama ps";
}

export function getOllamaPsSnapshot(): OllamaPsSnapshot {
  try {
    const output = execFileSync("ollama", ["ps"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const models = parseOllamaPsOutput(output);
    return {
      ok: true,
      status: models.length > 0 ? "ready" : "idle",
      models,
    };
  } catch (err) {
    const stdout = typeof (err as { stdout?: unknown }).stdout === "string"
      ? String((err as { stdout: string }).stdout)
      : "";
    const models = stdout ? parseOllamaPsOutput(stdout) : [];
    if (models.length > 0) {
      return {
        ok: true,
        status: "ready",
        models,
      };
    }

    return {
      ok: false,
      status: "error",
      models: [],
      error: formatOllamaPsError(err),
    };
  }
}
