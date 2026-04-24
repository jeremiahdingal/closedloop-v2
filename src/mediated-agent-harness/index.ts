import type { MediatedHarnessConfig, MediatedHarnessResult, ToolExecutionContext } from "./types.ts";
import { runMediatedLoop } from "./loop.ts";
import { getPromptForRole } from "./prompts.ts";

export type { MediatedHarnessConfig, MediatedHarnessResult, ToolExecutionContext } from "./types.ts";
export type { MediatedHarnessEvent, ToolCall, ToolResult } from "./types.ts";
export { WORKSPACE_TOOLS, BROWSER_TOOLS, TOOL_ALIASES, executeToolCall, resetSessionTracking } from "./tools.ts";
export { StreamParser } from "./stream-parser.ts";
export { CallHistory, validateAndRepair } from "./validator.ts";
export {
  MediatedHarnessError,
  ToolValidationError,
  StagnationError,
  ToolExecutionError,
  ModelConnectionError,
  LoopTimeoutError,
} from "./errors.ts";
export { runMediatedLoop } from "./loop.ts";

// ─── MediatedAgentHarness class ─────────────────────────────────────────────

export interface MediatedAgentHarnessOptions {
  baseURL?: string;
  apiKey?: string;
  model: string;
  braveApiKey?: string;
  toolContext: ToolExecutionContext;
}

export class MediatedAgentHarness {
  private readonly baseURL: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly braveApiKey: string | undefined;
  private readonly toolContext: ToolExecutionContext;

  constructor(options: MediatedAgentHarnessOptions) {
    this.baseURL = options.baseURL ?? "http://localhost:11434/v1";
    this.apiKey = options.apiKey ?? "ollama";
    this.model = options.model;
    this.braveApiKey = options.braveApiKey;
    this.toolContext = options.toolContext;
  }

  async run(
    role: string,
    userPrompt: string,
    options?: Partial<MediatedHarnessConfig>
  ): Promise<MediatedHarnessResult> {
    const systemPrompt = getPromptForRole(role, this.toolContext.cwd, options?.toolMode ?? "native", {
      allowInstallCommand: (this.toolContext.availableCommands ?? []).includes("install")
    });

    return runMediatedLoop({
      systemPrompt,
      userPrompt,
      config: {
        baseURL: options?.baseURL ?? this.baseURL,
        apiKey: options?.apiKey ?? this.apiKey,
        model: options?.model ?? this.model,
        cwd: this.toolContext.cwd,
        role: role,
        toolMode: options?.toolMode,
        allowedPaths: options?.allowedPaths ?? ["*"],
        maxIterations: options?.maxIterations,
        timeoutMs: options?.timeoutMs,
        temperature: options?.temperature,
        topP: options?.topP,
        topK: options?.topK,
        braveApiKey: options?.braveApiKey ?? this.braveApiKey,
        onEvent: options?.onEvent,
      },
      toolContext: this.toolContext,
    });
  }

  async runWithPrompt(
    systemPrompt: string,
    userPrompt: string,
    options?: Partial<MediatedHarnessConfig>
  ): Promise<MediatedHarnessResult> {
    return runMediatedLoop({
      systemPrompt,
      userPrompt,
      config: {
        baseURL: options?.baseURL ?? this.baseURL,
        apiKey: options?.apiKey ?? this.apiKey,
        model: options?.model ?? this.model,
        cwd: this.toolContext.cwd,
        toolMode: options?.toolMode,
        allowedPaths: options?.allowedPaths ?? ["*"],
        maxIterations: options?.maxIterations,
        timeoutMs: options?.timeoutMs,
        temperature: options?.temperature,
        topP: options?.topP,
        topK: options?.topK,
        braveApiKey: options?.braveApiKey ?? this.braveApiKey,
        onEvent: options?.onEvent,
      },
      toolContext: this.toolContext,
    });
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createMediatedAgentHarness(options: MediatedAgentHarnessOptions): MediatedAgentHarness {
  return new MediatedAgentHarness(options);
}
