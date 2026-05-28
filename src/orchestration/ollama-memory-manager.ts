/**
 * Ollama Memory Manager
 * 
 * Ensures only one model is loaded in Ollama at a time by tracking
 * the currently loaded model and sending unload requests before switching.
 * 
 * Works in conjunction with:
 * - OLLAMA_KEEP_ALIVE=0 (auto-unload after each request)
 * - OLLAMA_NUM_PARALLEL=1 (one request at a time)
 */

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";

let currentLoadedModel: string | null = null;
let lastUnloadPromise: Promise<void> = Promise.resolve();

/**
 * Unload a specific model from Ollama memory by sending a keep_alive: 0 request.
 */
async function unloadModel(model: string): Promise<void> {
  try {
    await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        model,
        prompt: "",
        stream: false,
        keep_alive: 0,
      }),
    });
  } catch {
    // Best-effort: if unload fails, continue anyway
  }
}

/**
 * Ensure the requested model can be loaded by unloading any currently loaded model.
 * Returns the previous model that was unloaded (or null if nothing was loaded).
 * 
 * This is serialized (one at a time) to avoid race conditions between concurrent nodes.
 */
export async function ensureModelLoaded(model: string): Promise<string | null> {
  // Serialize: wait for any in-progress unload to finish
  await lastUnloadPromise;

  if (currentLoadedModel === model) {
    return null; // Same model, no switch needed
  }

  const previousModel = currentLoadedModel;
  
  if (previousModel) {
    // Fire and track the unload so the next caller waits for it
    lastUnloadPromise = unloadModel(previousModel);
    await lastUnloadPromise;
  }

  currentLoadedModel = model;
  return previousModel;
}

/**
 * Mark a model as loaded (called after a successful Ollama request).
 * This helps track what's in memory without an explicit load call,
 * since Ollama keeps models loaded after requests.
 */
export function markModelLoaded(model: string): void {
  currentLoadedModel = model;
}

/**
 * Explicitly unload the current model. Called when a pipeline step completes.
 */
export async function unloadCurrentModel(): Promise<string | null> {
  const prev = currentLoadedModel;
  if (prev) {
    await unloadModel(prev);
    currentLoadedModel = null;
  }
  return prev;
}

/**
 * Get the currently tracked model name.
 */
export function getCurrentLoadedModel(): string | null {
  return currentLoadedModel;
}
