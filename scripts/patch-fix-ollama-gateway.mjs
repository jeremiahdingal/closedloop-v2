import { readFileSync, writeFileSync } from "node:fs";

const file = "src/orchestration/models.ts";
let content = readFileSync(file, "utf-8");

// 1. Find the wrongly-inserted runCoderInWorkspace in OllamaGateway and replace with a stub
// It's right before "runCoderDirect" in OllamaGateway, which follows runExplorerInWorkspace
const ollamaMarker = `  runExplorerInWorkspace(_input: { cwd: string; prompt: string }): Promise<string> {
    throw new Error("Explorer requires mediated harness (MediatedAgentHarnessGateway)");
  }

  async runCoderInWorkspace(input: {`;

const ollamaIdx = content.indexOf(ollamaMarker);
if (ollamaIdx < 0) {
  console.error("Could not find OllamaGateway wrongly-inserted method");
  process.exit(1);
}

// Find where this wrong method ends — it ends right before OllamaGateway's runCoderDirect
const ollamaCoderDirectMarker = `  async runCoderDirect(input: { prompt: string; onStream?: StreamHook }): Promise<string> {`;
const ollamaCoderDirectIdx = content.indexOf(ollamaCoderDirectMarker, ollamaIdx);

if (ollamaCoderDirectIdx < 0) {
  console.error("Could not find OllamaGateway runCoderDirect");
  process.exit(1);
}

// Replace: from after runExplorerInWorkspace throw to before runCoderDirect
const startOfWrong = ollamaIdx + `  runExplorerInWorkspace(_input: { cwd: string; prompt: string }): Promise<string> {
    throw new Error("Explorer requires mediated harness (MediatedAgentHarnessGateway)");
  }
`.length;

const replacement = `
  runCoderInWorkspace(_input: { cwd: string; prompt: string }): Promise<string> {
    throw new Error("Coder requires mediated harness (MediatedAgentHarnessGateway)");
  }

`;

content = content.substring(0, startOfWrong) + replacement + content.substring(ollamaCoderDirectIdx);

writeFileSync(file, content, "utf-8");
console.log("Done - fixed OllamaGateway runCoderInWorkspace stub");
