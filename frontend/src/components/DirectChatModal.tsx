import React, { useState, useEffect, useRef, useMemo } from "react";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { 
  DirectChatSessionRecord, 
  DirectChatMessageRecord, 
  AgentModelsConfig, 
  AgentEvent 
} from "../types.ts";

type ChatMessage = Omit<DirectChatMessageRecord, "id"> & { id: number | string };
import { AgentEventCard } from "./AgentEventCard.tsx";
import { formatTime, confirmToast, parseUnifiedDiff, diffLineClass } from "../utils.ts";

interface DirectChatModalProps {
  isOpen: boolean;
  onClose: () => void;
  modelsConfig: AgentModelsConfig;
  defaultTargetDir: string;
}

export function DirectChatModal({ isOpen, onClose, modelsConfig, defaultTargetDir }: DirectChatModalProps) {
  const [sessions, setSessions] = useState<DirectChatSessionRecord[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [targetDir, setTargetDir] = useState(defaultTargetDir || "");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [branchName, setBranchName] = useState("main");
  const [model, setModel] = useState("");
  const [diff, setDiff] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [expandedDiffFiles, setExpandedDiffFiles] = useState<Record<string, boolean>>({});
  
  const scrollRef = useRef<HTMLDivElement>(null);
  const sseRef = useRef<EventSource | null>(null);

  const parsedDiffFiles = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const totals = useMemo(() => {
    return parsedDiffFiles.reduce(
      (sum, file) => ({
        additions: sum.additions + file.additions,
        deletions: sum.deletions + file.deletions,
      }),
      { additions: 0, deletions: 0 }
    );
  }, [parsedDiffFiles]);

  useEffect(() => {
    if (isOpen) {
      void fetchSessions();
      if (modelsConfig.builder?.adapters.length > 0) {
        setModel(modelsConfig.builder.currentModel || modelsConfig.builder.adapters[0].id);
      }
      if (defaultTargetDir && !targetDir) {
        setTargetDir(defaultTargetDir);
      }
    } else {
      stopSSE();
    }
  }, [isOpen, defaultTargetDir]);

  useEffect(() => {
    if (selectedSessionId) {
      void fetchMessages(selectedSessionId);
      void fetchDiff(selectedSessionId);
      startSSE(selectedSessionId);
    } else {
      setMessages([]);
      setDiff("");
      stopSSE();
    }
  }, [selectedSessionId]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  async function fetchSessions() {
    const res = await fetch("/api/direct-chats");
    const data = await res.json();
    setSessions(data);
    // Auto-select the first (most recent) session if none selected
    if (data.length > 0 && !selectedSessionId) {
      setSelectedSessionId(data[0].id);
    }
  }

  async function fetchMessages(id: string) {
    const res = await fetch(`/api/direct-chats/${id}/messages`);
    const data = await res.json();
    setMessages(data);
  }

  async function fetchDiff(id: string) {
    const res = await fetch(`/api/direct-chats/${id}/diff`);
    const data = await res.json();
    setDiff(data.diff || "");
  }

  function startSSE(id: string) {
    stopSSE();
    const sse = new EventSource(`/api/direct-chats/${id}/stream`);
    sse.addEventListener("agent", (e) => {
      const event = JSON.parse(e.data);
      
      if (event.kind === "thinking" || event.kind === "text") {
        setIsThinking(event.kind === "thinking");
        // For CLI runners, we might want to show thinking in the chat log
        if (event.text || event.content) {
          const content = event.text || event.content;
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last && last.role === event.kind && last.id === 'streaming-' + event.kind) {
              return [...prev.slice(0, -1), { ...last, content: last.content + content }];
            }
            return [...prev, { 
              id: 'streaming-' + event.kind, 
              sessionId: id, 
              role: event.kind as any, 
              content, 
              createdAt: new Date().toISOString(),
              toolCallsJson: null,
              toolResultsJson: null
            }];
          });
        }
      }

      if (event.kind === "tool_call") {
        setIsThinking(true);
      }

      if (event.kind === "status") {
        toast.info(event.message, { duration: 3000 });
      }

      if (event.kind === "error") {
        setIsThinking(false);
        setIsLoading(false);
        toast.error(`Agent error: ${event.error}`);
        void fetchMessages(id);
      }

      // If the event signals completion or tool result, refresh messages from DB
      if (event.kind === "complete" || event.kind === "tool_result") {
        setIsThinking(false);
        void fetchMessages(id);
        void fetchDiff(id);
      }
    });
    sseRef.current = sse;
  }

  function stopSSE() {
    if (sseRef.current) {
      sseRef.current.close();
      sseRef.current = null;
    }
  }

  async function handleCreateSession() {
    const res = await fetch("/api/direct-chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        title: `Chat on ${branchName}`, 
        targetDir: targetDir || defaultTargetDir, 
        branchName, 
        model 
      })
    });
    const session = await res.json();
    setSessions([session, ...sessions]);
    setSelectedSessionId(session.id);
  }

  async function handleSendMessage() {
    if (!selectedSessionId || !input.trim() || isLoading) return;
    setIsLoading(true);
    setIsThinking(true); // Hack: Start thinking immediately on send
    const text = input;
    setInput("");
    
    // Optimistic UI
    const tempMsg: DirectChatMessageRecord = {
      id: Date.now(),
      sessionId: selectedSessionId,
      role: "user",
      content: text,
      toolCallsJson: null,
      toolResultsJson: null,
      createdAt: new Date().toISOString()
    };
    setMessages(prev => [...prev, tempMsg]);

    try {
      const res = await fetch(`/api/direct-chats/${selectedSessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text })
      });
      if (!res.ok) throw new Error("Failed to send message");
    } catch (err) {
      toast.error("Failed to send message");
      setIsThinking(false);
    }
    
    setIsLoading(false);
    void fetchMessages(selectedSessionId);
  }

  async function handleCompress() {
    if (!selectedSessionId) return;
    const tid = toast.loading("Summarizing conversation history...");
    try {
      const res = await fetch(`/api/direct-chats/${selectedSessionId}/compress`, { method: "POST" });
      const data = await res.json();
      if (data.didCompress) {
        toast.success("Conversation summarized.", { id: tid });
      } else {
        toast.info("History is already compact.", { id: tid });
      }
      void fetchMessages(selectedSessionId);
    } catch (err) {
      toast.error("Compression failed.", { id: tid });
    }
  }

  async function handleDeleteSession(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    
    const confirmed = await confirmToast({
      title: "Delete Chat Session",
      description: "Are you sure you want to delete this chat session? This action cannot be undone.",
      confirmLabel: "Delete",
      cancelLabel: "Cancel"
    });

    if (!confirmed) return;

    const toastId = toast.loading("Deleting chat session...");
    try {
      const res = await fetch(`/api/direct-chats/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete session");
      
      toast.success("Chat session deleted.", { id: toastId });
      if (selectedSessionId === id) setSelectedSessionId(null);
      void fetchSessions();
    } catch (err) {
      toast.error(`Error: ${(err as Error).message}`, { id: toastId });
    }
  }

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="direct-chat-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-header-left">
            <span>💬</span>
            <div className="modal-header-title-wrap">
              <h2>Direct Chat to Local Builder</h2>
            </div>
          </div>
          <div className="win-titlebar-buttons">
            <button className="win-btn-box" onClick={onClose}>&times;</button>
          </div>
        </div>

        <div className="chat-modal-split">
          {/* Left Panel: Sessions & Chat */}
          <div className="chat-left-panel">
            <div className="chat-settings">
              <div className="settings-row">
                <input 
                  type="text" 
                  placeholder="Target Directory" 
                  value={targetDir} 
                  onChange={e => setTargetDir(e.target.value)}
                  title="Override the workspace directory for this session"
                />
                <input 
                  type="text" 
                  placeholder="Branch Name" 
                  value={branchName} 
                  onChange={e => setBranchName(e.target.value)} 
                />
              </div>
              <div className="settings-row">
                <select value={model} onChange={e => setModel(e.target.value)}>
                  {modelsConfig.builder?.adapters.map(a => (
                    <option key={a.id} value={a.id}>{a.label}</option>
                  ))}
                </select>
                <button onClick={handleCreateSession} className="btn new-chat-btn">New Chat</button>
                {selectedSessionId && (
                  <button onClick={handleCompress} className="btn compress-btn">Compress</button>
                )}
              </div>
            </div>

            <div className="session-list">
              {sessions.map(s => (
                <div 
                  key={s.id} 
                  className={`session-item ${selectedSessionId === s.id ? 'active' : ''}`}
                  onClick={() => setSelectedSessionId(s.id)}
                >
                  <div className="session-title">{s.title}</div>
                  <div className="session-meta">{s.branchName} • {formatTime(s.createdAt)}</div>
                  <button className="delete-session-btn" onClick={(e) => handleDeleteSession(s.id, e)}>&times;</button>
                </div>
              ))}
            </div>

            <div className="chat-history" ref={scrollRef}>
              {messages.map(m => {
                if (m.role === 'user') {
                  return (
                    <div key={m.id} className="user-message-container">
                      <div className="user-message">
                        <div className="user-message-header">
                          <span className="user-icon">👤</span>
                          <span className="user-label">You</span>
                          <span className="user-time">{formatTime(m.createdAt)}</span>
                        </div>
                        <div className="user-message-content markdown-body">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                        </div>
                      </div>
                    </div>
                  );
                }
                
                // Convert other roles to AgentEvent for AgentEventCard
                const event: AgentEvent = {
                  id: typeof m.id === "number" ? m.id : 0,
                  created_at: m.createdAt,
                  message: m.role,
                  run_id: null,
                  ticket_id: null,
                  payload: {
                    agentRole: m.role === 'tool' ? 'builder' : (m.role === 'assistant' ? 'builder' : m.role),
                    streamKind: m.role === 'tool' ? 'tool_result' : 'assistant',
                    content: m.content,
                    source: 'direct-chat',
                    metadata: m.toolCallsJson ? { 
                      toolName: JSON.parse(m.toolCallsJson)[0]?.name,
                      model: selectedSessionId ? sessions.find(s => s.id === selectedSessionId)?.model : undefined
                    } : {}
                  }
                };
                return <AgentEventCard key={m.id} event={event} />;
              })}
              
              {isThinking && (
                <div className="agent-thinking-container">
                  <div className="thinking-dots">
                    <div className="thinking-dot" />
                    <div className="thinking-dot" />
                    <div className="thinking-dot" />
                  </div>
                  <span className="thinking-label">Builder is thinking...</span>
                </div>
              )}
            </div>

            <div className="chat-input-area-wrap">
              <div className="chat-input-area">
                <textarea 
                  placeholder="Type your instructions to the builder..." 
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void handleSendMessage();
                    }
                  }}
                />
                <button 
                  className="btn"
                  onClick={handleSendMessage} 
                  disabled={!selectedSessionId || !input.trim() || isLoading}
                >
                  {isLoading ? "..." : "Send"}
                </button>
              </div>
              <div className="keybind-hint">Enter to send, Shift+Enter for newline</div>
            </div>
          </div>

          {/* Right Panel: Diff View */}
          <div className="chat-right-panel">
            <div className="diff-header">
              <h3>Changes on {branchName}</h3>
              <button className="btn mini-btn" onClick={() => selectedSessionId && fetchDiff(selectedSessionId)}>Refresh Diff</button>
            </div>
            <div className="diff-content">
              {parsedDiffFiles.length > 0 ? (
                <div className="pr-changes-card">
                  <div className="pr-files">
                    {parsedDiffFiles.map((file, idx) => {
                      const key = `${file.path}-${idx}`;
                      const expanded = Boolean(expandedDiffFiles[key]);
                      return (
                        <div key={key} className="pr-file-with-snippet">
                          <button
                            type="button"
                            className="pr-file-row pr-file-row-button"
                            onClick={() =>
                              setExpandedDiffFiles((prev) => ({ ...prev, [key]: !expanded }))
                            }
                          >
                            <span className="pr-file-name">{file.path}</span>
                            <span className="pr-file-stats">
                              <span className="pr-add">+{file.additions}</span>
                              <span className="pr-del">-{file.deletions}</span>
                            </span>
                          </button>
                          {expanded && file.hunks.length > 0 && (
                            <div className="pr-file-snippets">
                              {file.hunks.map((hunk, hunkIdx) => (
                                <div className="pr-file-hunk" key={`${key}-hunk-${hunkIdx}`}>
                                  <div className="pr-file-hunk-header">{hunk.header}</div>
                                  <div className="pr-file-hunk-body">
                                    {hunk.lines.map((line, lineIdx) => (
                                      <div
                                        className={`pr-diff-line ${diffLineClass(line)}`}
                                        key={`${key}-hunk-${hunkIdx}-line-${lineIdx}`}
                                      >
                                        {line || " "}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div className="pr-changes-footer">
                    {totals.additions} additions, {totals.deletions} deletions
                  </div>
                </div>
              ) : (
                <div className="no-diff">No changes detected yet.</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
