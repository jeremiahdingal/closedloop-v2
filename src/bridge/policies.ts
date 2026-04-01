import path from "node:path";
import type { CommandCatalog, WriteFileInput } from "../types.ts";

export class PathPolicy {
  private readonly workspaceRoot: string;
  private readonly allowedPrefixes: string[];
  constructor(workspaceRoot: string, allowedPrefixes: string[]) {
    this.workspaceRoot = workspaceRoot;
    this.allowedPrefixes = allowedPrefixes;
  }

  assertAllowed(relativePath: string): void {
    const normalized = relativePath.replace(/\\/g, "/");
    if (path.isAbsolute(normalized)) {
      throw new Error(`Absolute paths are forbidden: ${relativePath}`);
    }
    if (normalized.includes("..")) {
      throw new Error(`Parent traversal is forbidden: ${relativePath}`);
    }
    if (this.allowedPrefixes.length === 0) return;
    if (!this.allowedPrefixes.some((prefix) => normalized === prefix || normalized.startsWith(prefix.endsWith("/") ? prefix : prefix + "/"))) {
      throw new Error(`Path not allowed by ticket policy: ${relativePath}`);
    }
  }

  assertAllowedWrites(files: WriteFileInput[]): void {
    for (const file of files) this.assertAllowed(file.path);
  }
}

export function getCommand(commandCatalog: CommandCatalog, name: keyof CommandCatalog): string {
  const command = commandCatalog[name];
  if (!command) throw new Error(`Command not configured: ${name}`);
  return command;
}
