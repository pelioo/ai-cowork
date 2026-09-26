/**
 * Orchestrator 入口：Fastify + WebSocket。
 * - WS /ws：收 ClientCommand，调 SessionRegistry，回 CommandResponse；broadcast ServerEvent。
 * - GET /：健康检查。
 * - GET /preview/:sessionId/*：静态预览服务器的 HTTP 代理（指向 session 的 preview server），
 *   这样前端不需要直接访问额外端口，经预览代理时依然可用。
 */
import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import http from "node:http";
import { URL } from "node:url";
import type { WebSocket } from "ws";
import {
  ClientCommand,
  type CommandResponse,
  type ServerEvent,
  type PermissionMode,
} from "@ai-cowork/shared";
import { config } from "./config.js";
import { SessionRegistry } from "./session-registry.js";

const fastify = Fastify({ logger: { level: "info" } });
await fastify.register(fastifyWebsocket);

const clients = new Set<WebSocket>();

// preview.updated 的简单 debounce：sessionId -> timer，避免一次写入刷 10 次 iframe
const previewTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** 清理指定 session 的 preview debounce timer（preview.stop / dispose 时调用） */
function clearPreviewTimer(sessionId: string): void {
  const t = previewTimers.get(sessionId);
  if (t) {
    clearTimeout(t);
    previewTimers.delete(sessionId);
  }
}

const broadcast = (event: ServerEvent) => {
  const msg = JSON.stringify(event);
  for (const c of clients) {
    try {
      c.send(msg);
    } catch {
      // 连接已断开，忽略
    }
  }
  // ★ preview.stopped / session 销毁时清理 debounce timer，避免：
  //   1. timer 泄漏（session 关闭后 timer 仍挂在 Map 里）
  //   2. preview 停止后仍可能触发一次空的 preview.updated 广播
  if (event.type === "preview.stopped") {
    clearPreviewTimer(event.sessionId);
    return;
  }
  // 如果是 file.changed 且该 session 有 preview 在跑，debounce 发 preview.updated
  if (event.type === "file.changed") {
    const port = registry.getPreviewPort(event.sessionId);
    if (port) {
      const old = previewTimers.get(event.sessionId);
      if (old) clearTimeout(old);
      previewTimers.set(
        event.sessionId,
        setTimeout(() => {
          previewTimers.delete(event.sessionId);
          const upd: ServerEvent = {
            sessionId: event.sessionId,
            type: "preview.updated",
            path: event.path,
          };
          const updMsg = JSON.stringify(upd);
          for (const c of clients) {
            try {
              c.send(updMsg);
            } catch {
              // 忽略
            }
          }
        }, 250),
      );
    }
  }
};

const registry = new SessionRegistry(broadcast);

fastify.get("/", async () => ({ ok: true, service: "ai-cowork-orchestrator", sessions: registry["sessions"]?.size ?? 0 }));

/**
 * 预览代理：/preview/:sessionId/rest/of/path -> http://127.0.0.1:<previewPort>/rest/of/path
 */
fastify.get(
  "/preview/:sessionId/*",
  async (req: FastifyRequest<{ Params: { sessionId: string; "*"?: string } }>, reply: FastifyReply) => {
    const sessionId = req.params.sessionId;
    const port = registry.getPreviewPort(sessionId);
    if (!port) {
      reply.code(404).send("preview not running for session");
      return;
    }
    const rest = req.params["*"] ?? "";
    const qs = (req.url as string).split("?")[1];
    const upstreamUrl = `http://127.0.0.1:${port}/${rest}${qs ? "?" + qs : ""}`;
    // 用 node http 反向代理，不加新依赖
    await new Promise<void>((resolve) => {
      const u = new URL(upstreamUrl);
      const opts: http.RequestOptions = {
        method: req.method,
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers: {
          // 透传浏览器的 accept/cookie 等，去掉 host（否则会指向外层 host）
          ...Object.fromEntries(
            Object.entries(req.headers).filter(([k]) => k.toLowerCase() !== "host"),
          ),
          host: u.host,
        },
        // ★ 加超时：上游 preview 卡住时 5s 后主动 abort，避免 fastify 连接被长期占用、前端一直转圈
        timeout: 5000,
      };
      const proxyReq = http.request(opts, (upRes) => {
        reply.code(upRes.statusCode ?? 200);
        // 去掉 transfer-encoding / content-length 等冲突头
        const skip = new Set(["transfer-encoding", "connection", "keep-alive"]);
        for (const [k, v] of Object.entries(upRes.headers)) {
          if (skip.has(k.toLowerCase())) continue;
          if (v === undefined) continue;
          // fastify header 接受 string | string[]；upRes.headers 的值类型正确
          reply.header(k, v as never);
        }
        // ★ BUG 修复：客户端断开后 reply.raw 已销毁，write/end 会抛错或触发 error 事件。
        //   之前未监听 reply.raw 的 error，可能导致进程崩溃。
        //   修复：写入前检查 destroyed，并监听 error 吞掉（连接已断无需处理）。
        const safeWrite = (chunk: Buffer): boolean => {
          if (reply.raw.destroyed || reply.raw.writableEnded) return false;
          try {
            return reply.raw.write(chunk);
          } catch {
            return false;
          }
        };
        upRes.on("data", (chunk) => safeWrite(chunk));
        upRes.on("end", () => {
          if (!reply.raw.destroyed && !reply.raw.writableEnded) {
            try { reply.raw.end(); } catch { /* 忽略 */ }
          }
          resolve();
        });
        upRes.on("error", () => {
          if (!reply.raw.destroyed && !reply.raw.writableEnded) {
            try { reply.raw.end(); } catch { /* 忽略 */ }
          }
          resolve();
        });
      });
      // ★ socket 超时触发后主动 destroy，让 upRes/end 永不触发 → 兜底回 504
      let settled = false;
      proxyReq.on("timeout", () => {
        proxyReq.destroy(new Error("preview upstream timeout"));
      });
      proxyReq.on("error", (err) => {
        // ★ BUG 修复：若 upRes 已开始写（headers/body 部分已发），reply.code(502).send 会抛
        //   FST_ERR_REP_ALREADY_SENT。用 settled 标志保护，已 settled 则只 end raw 不再 send。
        if (settled) return;
        settled = true;
        // 脱敏：只暴露通用错误类别，不泄露内部路径
        const msg = err.message.includes("timeout") ? "preview upstream timeout" : "preview upstream error";
        if (!reply.raw.headersSent && !reply.raw.writableEnded) {
          reply.code(502).send(msg);
        } else if (!reply.raw.writableEnded) {
          try { reply.raw.end(); } catch { /* 忽略 */ }
        }
        resolve();
      });
      // upRes 的 end/error 也要设 settled，防止 timeout 后 upRes 仍触发 resolve 二次调用
      const markSettled = () => { settled = true; };
      proxyReq.on("response", markSettled);
      proxyReq.end();
    });
  },
);

fastify.get("/ws", { websocket: true }, (connection, req) => {
  // 兼容 fastify-websocket 不同版本：connection 可能是 socket 或 { socket }
  const socket = (connection as WebSocket & { socket?: WebSocket }).socket ?? (connection as WebSocket);
  // ★ WS 鉴权
  //   - 配了 authToken：query 里 ?token=xxx 必须匹配
  //   - 没配 authToken：只允许本机回环连接（仅靠 peer IP 判断，Host 头可被客户端伪造，不能用作身份凭证）
  const query = (req.url ?? "").split("?")[1] ?? "";
  const params = new URLSearchParams(query);
  const token = params.get("token");
  // ★ req.socket 是 http 升级请求的 net.Socket，直接取 remoteAddress 即可。
  //   之前写 req.socket.socket?.remoteAddress 是误用了 fastify-websocket 的 connection.socket 形式，
  //   实际 req.socket 已经是底层 Socket，访问 .socket 属性会触发 TS 编译错误。
  const peerAddr = req.socket.remoteAddress ?? "";
  const isLoopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peerAddr);
  if (config.authToken) {
    if (token !== config.authToken) {
      try { socket.close(4001, "unauthorized"); } catch {}
      return;
    }
  } else if (!isLoopback) {
    try { socket.close(4003, "loopback only; set AICOWORK_AUTH_TOKEN to expose"); } catch {}
    return;
  }
  clients.add(socket);

  socket.on("message", async (raw: Buffer) => {
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      send(socket, { id: "", type: "response", command: "", success: false, error: "invalid JSON" });
      return;
    }

    const parsed = ClientCommand.safeParse(payload);
    if (!parsed.success) {
      send(socket, {
        id: (payload as { id?: string })?.id ?? "",
        type: "response",
        command: (payload as { type?: string })?.type ?? "",
        success: false,
        error: parsed.error.message,
      });
      return;
    }
    await handleCommand(parsed.data, (resp) => send(socket, resp));
  });

  socket.on("close", () => clients.delete(socket));
  socket.on("error", () => clients.delete(socket));
});

function send(socket: WebSocket, msg: CommandResponse | ServerEvent) {
  try {
    socket.send(JSON.stringify(msg));
  } catch {
    // 忽略
  }
}

async function handleCommand(cmd: ClientCommand, reply: (r: CommandResponse) => void) {
  try {
    switch (cmd.type) {
      case "session.start": {
        const { sessionId, model, reviewer, permissionMode } = await registry.start({
          cwd: cmd.cwd,
          prompt: cmd.prompt,
          model: cmd.model,
          review: (cmd as { review?: boolean }).review,
          permissionMode: (cmd as { permissionMode?: PermissionMode }).permissionMode,
        });
        const dataObj: { sessionId: string; model?: string; reviewer?: boolean; permissionMode: string } = { sessionId, model, reviewer, permissionMode };
        reply({ id: cmd.id, type: "response", command: cmd.type, success: true, data: dataObj });
        broadcast({ sessionId, type: "session.ready", model, reviewer, permissionMode });
        break;
      }
      case "steer":
        await registry.steer(cmd.sessionId, cmd.message);
        reply({ id: cmd.id, type: "response", command: cmd.type, success: true });
        break;
      case "follow_up":
        await registry.followUp(cmd.sessionId, cmd.message);
        reply({ id: cmd.id, type: "response", command: cmd.type, success: true });
        break;
      case "abort":
        await registry.abort(cmd.sessionId);
        reply({ id: cmd.id, type: "response", command: cmd.type, success: true });
        break;
      case "permission.update": {
        try {
          registry.setPermissionMode(cmd.sessionId, cmd.permissionMode);
          reply({ id: cmd.id, type: "response", command: cmd.type, success: true });
        } catch (err) {
          reply({ id: cmd.id, type: "response", command: cmd.type, success: false, error: String(err) });
        }
        break;
      }
      case "prompt":
        await registry.prompt(cmd.sessionId, cmd.message, cmd.streamingBehavior);
        reply({ id: cmd.id, type: "response", command: cmd.type, success: true });
        break;
      case "file.list": {
        const entries = await registry.listFiles(cmd.sessionId);
        reply({ id: cmd.id, type: "response", command: cmd.type, success: true, data: entries });
        break;
      }
      case "file.read": {
        const content = await registry.readFile(cmd.sessionId, cmd.path);
        reply({ id: cmd.id, type: "response", command: cmd.type, success: true, data: { path: cmd.path, content } });
        break;
      }
      case "checkpoint.create": {
        const cp = await registry.createCheckpoint(cmd.sessionId, cmd.label);
        reply({ id: cmd.id, type: "response", command: cmd.type, success: true, data: cp });
        broadcast({ sessionId: cmd.sessionId, type: "checkpoint.created", checkpoint: cp });
        break;
      }
      case "checkpoint.list": {
        const list = await registry.listCheckpoints(cmd.sessionId);
        reply({ id: cmd.id, type: "response", command: cmd.type, success: true, data: list });
        break;
      }
      case "checkpoint.rollback": {
        await registry.rollbackCheckpoint(cmd.sessionId, cmd.checkpointId);
        reply({ id: cmd.id, type: "response", command: cmd.type, success: true });
        broadcast({ sessionId: cmd.sessionId, type: "checkpoint.rolled_back", checkpointId: cmd.checkpointId });
        break;
      }
      case "preview.start": {
        const preview = await registry.startPreview(cmd.sessionId, cmd.entry);
        reply({ id: cmd.id, type: "response", command: cmd.type, success: true, data: preview });
        broadcast({ sessionId: cmd.sessionId, type: "preview.started", preview });
        break;
      }
      case "preview.stop": {
        await registry.stopPreview(cmd.sessionId);
        reply({ id: cmd.id, type: "response", command: cmd.type, success: true });
        broadcast({ sessionId: cmd.sessionId, type: "preview.stopped" });
        break;
      }
      case "copilot.chat": {
        await registry.copilotChat(cmd.sessionId, cmd.message);
        reply({ id: cmd.id, type: "response", command: cmd.type, success: true });
        break;
      }
      case "copilot.apply": {
        await registry.copilotApply(cmd.sessionId, cmd.instruction, cmd.mode);
        reply({ id: cmd.id, type: "response", command: cmd.type, success: true });
        break;
      }
      case "plan.approve": {
        await registry.planApprove(cmd.sessionId, cmd.decision, cmd.feedback);
        reply({ id: cmd.id, type: "response", command: cmd.type, success: true });
        break;
      }
    }
  } catch (e) {
    reply({
      id: cmd.id,
      type: "response",
      command: cmd.type,
      success: false,
      // ★ 脱敏：内部异常原样回前端可能泄露服务器路径/栈片段。
      //   - 已知业务错误（如 "session not found"）保留原文，便于用户排查
      //   - 含路径/堆栈的未知错误统一回 "internal error"，详情只记日志
      error: sanitizeError(e),
    });
  }
}

/** 错误脱敏：业务错误保留，含敏感信息的内部错误统一回 internal error */
function sanitizeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  // 简单启发式：含绝对路径 / 系统错误码 / 堆栈帧 → 视为内部错误
  // ★ BUG 修复：之前用 msg.includes("at ") 误判正常业务消息（如 "no file at the moment"）。
  //   堆栈帧格式是 "\n    at Function.name (file:line:col)"，用更精确的正则。
  if (/\/(home|usr|var|tmp|root)\//.test(msg) || /\b(ENOENT|EACCES|ECONNREFUSED):\s/.test(msg) || /\n\s+at\s+\S+\s+\(/.test(msg)) {
    return "internal error (see server logs)";
  }
  return msg;
}

// 优雅退出（去重，避免二次 Ctrl+C 触发 fastify.close() 二次调用抛错）
let shuttingDown = false;
const shutdown = (sig: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  fastify.log.info({ sig }, "shutting down");
  registry.disposeAll();
  fastify.close().then(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

if (!config.anthropicKey && !config.openaiKey && !config.deepseekKey) {
  fastify.log.warn("未检测到 ANTHROPIC_API_KEY / OPENAI_API_KEY / DEEPSEEK_API_KEY，Agent 可能无法运行");
}

// ★ 安全提示：未设 token 且监听非回环时，启动期高亮警告
//   回环地址集合与 WS 鉴权的 isLoopback 保持一致（127.0.0.1 / localhost / ::1 / ::ffff:127.0.0.1）
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1"]);
if (!config.authToken && !LOOPBACK_HOSTS.has(config.host)) {
  fastify.log.warn("⚠️  HOST=0.0.0.0 但未设置 AICOWORK_AUTH_TOKEN：任何人都能连上 /ws 调用 Agent，强烈建议设置 token！");
}

fastify
  .listen({ port: config.port, host: config.host })
  .then(() => fastify.log.info(`orchestrator listening on ${config.host}:${config.port}`))
  .catch((err) => {
    fastify.log.error(err, "listen failed");
    process.exit(1);
  });
