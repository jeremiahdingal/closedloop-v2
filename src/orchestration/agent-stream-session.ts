export class AgentStreamSessionRegistry {
  private readonly activeSessions = new Map<string, string>();

  begin(runId: string, agentRole: string): string {
    const sessionId = `${runId}:${agentRole}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
    this.activeSessions.set(this.key(runId, agentRole), sessionId);
    return sessionId;
  }

  isActive(runId: string, agentRole: string, sessionId: string): boolean {
    return this.activeSessions.get(this.key(runId, agentRole)) === sessionId;
  }

  end(runId: string, agentRole: string, sessionId?: string): void {
    const key = this.key(runId, agentRole);
    if (!sessionId || this.activeSessions.get(key) === sessionId) {
      this.activeSessions.delete(key);
    }
  }

  private key(runId: string, agentRole: string): string {
    return `${runId}:${agentRole}`;
  }
}
