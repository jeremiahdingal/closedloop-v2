$file = "src\mediated-agent-harness\loop.ts"
$content = [System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8)

# Find the broken coder nudge block and replace it
$broken = "    // Coder: early nudge at 40% — remind about outputting edit plan"
$idx = $content.IndexOf($broken)
if ($idx -lt 0) {
    Write-Host "ERROR: Could not find coder nudge block"
    exit 1
}

# Find the end of the coder block (right before "    // Token threshold")
$endMarker = "    // Token threshold: force finish if context window is nearly full"
$endIdx = $content.IndexOf($endMarker, $idx)
if ($endIdx -lt 0) {
    Write-Host "ERROR: Could not find end marker"
    exit 1
}

# Build the corrected coder nudge block with proper backtick-dollar interpolation
$fixed = @'
    // Coder: early nudge at 40% — remind about outputting edit plan
    if (config.role === "coder" && iteration >= Math.floor(maxIterations * 0.4)) {
      const hasNudged = messages.some(m => typeof m.content === 'string' && m.content.includes('[SYSTEM REMINDER] coder 40%'));
      if (!hasNudged) {
        messages.push({
          role: "user",
          content: `[SYSTEM REMINDER] You are past 40% of your iteration budget (${iteration + 1}/${maxIterations}). You should have verified any stale file contents by now. Start formulating your edit operations. When you call finish, the "result" parameter MUST be a raw JSON string with this exact structure:\n\n{"operations":[{"kind":"search_replace","path":"relative/path","search":"exact content","replace":"replacement"}],"summary":"brief description"}\n\nNo markdown, no code fences, no commentary. Just the raw JSON object.`
        });
        emit({ kind: "text", text: "[nudge] 40% budget reached, reminding coder to output edit plan..." });
      }
    }

    // Coder: convergence at 60% — force to conclude
    if (config.role === "coder" && iteration >= Math.floor(maxIterations * 0.6)) {
      messages.push({
        role: "user",
        content: `[SYSTEM] You are at iteration ${iteration + 1} of ${maxIterations}. You have used 60% of your budget. STOP reading files. You MUST call the finish tool NOW with your edit plan as the result parameter (a JSON string). No more tool calls.`
      });
      emit({ kind: "text", text: `[convergence] Budget at 60%, forcing coder to conclude...` });
    }

'@

# Replace: from broken start to just before the token threshold comment
$oldBlock = $content.Substring($idx, $endIdx - $idx)
$content = $content.Remove($idx, $oldBlock.Length).Insert($idx, $fixed)

[System.IO.File]::WriteAllText($file, $content, [System.Text.Encoding]::UTF8)
Write-Host "Done - replaced coder nudge block"
