import type { DecompositionJudgement, JudgedTicket, SelectedKnowledgeSlice } from "./types.ts";

function splitTicket(ticket: JudgedTicket): JudgedTicket[] {
  const parts = ticket.description.split(/\b(?:and then|also|plus)\b/i).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return [ticket];
  return parts.slice(0, 2).map((part, index) => ({
    ...ticket,
    id: `${ticket.id}_R${index + 1}`,
    title: index === 0 ? ticket.title : `${ticket.title} follow-up ${index + 1}`,
    description: part,
    dependencies: index === 0 ? ticket.dependencies : [`${ticket.id}_R1`],
    allowedPaths: ticket.allowedPaths?.slice(0, 2) ?? ["src"],
    acceptanceCriteria: ticket.acceptanceCriteria.map((criterion) => criterion.replace(/\bworks correctly\b/i, "has the explicitly described behavior")),
  }));
}

export function repairTickets(
  judgement: DecompositionJudgement,
  _selectedKnowledge: SelectedKnowledgeSlice,
): JudgedTicket[] {
  const repaired: JudgedTicket[] = [];
  for (const ticket of judgement.rejectedTickets) {
    const reasons = judgement.rejectionReasons[ticket.id] ?? [];
    if (reasons.some((reason) => /scope is too broad/i.test(reason))) {
      repaired.push(...splitTicket(ticket));
      continue;
    }
    repaired.push({
      ...ticket,
      allowedPaths: ticket.allowedPaths && ticket.allowedPaths.length > 0 && ticket.allowedPaths[0] !== "*"
        ? ticket.allowedPaths.slice(0, 3)
        : ["src", "tests"],
      acceptanceCriteria: ticket.acceptanceCriteria.length > 0
        ? ticket.acceptanceCriteria.map((criterion) => criterion.replace(/\b(works correctly|tests pass|no regressions|implemented)\b/ig, "has the explicitly described behavior"))
        : ["Implements the specific scoped change described in the ticket.", "Add or update a focused verification step for the change."],
      nonGoals: ticket.nonGoals?.length ? ticket.nonGoals : ["Do not expand scope beyond the explicitly named files or subsystem."],
      fallbackNotes: [...(ticket.fallbackNotes ?? []), "Ticket was repaired after judge rejection; keep scope conservative."],
    });
  }
  return repaired;
}
