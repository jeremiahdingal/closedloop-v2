import type { AgentRole } from "./types.ts";
import type { WorkspaceConfig } from "./config.ts";
import { readWorkspaceConfig } from "./config.ts";

export const REMOTE_OVERRIDE_DECODER_MODEL = "zai:glm-5.1";
export const REMOTE_OVERRIDE_MEDIATED_MODEL = "anthropic-mediated:glm-4.7";

export type RuntimeProfile = {
  remoteOverrideEnabled: boolean;
  skipExplorer: boolean;
  skipEpicReview: boolean;
  autoPlayLoopEnabled: boolean;
  effectiveModels: Record<AgentRole, string>;
  roleOverrides: Partial<Record<AgentRole, { effectiveModel: string; overriddenByProfile: boolean; overrideReason: string }>>;
};

export type EffectiveAgentModelInfo = {
  configuredModel: string;
  currentModel: string;
  effectiveModel: string;
  switchable: boolean;
  overriddenByProfile: boolean;
  overrideReason?: string;
};

function getRemoteOverrideEnabled(workspaceConfig?: WorkspaceConfig): boolean {
  return Boolean((workspaceConfig ?? readWorkspaceConfig()).remoteOverrideEnabled);
}

export function resolveRuntimeProfile(
  models: Record<AgentRole, string>,
  workspaceConfig?: WorkspaceConfig,
): RuntimeProfile {
  const remoteOverrideEnabled = getRemoteOverrideEnabled(workspaceConfig);
  const effectiveModels: Record<AgentRole, string> = { ...models };
  const roleOverrides: RuntimeProfile["roleOverrides"] = {};

  if (remoteOverrideEnabled) {
    effectiveModels.epicDecoder = REMOTE_OVERRIDE_DECODER_MODEL;
    effectiveModels.coder = REMOTE_OVERRIDE_MEDIATED_MODEL;
    effectiveModels.reviewer = REMOTE_OVERRIDE_MEDIATED_MODEL;

    roleOverrides.epicDecoder = {
      effectiveModel: REMOTE_OVERRIDE_DECODER_MODEL,
      overriddenByProfile: true,
      overrideReason: "Remote Override routes epic decoding to remote glm-5.1.",
    };
    roleOverrides.coder = {
      effectiveModel: REMOTE_OVERRIDE_MEDIATED_MODEL,
      overriddenByProfile: true,
      overrideReason: "Remote Override routes coder to remote glm-4.7 via the mediated Anthropic-compatible harness.",
    };
    roleOverrides.reviewer = {
      effectiveModel: REMOTE_OVERRIDE_MEDIATED_MODEL,
      overriddenByProfile: true,
      overrideReason: "Remote Override routes reviewer to remote glm-4.7 via the mediated Anthropic-compatible harness.",
    };
    roleOverrides.explorer = {
      effectiveModel: "skipped",
      overriddenByProfile: true,
      overrideReason: "Remote Override skips explorer and sends tickets straight to coding.",
    };
    roleOverrides.epicReviewer = {
      effectiveModel: "skipped",
      overriddenByProfile: true,
      overrideReason: "Remote Override skips the epic review stage entirely.",
    };
  }

  return {
    remoteOverrideEnabled,
    skipExplorer: remoteOverrideEnabled,
    skipEpicReview: remoteOverrideEnabled,
    autoPlayLoopEnabled: !remoteOverrideEnabled,
    effectiveModels,
    roleOverrides,
  };
}

export function resolveAgentModelInfo(
  role: AgentRole,
  models: Record<AgentRole, string>,
  workspaceConfig?: WorkspaceConfig,
): EffectiveAgentModelInfo {
  const profile = resolveRuntimeProfile(models, workspaceConfig);
  const configuredModel = models[role];
  const effectiveModel = profile.roleOverrides[role]?.effectiveModel ?? configuredModel;
  return {
    configuredModel,
    currentModel: configuredModel,
    effectiveModel,
    switchable: true,
    overriddenByProfile: Boolean(profile.roleOverrides[role]?.overriddenByProfile),
    overrideReason: profile.roleOverrides[role]?.overrideReason,
  };
}

export function workspaceConfigForWrite(
  workspaceConfig: WorkspaceConfig,
  patch: Partial<WorkspaceConfig>,
): WorkspaceConfig {
  return { ...workspaceConfig, ...patch };
}
