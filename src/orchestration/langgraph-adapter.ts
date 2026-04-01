/**
 * Optional adapter.
 *
 * This file dynamically imports @langchain/langgraph when available.
 * It is not used by the default tests or runtime so the project remains
 * dependency-free out of the box.
 */
import type { GoalRunner } from "./goal-runner.ts";
import type { TicketRunner } from "./ticket-runner.ts";

export async function createLangGraphTicketGraph(ticketRunner: TicketRunner): Promise<unknown> {
  const pkg = await import("@langchain/langgraph");
  const START = (pkg as any).START;
  const END = (pkg as any).END;
  const StateGraph = (pkg as any).StateGraph;

  const graph = new StateGraph({
    channels: {
      runId: { value: (x: string) => x, default: () => "" }
    }
  });

  graph.addNode("run_ticket", async (state: { runId: string }) => {
    await ticketRunner.runExisting(state.runId);
    return state;
  });
  graph.addEdge(START, "run_ticket");
  graph.addEdge("run_ticket", END);
  return graph.compile();
}

export async function createLangGraphGoalGraph(goalRunner: GoalRunner): Promise<unknown> {
  const pkg = await import("@langchain/langgraph");
  const START = (pkg as any).START;
  const END = (pkg as any).END;
  const StateGraph = (pkg as any).StateGraph;

  const graph = new StateGraph({
    channels: {
      runId: { value: (x: string) => x, default: () => "" }
    }
  });

  graph.addNode("run_goal", async (state: { runId: string }) => {
    await goalRunner.runExisting(state.runId);
    return state;
  });
  graph.addEdge(START, "run_goal");
  graph.addEdge("run_goal", END);
  return graph.compile();
}
