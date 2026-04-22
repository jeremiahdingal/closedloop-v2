export class MediatedHarnessError extends Error {
  readonly kind: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(message: string, kind: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "MediatedHarnessError";
    this.kind = kind;
    this.details = details;
  }
}

export class ToolValidationError extends MediatedHarnessError {
  readonly toolName: string;
  readonly rawArgs: string;
  readonly remediation: string | undefined;

  constructor(message: string, toolName: string, rawArgs: string, remediation?: string) {
    super(message, "tool_validation");
    this.name = "ToolValidationError";
    this.toolName = toolName;
    this.rawArgs = rawArgs;
    this.remediation = remediation;
  }
}

export class StagnationError extends MediatedHarnessError {
  readonly iterations: number;
  readonly reason: "repeated_call" | "consecutive_errors" | "no_progress" | "max_iterations" | "stall_recovery_forced";

  constructor(
    message: string,
    iterations: number,
    reason: "repeated_call" | "consecutive_errors" | "no_progress" | "max_iterations" | "stall_recovery_forced"
  ) {
    super(message, "stagnation", { iterations, reason });
    this.name = "StagnationError";
    this.iterations = iterations;
    this.reason = reason;
  }
}

export class ToolExecutionError extends MediatedHarnessError {
  readonly toolName: string;
  readonly callId: string;

  constructor(message: string, toolName: string, callId: string) {
    super(message, "tool_execution", { toolName, callId });
    this.name = "ToolExecutionError";
    this.toolName = toolName;
    this.callId = callId;
  }
}

export class ModelConnectionError extends MediatedHarnessError {
  readonly baseURL: string;
  readonly cause: Error | undefined;

  constructor(message: string, baseURL: string, cause?: Error) {
    super(message, "model_connection", { baseURL });
    this.name = "ModelConnectionError";
    this.baseURL = baseURL;
    this.cause = cause;
  }
}

export class LoopTimeoutError extends MediatedHarnessError {
  readonly elapsedMs: number;
  readonly timeoutMs: number;

  constructor(message: string, elapsedMs: number, timeoutMs: number) {
    super(message, "loop_timeout", { elapsedMs, timeoutMs });
    this.name = "LoopTimeoutError";
    this.elapsedMs = elapsedMs;
    this.timeoutMs = timeoutMs;
  }
}
