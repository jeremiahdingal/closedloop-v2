import type { AgentContinuationState } from "./agent-state.ts";
import type { ToolExecutionContext } from "../../mediated-agent-harness/types.ts";

// ─── Artifact-based continuation persistence ─────────────────────────────────

export function stateArtifactName(role: string, runId: string, looplet?: number): string {
  const suffix = looplet !== undefined ? `looplet-${String(looplet).padStart(3, "0")}` : "latest";
  return `continuation/${role}/${runId}/state.${suffix}.json`;
}

export function draftArtifactName(role: string, runId: string): string {
  return `continuation/${role}/${runId}/draft.latest.json`;
}

export function handoffArtifactName(role: string, runId: string): string {
  return `continuation/${role}/${runId}/handoff.latest.json`;
}

export async function persistState(
  state: AgentContinuationState,
  ctx: ToolExecutionContext,
  looplet?: number,
): Promise<void> {
  const latestName = stateArtifactName(state.role, state.runId ?? "unknown");
  const loopletName = looplet !== undefined
    ? stateArtifactName(state.role, state.runId ?? "unknown", looplet)
    : undefined;

  const serialized = JSON.stringify(state, null, 2);

  // Persist latest
  const artifactId = await ctx.saveArtifact({ name: latestName, content: serialized, kind: "continuation-state" });
  const updated: AgentContinuationState = {
    ...state,
    artifacts: { ...state.artifacts, latestStateArtifact: artifactId },
  };

  // Persist looplet snapshot
  if (loopletName) {
    await ctx.saveArtifact({ name: loopletName, content: serialized, kind: "continuation-state" });
  }

  // Persist draft output if present
  if (updated.draftOutput) {
    const draftName = draftArtifactName(state.role, state.runId ?? "unknown");
    await ctx.saveArtifact({
      name: draftName,
      content: JSON.stringify(updated.draftOutput, null, 2),
      kind: "continuation-draft",
    });
  }
}

export async function loadState<TLedger, TOutput>(
  role: string,
  runId: string,
  ctx: ToolExecutionContext,
): Promise<AgentContinuationState<TLedger, TOutput> | null> {
  if (!ctx.readArtifact) return null;
  const name = stateArtifactName(role, runId);
  const raw = await ctx.readArtifact({ name, kind: "continuation-state" });
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AgentContinuationState<TLedger, TOutput>;
  } catch {
    return null;
  }
}

export async function persistHandoff(
  role: string,
  runId: string,
  packet: unknown,
  ctx: ToolExecutionContext,
): Promise<void> {
  const name = handoffArtifactName(role, runId);
  await ctx.saveArtifact({
    name,
    content: JSON.stringify(packet, null, 2),
    kind: "continuation-handoff",
  });
}
