const fs = require('fs');

const runnerPath = 'src/orchestration/ticket-runner.ts';
let runner = fs.readFileSync(runnerPath, 'utf8');

const oldCall = `explorerPrompt(ticket,
        packet),`;

const seedLogic = `// --- Seed: discover related files via glob ---
      const seedFiles: string[] = [];
      try {
        const kwMatches = [...ticket.description.matchAll(/\\b([A-Za-z]{3,}(?:s|Items|Orders|Reports|Categories|Service|Route|Model|Schema|Type|Query|Hook|Util)?)\\b/g)].map(m => m[1]).filter(k => k.length >= 4);
        const uniqueKw = [...new Set(kwMatches.map(k => k.toLowerCase()))].slice(0, 6);
        const { execSync } = require('child_process');
        for (const kw of uniqueKw) {
          try {
            const out = execSync(\`dir /s /b *.ts 2>nul | findstr /i "\${kw}"\`, { cwd: workspace.worktreePath, encoding: 'utf8', timeout: 5000 }).trim();
            if (out) out.split('\\n').filter(Boolean).forEach(f => {
              const rel = f.replace(workspace.worktreePath.replace(/\\\\/g, '/'), '').replace(/^\\//, '');
              if (rel && !seedFiles.includes(rel)) seedFiles.push(rel);
            });
          } catch {}
        }
      } catch {}
      if (seedFiles.length > 0) {
        this.heartbeat(state.runId, state.ticketId, "explorer", \`Seeded \${seedFiles.length} related files: \${seedFiles.slice(0, 5).join(', ')}\`);
      }
      // --- End seed ---

      explorerPrompt(ticket,
        packet,
        seedFiles),`;

if (!runner.includes(oldCall)) {
  console.log('ERROR: explorerPrompt(ticket,\\n        packet), not found');
  process.exit(1);
}

runner = runner.replace(oldCall, seedLogic);
fs.writeFileSync(runnerPath, runner);
console.log('✅ ticket-runner.ts: seeded explorer with glob discovery');
