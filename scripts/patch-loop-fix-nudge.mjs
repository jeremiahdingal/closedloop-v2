import { readFileSync, writeFileSync } from "node:fs";

const file = "src/mediated-agent-harness/loop.ts";
let content = readFileSync(file, "utf-8");

// Find the broken coder nudge block
const brokenStart = "    // Coder: early nudge at 40%";
const endMarker = "    // Token threshold: force finish if context window is nearly full";

const startIdx = content.indexOf(brokenStart);
const endIdx = content.indexOf(endMarker);

if (startIdx < 0 || endIdx < 0) {
  console.error("Could not find markers", { startIdx, endIdx });
  process.exit(1);
}

const fixed = `    // Coder: early nudge at 40% — remind about outputting edit plan
    if (config.role === "coder" && iteration >= Math.floor(maxIterations * 0.4)) {
      const hasNudged = messages.some(m => typeof m.content === 'string' && m.content.includes('[SYSTEM REMINDER] coder 40%'));
      if (!hasNudged) {
        messages.push({
          role: "user",
          content: \`[SYSTEM REMINDER] You are past 40% of your iteration budget (\${iteration + 1}/\${maxIterations}). You should have verified any stale file contents by now. Start formulating your edit operations. When you call finish, the "result" parameter MUST be a raw JSON string with this exact structure:\\n\\n{"operations":[{"kind":"search_replace","path":"relative/path","search":"exact content","replace":"replacement"}],"summary":"brief description"}\\n\\nNo markdown, no code fences, no commentary. Just the raw JSON object.\`
        });
        emit({ kind: "text", text: "[nudge] 40% budget reached, reminding coder to output edit plan..." });
      }
    }

    // Coder: convergence at 60% — force to conclude
    if (config.role === "coder" && iteration >= Math.floor(maxIterations * 0.6)) {
      messages.push({
        role: "user",
        content: \`[SYSTEM] You are at iteration \${iteration + 1} of \${maxIterations}. You have used 60% of your budget. STOP reading files. You MUST call the finish tool NOW with your edit plan as the result parameter (a JSON string). No more tool calls.\`
      });
      emit({ kind: "text", text: \`[convergence] Budget at 60%, forcing coder to conclude...\` });
    }

`;

content = content.substring(0, startIdx) + fixed + content.substring(endIdx);

writeFileSync(file, content, "utf-8");
console.log("Done - replaced coder nudge block");
