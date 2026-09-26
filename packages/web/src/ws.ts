/**
 * WS 客户端单例：连 orchestrator，把 ServerEvent 转成 store 操作，暴露 send 发命令。
 */
import type { ClientCommand, ServerEvent } from "@ai-cowork/shared";
import { useStore } from "./store";

let ws: WebSocket | null = null;
let wantOpen = false;
// ★ BUG 修复：重连固定 2s 死循环，服务端长时间宕机时每 2s 重连永不放弃。
//   改为指数退避：2s → 4 → 8 → 16 → 30s 封顶，减少无效重连。
let reconnectDelay = 2000;
const MAX_RECONNECT_DELAY = 30000;

/** 生成命令 id。crypto.randomUUID 需要安全上下文(https/localhost)，预览代理下可能不可用，做兜底。 */
export function genId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // 忽略，走兜底
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function connectWs() {
  wantOpen = true;
  reconnectDelay = 2000;
  open();
}

function open() {
  // 走当前页面 host 上的 /ws，由 Vite dev server 代理到 orchestrator(3001)。
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/ws`;
  ws = new WebSocket(url);
  ws.onopen = () => {
    useStore.getState().setConnected(true);
    // 连接成功，重置退避
    reconnectDelay = 2000;
  };
  ws.onclose = () => {
    useStore.getState().setConnected(false);
    ws = null;
    if (wantOpen) {
      // ★ 指数退避：每次失败翻倍，封顶 30s
      const delay = reconnectDelay;
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
      setTimeout(open, delay);
    }
  };
  ws.onerror = () => {
    // onclose 会兜底重连
  };
  ws.onmessage = (e) => {
    let msg: unknown;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    handleEvent(msg as ServerEvent);
  };
}

export function send(cmd: ClientCommand) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(cmd));
  }
}

/** 发命令并以 Promise 等待对应 response */
export function sendAsync(cmd: ClientCommand): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error("ws not connected"));
      return;
    }
    // ★ 统一清理：response 收到 / ws 关闭 / 超时 三种情况都移除 listener 和 timer
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      ws?.removeEventListener("message", handler);
      ws?.removeEventListener("close", onClose);
      if (timer) { clearTimeout(timer); timer = null; }
    };
    const handler = (raw: MessageEvent) => {
      try {
        const msg = JSON.parse(raw.data);
        if (msg.type === "response" && msg.id === cmd.id) {
          cleanup();
          if (msg.success) resolve(msg.data);
          else reject(new Error(msg.error || "command failed"));
        }
      } catch {
        // 忽略非 JSON
      }
    };
    // ★ ws 断开时 reject：之前没监听 close，如果命令发出后 ws 断开
    //   （如服务重启/网络中断），Promise 永远挂起，导致 busy 状态卡死
    const onClose = () => {
      cleanup();
      reject(new Error("ws closed before response"));
    };
    // ★ BUG 修复：ws 仍 OPEN 但服务端 bug/崩溃未回 response 时，Promise 永久挂起，
    //   listener 永久驻留 + busy 状态卡死。加 30s 超时兜底。
    timer = setTimeout(() => {
      cleanup();
      reject(new Error("command timeout (30s)"));
    }, 30000);
    ws.addEventListener("message", handler);
    ws.addEventListener("close", onClose);
    ws.send(JSON.stringify(cmd));
  });
}

function handleEvent(ev: ServerEvent) {
  const s = useStore.getState();
  switch (ev.type) {
    case "session.ready":
      s.setSession(ev.sessionId, ev.model, ev.reviewer, ev.permissionMode);
      break;
    case "agent_start":
      // 只有 coder 的 agent_start 会让顶部显示"思考中"（reviewer 是后台静默审查）
      if (ev.agent === "coder") s.setStreaming(true);
      s.append({ kind: "lifecycle", agent: ev.agent, type: "agent_start", ts: Date.now() });
      break;
    case "agent_end":
      if (ev.agent === "coder") s.setStreaming(false);
      s.append({ kind: "lifecycle", agent: ev.agent, type: "agent_end", ts: Date.now() });
      break;
    case "turn_start":
      s.append({ kind: "lifecycle", agent: ev.agent, type: "turn_start", ts: Date.now() });
      break;
    case "turn_end":
      s.append({ kind: "lifecycle", agent: ev.agent, type: "turn_end", ts: Date.now() });
      break;
    case "thinking_delta":
      s.append({ kind: "thinking", agent: ev.agent, text: ev.delta, ts: Date.now() });
      break;
    case "text_delta":
      s.append({ kind: "text", agent: ev.agent, text: ev.delta, ts: Date.now() });
      break;
    case "tool_start":
      s.append({ kind: "tool_start", agent: ev.agent, toolName: ev.toolName, args: ev.args, ts: Date.now() });
      break;
    case "tool_end":
      s.append({ kind: "tool_end", agent: ev.agent, toolName: ev.toolName, isError: ev.isError, ts: Date.now() });
      break;
    case "queue_update":
      s.setQueue(ev.steering.length, ev.followUp.length);
      s.append({ kind: "queue", steering: ev.steering.length, followUp: ev.followUp.length, ts: Date.now() });
      break;
    case "file.changed":
      // 只把 coder 的文件变更作为"观察到的最近变更"展示到文件树/UI，reviewer 的读操作不干扰 UI
      if (ev.agent === "coder") {
        if (ev.content !== undefined) s.setFileContent(ev.path, ev.content);
        s.markFileChanged(ev.path, ev.toolCallId);
        s.setCurrentPath(ev.path);
      } else if (ev.content !== undefined) {
        // reviewer 的 view 操作也填充 fileContents 缓存，点文件时直接展示
        s.setFileContent(ev.path, ev.content);
      }
      break;
    case "terminal.cmd":
      s.addTerminalLine({ toolCallId: ev.toolCallId, kind: "cmd", text: ev.command, ts: Date.now() });
      break;
    case "terminal.output":
      s.addTerminalLine({ toolCallId: ev.toolCallId, kind: ev.stream, text: ev.delta, ts: Date.now() });
      break;
    case "terminal.exit":
      s.addTerminalLine({ toolCallId: ev.toolCallId, kind: "exit", text: `exit ${ev.exitCode}`, ts: Date.now() });
      break;
    case "error":
      s.append({ kind: "error", agent: ev.agent, message: `[${ev.code}] ${ev.message}`, ts: Date.now() });
      break;
    case "review.finished":
      s.append({
        kind: "review",
        severe: ev.severe,
        summary: ev.summary,
        reviewed: ev.reviewed,
        ts: Date.now(),
      });
      break;
    case "checkpoint.created":
      s.addCheckpoint(ev.checkpoint);
      s.append({ kind: "lifecycle", type: `checkpoint 已创建 ${ev.checkpoint.label || ev.checkpoint.id.slice(0, 8)}`, ts: Date.now() });
      break;
    case "checkpoint.rolled_back":
      s.append({ kind: "lifecycle", type: `已回滚到 checkpoint ${ev.checkpointId.slice(0, 8)}`, ts: Date.now() });
      // ★ BUG 修复：之前用 send（静默丢弃），response 无监听者，文件树不会刷新。
      //   改用 sendAsync 拿到文件列表后 setFiles，确保回滚后 UI 与磁盘一致。
      sendAsync({ id: genId(), type: "file.list", sessionId: ev.sessionId })
        .then((files) => useStore.getState().setFiles(files as never))
        .catch(() => { /* 忽略，文件树刷新失败不阻塞 */ });
      break;
    case "preview.started":
      s.setPreview(ev.preview);
      s.append({ kind: "lifecycle", type: `预览已启动 → ${ev.preview.entry || "/"}`, ts: Date.now() });
      // 启动后立刻 bump 一次，保证 iframe 加载
      s.bumpPreviewRev();
      break;
    case "preview.stopped":
      s.setPreview(null);
      s.append({ kind: "lifecycle", type: "预览已停止", ts: Date.now() });
      break;
    case "preview.updated":
      s.bumpPreviewRev();
      break;
    case "copilot.status":
      s.setCopilotStatus(ev.status, ev.queuePosition, ev.currentTask, ev.queueLength);
      break;
    case "copilot.reply":
      s.addCopilotReply(ev.message);
      break;
    case "copilot.applied":
      s.append({ kind: "lifecycle", type: `✅ Copilot 指令已注入 Coder（${ev.mode}）: ${ev.instruction.slice(0, 60)}`, ts: Date.now() });
      break;
    case "permission.blocked":
      s.append({ kind: "blocked", toolName: ev.toolName, command: ev.command, rule: ev.rule, mode: ev.mode, ts: Date.now() });
      break;
    case "plan.proposed":
      s.setPlanProposed(ev.plan, ev.summary);
      s.append({ kind: "lifecycle", type: `📋 计划已提出，等待批准：${ev.summary}`, ts: Date.now() });
      break;
    case "plan.decision":
      s.setPlanDecision(ev.decision, ev.feedback);
      {
        const label = ev.decision === "approved" ? "✅ 计划已批准，开始执行"
          : ev.decision === "rejected" ? "❌ 计划已拒绝，Coder 将重新规划"
          : `🔁 计划需修改${ev.feedback ? `：${ev.feedback}` : ""}`;
        s.append({ kind: "lifecycle", type: label, ts: Date.now() });
      }
      break;
    default:
      // 未处理的事件类型，记录警告便于调试
      console.warn('[ws] 未处理的事件类型:', (ev as { type: string }).type);
      break;
  }
}
