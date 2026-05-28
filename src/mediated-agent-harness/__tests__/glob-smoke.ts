// Smoke test for glob_files fix — Windows backslash path normalization
import { executeToolCall } from "../tools.ts";
import type { ToolExecutionContext, ToolCall } from "../types.ts";
import path from "node:path";

const cwd = path.resolve("data/workspaces/ws_f72bd530d59d9ba9");
console.log("=== glob_files smoke test ===");
console.log("cwd:", cwd);
console.log();

const ctx: ToolExecutionContext = {
  cwd,
  workspaceId: "smoke-test",
  allowedPaths: ["*"],
  readFiles: async () => ({}),
  writeFiles: async () => {},
  gitDiff: async () => "",
  gitStatus: async () => "",
  runNamedCommand: async () => ({ stdout: "", stderr: "", exitCode: 1 }),
  saveArtifact: async () => "",
};

async function testGlob(pattern: string, expectMin: number) {
  const call: ToolCall = {
    id: `test-${pattern}`,
    name: "glob_files",
    args: { pattern },
  };
  const result = await executeToolCall(call, ctx);
  const lines = result.output.split("\n").filter(l => l.trim());
  const pass = lines.length >= expectMin;
  console.log(`${pass ? "✓" : "✗"} glob("${pattern}") → ${lines.length} results (expected ≥${expectMin})`);
  if (!pass) {
    console.log(`  Output: ${result.output.slice(0, 300)}`);
  }
  return pass;
}

async function testGlobNoMatch(pattern: string) {
  const call: ToolCall = {
    id: `test-${pattern}`,
    name: "glob_files",
    args: { pattern },
  };
  const result = await executeToolCall(call, ctx);
  const isNoMatch = result.output.includes("No files matched");
  console.log(`${isNoMatch ? "✓" : "✗"} glob("${pattern}") → no match (expected none)`);
  if (!isNoMatch) {
    console.log(`  Output: ${result.output.slice(0, 300)}`);
  }
  return isNoMatch;
}

// Verify output uses forward slashes
async function testForwardSlashes(pattern: string) {
  const call: ToolCall = {
    id: `test-${pattern}`,
    name: "glob_files",
    args: { pattern },
  };
  const result = await executeToolCall(call, ctx);
  const lines = result.output.split("\n").filter(l => l.trim() && !l.startsWith("No files"));
  const hasBackslash = lines.some(l => l.includes("\\"));
  console.log(`${!hasBackslash ? "✓" : "✗"} glob("${pattern}") → all forward slashes`);
  if (hasBackslash) {
    const bad = lines.filter(l => l.includes("\\"));
    console.log(`  Backslash paths: ${bad.slice(0, 3).join(", ")}`);
  }
  return !hasBackslash;
}

let allPassed = true;

// Core tests — these were all returning "No files matched" before the fix
allPassed = await testGlob("**/*.ts", 10) && allPassed;
allPassed = await testGlob("**/*.sql", 1) && allPassed;
allPassed = await testGlob("**/db.types*", 1) && allPassed;
allPassed = await testGlob("**/*.service.ts", 5) && allPassed;
allPassed = await testGlob("**/orders*", 3) && allPassed;

// Negative test — should still return no match
allPassed = await testGlobNoMatch("**/*.xyz") && allPassed;

// Forward slash normalization test
allPassed = await testForwardSlashes("**/*.ts") && allPassed;

// Single-level glob
allPassed = await testGlob("*.json", 1) && allPassed;
allPassed = await testGlob("*.md", 1) && allPassed;

console.log();
console.log(allPassed ? "=== ALL TESTS PASSED ===" : "=== SOME TESTS FAILED ===");
process.exit(allPassed ? 0 : 1);
