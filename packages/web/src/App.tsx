import { useState, useEffect, useRef } from "react";
import { useStore } from "./store";
import { sendAsync, genId } from "./ws";
import { ThoughtStream } from "./components/ThoughtStream";
import { InputBar } from "./components/InputBar";
import { FileTree } from "./components/FileTree";
import { CodeView } from "./components/CodeView";
import { Terminal } from "./components/Terminal";
import { CheckpointPanel } from "./components/CheckpointPanel";
import { PreviewPanel } from "./components/PreviewPanel";
import { CopilotPanel } from "./components/CopilotPanel";
import { PlanApprovalPanel } from "./components/PlanApprovalPanel";

/** 会话设置默认值 */
const DEFAULT_CWD = "/tmp/aicowork-preview";
const DEFAULT_MODEL = "";
const DEFAULT_REVIEW = true;

export default function App() {
  const connected = useStore((s) => s.connected);
  const sessionId = useStore((s) => s.sessionId);
  const model = useStore((s) => s.model);
  const isStreaming = useStore((s) => s.isStreaming);
  const steeringCount = useStore((s) => s.steeringCount);
  const followUpCount = useStore((s) => s.followUpCount);
  const reviewer = useStore((s) => s.reviewer);
  const permissionMode = useStore((s) => s.permissionMode);
  const planPhase = useStore((s) => s.planState?.phase);
  const setFiles = useStore((s) => s.setFiles);
  const setSession = useStore((s) => s.setSession);
  const clear = useStore((s) => s.clear);

  const [bottomTab, setBottomTab] = useState<"terminal" | "preview" | "thoughts">("terminal");

  // 会话设置
  const [cwd, setCwd] = useState(DEFAULT_CWD);
  const [modelSpec, setModelSpec] = useState(DEFAULT_MODEL);
  const [startReview, setStartReview] = useState(DEFAULT_REVIEW);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [starting, setStarting] = useState(false);

  /** 启动会话 */
  const doStart = async () => {
    if (!connected || starting) return;
    setStarting(true);
    try {
      clear();
      const data = (await sendAsync({
        id: genId(),
        type: "session.start",
        cwd,
        model: modelSpec || undefined,
        review: startReview,
      })) as { sessionId: string; reviewer?: boolean };
      setSession(data.sessionId, undefined, data.reviewer, "free");
      try {
        const files = await sendAsync({ id: genId(), type: "file.list", sessionId: data.sessionId });
        setFiles(files as never);
      } catch { /* 忽略 */ }
    } catch (err) {
      console.error("启动 Agent 失败：", err);
    } finally {
      setStarting(false);
    }
  };

  // ws 连接成功后自动启动（仅首次）
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!connected || sessionId || autoStarted.current) return;
    autoStarted.current = true;
    doStart();
  }, [connected, sessionId]);

  return (
    <div className="app">
      <header>
        <span className={`dot ${connected ? "on" : ""}`} />
        {connected ? "已连接" : "未连接"}
        {sessionId && (
          <>
            {" · session "}
            <code>{sessionId.slice(0, 8)}</code>
            {model && <span className="model"> · {model}</span>}
            {reviewer && <span className="badge reviewer-badge">👀 Reviewer ON</span>}
            {permissionMode !== "free" && <span className={`badge perm-badge perm-${permissionMode}`}>🔒 {permissionMode === "read-only" ? "只读" : "计划模式"}</span>}
            {planPhase === "proposing" && <span className="badge plan-pending-badge">📋 计划待批准</span>}
            {planPhase === "approved" && <span className="badge plan-approved-badge">✅ 计划执行中</span>}
          </>
        )}
        {isStreaming && <span className="streaming">思考中…</span>}
        {(steeringCount > 0 || followUpCount > 0) && (
          <span className="queue">
            队列: steer {steeringCount} / followUp {followUpCount}
          </span>
        )}
        <button
          className={`settings-toggle ${settingsOpen ? "open" : ""}`}
          onClick={() => setSettingsOpen((v) => !v)}
          title="会话设置"
        >
          ⚙️ 设置 {settingsOpen ? "▲" : "▼"}
        </button>
      </header>

      {/* 可折叠的会话设置面板 */}
      {settingsOpen && (
        <div className="settings-panel">
          <div className="settings-grid">
            <label>
              工作目录 (cwd)
              <input value={cwd} onChange={(e) => setCwd(e.target.value)} />
            </label>
            <label>
              模型（如 deepseek/deepseek-chat）
              <input value={modelSpec} onChange={(e) => setModelSpec(e.target.value)} placeholder="留空用默认" />
            </label>
            <label className="checkbox-row">
              <input type="checkbox" checked={startReview} onChange={(e) => setStartReview(e.target.checked)} />
              启用 Reviewer Agent
            </label>
          </div>
          <div className="settings-actions">
            <button onClick={doStart} disabled={!connected || starting || !!sessionId}>
              {starting ? "启动中…" : "🚀 启动会话"}
            </button>
          </div>
        </div>
      )}

      <div className="main">
        <div className="left-pane">
          <FileTree />
          <CheckpointPanel />
        </div>
        <div className="center-pane">
          <div className="center-top">
            <CodeView />
          </div>
          <div className="center-bottom">
            <div className="bottom-tabs">
              <button className={`tab ${bottomTab === "terminal" ? "active" : ""}`} onClick={() => setBottomTab("terminal")}>终端</button>
              <button className={`tab ${bottomTab === "preview" ? "active" : ""}`} onClick={() => setBottomTab("preview")}>预览</button>
              <button className={`tab ${bottomTab === "thoughts" ? "active" : ""}`} onClick={() => setBottomTab("thoughts")}>思考流</button>
            </div>
            <div className="tab-content">
              {bottomTab === "terminal" && <Terminal />}
              {bottomTab === "preview" && <PreviewPanel />}
              {bottomTab === "thoughts" && <ThoughtStream />}
            </div>
          </div>
        </div>
        <div className="right-pane">
          <CopilotPanel />
        </div>
        <div className="input-area">
          <InputBar />
        </div>
      </div>

      {sessionId && <PlanApprovalPanel />}
    </div>
  );
}
