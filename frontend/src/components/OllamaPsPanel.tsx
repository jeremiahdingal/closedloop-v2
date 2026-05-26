import type { OllamaPsSnapshot } from "../types.ts";

type OllamaPsPanelProps = {
  snapshot: OllamaPsSnapshot;
};

function formatFallbackStatus(snapshot: OllamaPsSnapshot): string {
  if (snapshot.status === "error") return "UNAVAILABLE";
  return "IDLE";
}

function formatTimeoutValue(until: string): string {
  const normalized = until.trim().replace(/\.$/, "");
  const match = normalized.match(/^(\d+)\s+minutes?\s+from\s+now$/i);
  if (match) {
    return `${match[1]}min`;
  }
  return normalized;
}

function parseProcessorMetrics(processor: string): { cpu: string; gpu: string } {
  const normalized = processor.trim().replace(/\s+/g, " ");
  const match = normalized.match(/^(.*?)\/(.*?)\s+CPU\/GPU$/i);
  if (match) {
    return {
      cpu: match[1].trim(),
      gpu: match[2].trim(),
    };
  }

  const slashIndex = normalized.indexOf("/");
  if (slashIndex !== -1) {
    return {
      cpu: normalized.slice(0, slashIndex).trim(),
      gpu: normalized
        .slice(slashIndex + 1)
        .replace(/\s+CPU\/GPU$/i, "")
        .trim(),
    };
  }

  return { cpu: normalized, gpu: normalized };
}

export function OllamaPsPanel({ snapshot }: OllamaPsPanelProps) {
  const hasModels = snapshot.models.length > 0;
  const title = hasModels
    ? `Running models (${snapshot.models.length})`
    : snapshot.status === "error"
      ? "Ollama unavailable"
      : "No running models";

  return (
    <div className="win-panel">
      <div className="win-titlebar">
        <div className="win-titlebar-text">
          <span>[PS]</span>
          <span>Ollama PS</span>
          <span className="win-titlebar-count">{title}</span>
        </div>
        <div className="win-titlebar-buttons">
          <div className="win-btn-box">_</div>
          <div className="win-btn-box">×</div>
        </div>
      </div>

      <div className="stats-row crt-row ollama-model-list">
        {hasModels ? (
          snapshot.models.map((model) => {
            const { cpu, gpu } = parseProcessorMetrics(model.processor);
            return (
              <div key={`${model.name}-${model.id}`} className="ollama-model-row">
                <div className="ollama-model-title">
                  <span className="ollama-model-name">
                    {model.name} ({model.size})
                  </span>
                </div>
                <div className="ollama-model-metrics">
                  <div className="crt-tv ollama-tv ollama-metric-tv">
                    <div className="crt-screen ollama-screen ollama-metric-screen">
                      <span className="crt-label">CPU</span>
                      <span className="crt-value ollama-metric-value">{cpu}</span>
                    </div>
                    <div className="crt-body" />
                  </div>
                  <div className="crt-tv ollama-tv ollama-metric-tv">
                    <div className="crt-screen ollama-screen ollama-metric-screen">
                      <span className="crt-label">GPU</span>
                      <span className="crt-value ollama-metric-value">{gpu}</span>
                    </div>
                    <div className="crt-body" />
                  </div>
                  <div className="crt-tv ollama-tv ollama-metric-tv">
                    <div className="crt-screen ollama-screen ollama-metric-screen">
                      <span className="crt-label">CTX</span>
                      <span className="crt-value ollama-metric-value">{model.context}</span>
                    </div>
                    <div className="crt-body" />
                  </div>
                  <div className="crt-tv ollama-tv ollama-metric-tv">
                    <div className="crt-screen ollama-screen ollama-metric-screen">
                      <span className="crt-label">TO</span>
                      <span className="crt-value ollama-metric-value">{formatTimeoutValue(model.until)}</span>
                    </div>
                    <div className="crt-body" />
                  </div>
                </div>
              </div>
            );
          })
        ) : (
          <div className="crt-tv ollama-tv ollama-empty-tv">
            <div className="crt-screen ollama-screen ollama-screen-empty">
              <span className="crt-label">OLLAMA</span>
              <span className="crt-value">{formatFallbackStatus(snapshot)}</span>
              {snapshot.error ? <span className="ollama-error">{snapshot.error}</span> : null}
            </div>
            <div className="crt-body" />
          </div>
        )}
      </div>
    </div>
  );
}
