import { useState, useEffect, useRef } from "react";
import { useStore } from "../store";
import { send, sendAsync, genId } from "../ws";
import type { PermissionMode } from "@ai-cowork/shared";

export function InputBar() {
  const sessionId = useStore((s) => s.sessionId)!;
  const isStreaming = useStore((s) => s.isStreaming);
  const connected = useStore((s) => s.connected);
  const permissionMode = useStore((s) => s.permissionMode);
  const append = useStore((s) => s.append);
  const setPermissionMode = useStore((s) => s.setPermissionMode);
  const [msg, setMsg] = useState("");
  const [aborting, setAborting] = useState(false);
  const abortTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // abort 完成后重置
  useEffect(() => {
    if (!isStreaming && aborting) setAborting(false);
  }, [isStreaming, aborting]);

  useEffect(() => {
    return () => {
      if (abortTimerRef.current) clearTimeout(abortTimerRef.current);
    };
  }, []);

  const submit = (kind: "steer" | "follow_up") => {
    if (!msg.trim()) return;
    if (!connected) {
      append({ kind: "lifecycle", type: "⚠️ 未连接到服务器，消息未发送，等待重连后重试", ts: Date.now() });
      return;
    }
    send({ id: genId(), type: kind, sessionId, message: msg });
    if (kind === "steer") {
      append({ kind: "lifecycle", agent: "coder", type: `📝 Steer 已排队: "${msg.trim().slice(0, 80)}"（将在下一个工具边界注入）`, ts: Date.now() });
    } else {
      append({ kind: "lifecycle", type: `📋 Follow-up 已排队: "${msg.trim().slice(0, 80)}"（将在本轮结束后消费）`, ts: Date.now() });
    }
    setMsg("");
  };

  const prompt = () => {
    if (!msg.trim()) return;
    if (!connected) {
      append({ kind: "lifecycle", type: "⚠️ 未连接到服务器，消息未发送", ts: Date.now() });
      return;
    }
    send({
      id: genId(),
      type: "prompt",
      sessionId,
      message: msg,
      streamingBehavior: isStreaming ? "steer" : undefined,
    });
    setMsg("");
  };

  const abort = async () => {
    append({ kind: "lifecycle", agent: "coder", type: "⏹ 正在停止 Agent…", ts: Date.now() });
    setAborting(true);
    try {
      await sendAsync({ id: genId(), type: "abort", sessionId });
    } catch {
      // ws 断开等场景
    } finally {
      if (abortTimerRef.current) clearTimeout(abortTimerRef.current);
      abortTimerRef.current = setTimeout(() => setAborting(false), 3000);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      isStreaming ? submit("steer") : prompt();
    }
  };

  return (
    <div className={`input-bar${isStreaming ? " streaming" : ""}`}>
      <textarea
        value={msg}
        onChange={(e) => setMsg(e.target.value)}
        onKeyDown={onKey}
        rows={3}
        placeholder={
          isStreaming
            ? "输入消息注入… (Steer 在工具边界插入，不会立即停止。要立即停止请点「停止」)"
            : "输入新指令…"
        }
      />
      <div className="input-bar-row">
        {/* 权限模式切换 */}
        <select
          className={`perm-select perm-${permissionMode}`}
          value={permissionMode ?? "free"}
          onChange={async (e) => {
            const mode = e.target.value as PermissionMode;
            try {
              await sendAsync({ id: genId(), type: "permission.update", sessionId, permissionMode: mode });
              setPermissionMode(mode);
            } catch (err) {
              console.error("权限切换失败：", err);
            }
          }}
        >
          <option value="free">🔓 free — 全开</option>
          <option value="read-only">🔒 read-only — 只读</option>
          <option value="plan">📋 plan — 计划模式</option>
        </select>
        <div className="btns">
          {isStreaming && (
            <button className="abort-btn" onClick={abort} disabled={aborting}>
              {aborting ? "正在停止…" : "⏹ 停止"}
            </button>
          )}
          {isStreaming ? (
            <button className="steer" onClick={() => submit("steer")} disabled={!msg.trim()}>
              Steer (注入消息)
            </button>
          ) : (
            <button className="prompt" onClick={prompt} disabled={!msg.trim()}>
              发送
            </button>
          )}
          <button
            className="followup"
            onClick={() => submit("follow_up")}
            disabled={!msg.trim()}
          >
            Follow-up (排队)
          </button>
        </div>
      </div>
      <div className="hint">
        {isStreaming
          ? "⏹停止 = 立即中止 · Steer = 注入消息但不停止 · ⌘/Ctrl+Enter = Steer"
          : "⌘/Ctrl+Enter 发送"}
      </div>
    </div>
  );
}
