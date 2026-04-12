import path from "node:path";
import { writeProjectStructure, writeProjectStructureIfMissing } from "../orchestration/project-structure.ts";

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const targetDirArg = args.find((arg) => arg !== "--force");
  const targetDir = path.resolve(targetDirArg || process.cwd());

  const result = force
    ? { ...(await writeProjectStructure(targetDir)), written: true }
    : await writeProjectStructureIfMissing(targetDir);

  console.log(JSON.stringify({
    targetDir,
    filePath: result.filePath,
    written: result.written,
    model: process.env.PROJECT_STRUCTURE_MODEL || "qwen3.5:9b",
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
