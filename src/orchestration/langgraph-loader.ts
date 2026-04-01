export type LangGraphRuntime = {
  StateGraph: any;
  StateSchema: any;
  MemorySaver?: any;
  START: string;
  END: string;
  z: any;
};

let cachedRuntime: Promise<LangGraphRuntime | null> | null = null;

export async function loadLangGraphRuntime(): Promise<LangGraphRuntime | null> {
  if (!cachedRuntime) {
    cachedRuntime = (async () => {
      try {
        const [langgraphPkg, zodPkg] = await Promise.all([
          import("@langchain/langgraph"),
          import("zod")
        ]);
        const z = (zodPkg as any).z ?? zodPkg;
        return {
          StateGraph: (langgraphPkg as any).StateGraph,
          StateSchema: (langgraphPkg as any).StateSchema,
          MemorySaver: (langgraphPkg as any).MemorySaver,
          START: (langgraphPkg as any).START ?? "__start__",
          END: (langgraphPkg as any).END ?? "__end__",
          z
        } satisfies LangGraphRuntime;
      } catch {
        return null;
      }
    })();
  }
  return cachedRuntime;
}
