const fs = require('fs');
const p = 'src/orchestration/ticket-runner.ts';
let src = fs.readFileSync(p, 'utf8');

const oldGraph = `    const graphBuilder = new StateGraph(TicketState)
      .addNode("prepare_context", prepareContext)
      .addNode("builder", builderNode)
      .addNode("reviewer", reviewerNode)
      .addNode("tester", testerNode)
      .addNode("classify", classifyNode)
      .addNode("finalize_success", finalizeSuccess)
      .addNode("finalize_escalated", finalizeEscalated)
      .addNode("finalize_failed", finalizeFailed)
      .addEdge(START, "prepare_context")
      .addEdge("prepare_context", "builder")
      .addConditionalEdges("builder", (state: TicketGraphState) => state.noDiff ? "classify" : "reviewer", ["classify", "reviewer"])
      .addConditionalEdges("reviewer", (state: TicketGraphState) => state.reviewApproved ? "tester" : "classify", ["tester", "classify"])
      .addConditionalEdges("tester", (state: TicketGraphState) => state.testPassed ? "finalize_success" : "classify", ["finalize_success", "classify"])
      .addConditionalEdges(
        "classify",
        (state: TicketGraphState) => {
          if (state.buildAttempts >= state.maxBuildAttempts) return "finalize_failed";
          if (["escalate", "blocked", "todo"].includes(state.failureDecision)) return "finalize_escalated";
          return "builder";
        },
        ["builder", "finalize_escalated", "finalize_failed"]
      )
      .addEdge("finalize_success", END)
      .addEdge("finalize_escalated", END)
      .addEdge("finalize_failed", END);`;

const newGraph = `    const graphBuilder = new StateGraph(TicketState)
      .addNode("prepare_context", prepareContext)
      .addNode("explorer", explorerNode)
      .addNode("build_packet", buildPacketNode)
      .addNode("coder", coderNode)
      .addNode("verify", verifyNode)
      .addNode("builder", builderNode)
      .addNode("reviewer", reviewerNode)
      .addNode("tester", testerNode)
      .addNode("classify", classifyNode)
      .addNode("finalize_success", finalizeSuccess)
      .addNode("finalize_escalated", finalizeEscalated)
      .addNode("finalize_failed", finalizeFailed)
      .addEdge(START, "prepare_context")
      .addEdge("prepare_context", "explorer")
      .addEdge("explorer", "build_packet")
      .addEdge("build_packet", "coder")
      .addEdge("coder", "verify")
      .addConditionalEdges("verify",
        (state: TicketGraphState) => state.noDiff ? "classify" : "reviewer",
        ["classify", "reviewer"]
      )
      .addConditionalEdges("reviewer", (state: TicketGraphState) => state.reviewApproved ? "tester" : "classify", ["tester", "classify"])
      .addConditionalEdges("tester", (state: TicketGraphState) => state.testPassed ? "finalize_success" : "classify", ["finalize_success", "classify"])
      .addConditionalEdges(
        "classify",
        (state: TicketGraphState) => {
          if (state.buildAttempts >= state.maxBuildAttempts) return "finalize_failed";
          if (["escalate", "blocked", "todo"].includes(state.failureDecision)) return "finalize_escalated";
          return "builder";
        },
        ["builder", "finalize_escalated", "finalize_failed"]
      )
      .addEdge("finalize_success", END)
      .addEdge("finalize_escalated", END)
      .addEdge("finalize_failed", END);`;

if (src.includes(oldGraph)) {
  src = src.replace(oldGraph, newGraph);
  fs.writeFileSync(p, src);
  console.log('Graph rewired successfully');
} else {
  console.log('Old graph pattern not found');
  // Debug: show what we have
  const idx = src.indexOf('const graphBuilder');
  if (idx >= 0) {
    console.log('Found at char', idx);
    console.log(src.substring(idx, idx + 200));
  }
}
