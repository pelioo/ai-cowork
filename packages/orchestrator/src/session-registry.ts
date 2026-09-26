/**
 * SessionRegistry：管理多个 AgentSession 的生命周期，封装 steer/followUp/abort/prompt。
 * 每个 session 订阅 pi 事件，经 event-bridge 映射后 broadcast 给所有 WS 客户端。
 */
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve as pathResolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createAgentSession,
  type AgentSession,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { getModel, type Model } from "@mariozechner/pi-ai";
import type { ServerEvent, FileEntry, CheckpointInfo, PreviewInfo, PermissionMode } from "@ai-cowork/shared";
import { mapEvent, flushPendingFileReads, registerPendingFlushSubscriber, type BridgeContext } from "./event-bridge.js";
import { config } from "./config.js";
import * as CP from "./checkpoints.js";
import * as PV from "./preview-server.js";

export interface StartOptions {
  cwd: string;
  prompt?: string;
  model?: string;
  /** 是否同时启动 reviewer（结对编程），默认 true */
  review?: boolean;
  /** 权限模式：free(默认)/read-only/plan */
  permissionMode?: PermissionMode;
}

/** Copilot 队列任务 */
interface CopilotTask {
  type: "review" | "chat";
  /** chat 时的用户消息 */
  message?: string;
  /** review 时的文件列表 */
  files?: string[];
  /** 回复用的 resolve（chat 任务完成后调用） */
  resolve?: (reply: string, applyInstruction?: string) => void;
}

interface SessionEntry {
  session: AgentSession;
  unsubscribe: () => void;
  cwd: string;
  /** 标记 coder 是否被 abort，abort 后的 turn_end 不触发 reviewer */
  aborted: boolean;
  /** reviewer/copilot agent（可选，独立 session，共享同一个 cwd） */
  reviewer?: {
    session: AgentSession;
    unsubscribe: () => void;
    /** 正在处理任务中，避免重入 */
    busy: boolean;
  };
  /** Copilot 任务队列（FIFO，但 chat 可插队到 review 前面） */
  copilotQueue: CopilotTask[];
  /** coder 端本次 turn 修改过的文件集合（相对路径，供 reviewer 聚焦阅读） */
  turnChangedFiles: Set<string>;
  /** 权限模式：决定 Coder 可用工具集 + 危险命令拦截策略 */
  permissionMode: PermissionMode;
  /** plan 模式状态机：proposing=已出计划待批准 / approved=已批准执行中 / null=未进入计划阶段 */
  planState: { phase: "proposing" | "approved"; plan: string } | null;
}

export class SessionRegistry {
  private sessions = new Map<string, SessionEntry>();
  private broadcast: (event: ServerEvent) => void;

  constructor(broadcast: (event: ServerEvent) => void) {
    this.broadcast = broadcast;
    // ★ 注册 pendingFileReads 兜底 flush 回调：
    //   edit 工具的 readFile 是异步的，可能在最后一个 pi 事件 flush 之后才完成 push。
    //   这里注册一个 subscriber，当 scheduleFallbackFlush 触发时，把 pending 事件广播出去。
    registerPendingFlushSubscriber((events) => {
      for (const p of events) {
        const ev: ServerEvent = {
          sessionId: p.sessionId,
          type: "file.changed",
          agent: p.agent,
          path: p.path,
          kind: p.kind,
          content: p.content,
          toolCallId: p.toolCallId,
        };
        this.broadcast(ev);
      }
    });
  }

  async start(opts: StartOptions): Promise<{ sessionId: string; model?: string; reviewer?: boolean; permissionMode: PermissionMode }> {
    // 确保 cwd 存在
    await mkdir(opts.cwd, { recursive: true });

    const permissionMode: PermissionMode = opts.permissionMode ?? "free";

    const sessionId = randomUUID();
    const createOpts: Parameters<typeof createAgentSession>[0] = {
      cwd: opts.cwd,
      sessionManager: SessionManager.inMemory(),
      // 按权限模式限制 Coder 可用工具集（注意：pi 的 createAgentSession 用 `tools` 字段做白名单）
      // - read-only：永久只读，只暴露 read/grep/ls，write/edit/bash 根本不暴露
      // - plan：暴露全部工具，但未批准前在 tool_start 拦截 write/edit/bash（批准后放行执行）
      //   之所以不在此处用白名单禁用 write/edit/bash，是因为白名单在 session 创建时固化、
      //   无法在批准后动态解锁；改用运行时拦截，批准后即可立即执行。
      // - free：默认全部工具
      ...(permissionMode === "read-only"
        ? { tools: ["read", "grep", "ls"] }
        : permissionMode === "plan"
          ? { tools: ["read", "grep", "ls", "bash", "edit", "write"] }
          : {}),
    };
    const modelSpec = opts.model ?? config.defaultModel;
    if (modelSpec) {
      const model = resolveModel(modelSpec);
      if (model) (createOpts as { model?: unknown }).model = model;
    }

    const { session } = await createAgentSession(createOpts);

    const ctx: BridgeContext = { cwd: opts.cwd };
    const changedFiles = new Set<string>();
    // plan 模式：缓存 coder 当前 turn 的文本输出，turn_end 时提取计划
    let coderTurnText = "";
    const unsubscribe = session.subscribe((e) => {
      const mapped = mapEvent(sessionId, e, ctx, "coder");
      for (const ev of mapped) {
        this.broadcast(ev);
        // 记录 coder 修改过的文件（供 reviewer 聚焦）
        if (ev.type === "file.changed") {
          changedFiles.add(ev.path);
        }
        // plan 模式：累积 coder 的文本输出
        if (permissionMode === "plan" && ev.type === "text_delta" && ev.agent === "coder") {
          coderTurnText += ev.delta;
        }
        // ★ 权限拦截：tool_start 收到时命令/工具已开始，但立即 abort 可尽快终止
        //   命中后广播 permission.blocked，steer 提示 Coder 换方案
        if (ev.type === "tool_start") {
          const ent = this.sessions.get(sessionId);
          // liveMode 用 entry 上的实时值（plan 批准后会降级为 free），否则回退到闭包初始值
          const liveMode = ent?.permissionMode ?? permissionMode;
          // plan 模式且尚未批准：拦截所有写/执行工具，强制只读规划
          if (
            ent && ent.permissionMode === "plan" && ent.planState?.phase !== "approved" &&
            PLAN_BLOCKED_TOOLS.has(ev.toolName)
          ) {
            const blockedCmd = ev.toolName === "bash"
              ? ((ev.args as { command?: string } | undefined)?.command ?? "")
              : JSON.stringify(ev.args ?? {}).slice(0, 120);
            this.broadcast({
              sessionId,
              type: "permission.blocked",
              toolName: ev.toolName,
              command: blockedCmd,
              rule: "plan 模式未批准：禁止修改文件或执行命令",
              mode: "plan",
            });
            entryRef.aborted = true;
            session.abort().catch(() => {});
            session.steer(
              `【计划模式】计划尚未批准，不能使用 ${ev.toolName}。请先输出结构化计划（## 目标 / ## 实现步骤 / ## 涉及文件 / ## 风险与注意事项）等待用户批准。不要重试该工具。`,
            ).catch(() => {});
          } else if (ev.toolName === "bash") {
            // 危险命令拦截：free 模式（含 plan 批准后降级为 free）做高危命令检查
            const cmd = (ev.args as { command?: string } | undefined)?.command ?? "";
            const hit = checkDangerousCommand(cmd, liveMode);
            if (hit) {
              this.broadcast({
                sessionId,
                type: "permission.blocked",
                toolName: "bash",
                command: cmd,
                rule: hit.rule,
                mode: liveMode,
              });
              entryRef.aborted = true;
              session.abort().catch(() => {});
              session.steer(`【系统拦截】你刚才试图执行的命令被权限策略阻止：${hit.rule}。当前模式=${liveMode}。请改用安全方案（如手动删除、改用 read/grep 查看而非 rm）。不要重试该命令。`).catch(() => {});
            }
          }
        }
        // coder 每次 turn 结束，如果 reviewer 存在就触发一次审查
        if (ev.type === "turn_end" && ev.agent === "coder") {
          const snap = [...changedFiles];
          // ★ BUG 修复：之前 changedFiles.clear() 后 entryRef.turnChangedFiles 也空了
          //   （两者是同一 Set 引用），导致 buildCopilotContext 永远拿不到最近变更文件。
          //   修复：先把本轮改的文件快照存到 turnChangedFiles（覆盖上一轮），再 clear。
          if (entryRef) entryRef.turnChangedFiles = new Set(snap);
          changedFiles.clear();
          const ent = this.sessions.get(sessionId);
          // abort 后的 turn_end 不触发 reviewer（代码不完整）
          if (ent?.aborted) {
            ent.aborted = false;
            // ★ BUG 修复：abort 路径也要清空 coderTurnText，否则下一轮 plan 提取会
            //   拼接上一轮被 abort 的半截文本（plan 模式下写工具被拦截 → abort → turn_end 走此分支）
            coderTurnText = "";
          } else if (ent && ent.permissionMode === "plan" && ent.planState?.phase !== "approved") {
            // plan 模式且尚未批准：提取 Coder 输出的计划，广播待批准，不触发 reviewer
            const planText = coderTurnText.trim();
            coderTurnText = "";
            if (planText) {
              ent.planState = { phase: "proposing", plan: planText };
              const summary = extractPlanSummary(planText);
              this.broadcast({ sessionId, type: "plan.proposed", plan: planText, summary });
            }
          } else {
            this.triggerReview(sessionId, snap).catch((err) => {
              this.broadcast({
                sessionId,
                agent: "reviewer",
                type: "error",
                code: "E_REVIEW",
                message: err instanceof Error ? err.message : String(err),
              });
            });
          }
        }
      }
      // flush edit 工具异步读到的文件内容（★ 按 sessionId 过滤，避免跨 session 污染）
      const pending = flushPendingFileReads(sessionId);
      for (const p of pending) {
        const ev: ServerEvent = {
          sessionId: p.sessionId,
          type: "file.changed",
          agent: p.agent,
          path: p.path,
          kind: p.kind,
          content: p.content,
          toolCallId: p.toolCallId,
        };
        this.broadcast(ev);
        if (ev.agent === "coder") changedFiles.add(ev.path);
      }
    });
    // entryRef 让 subscribe 回调能引用到 entry（先建占位，下面 set 后补全）
    const entryRef: SessionEntry = {
      session,
      unsubscribe,
      cwd: opts.cwd,
      aborted: false,
      copilotQueue: [],
      turnChangedFiles: changedFiles,
      permissionMode,
      planState: null,
    };
    this.sessions.set(sessionId, entryRef);

    const modelId = session.model
      ? `${(session.model as { provider?: string }).provider ?? "unknown"}/${(session.model as { id?: string }).id ?? "unknown"}`
      : undefined;

    // 默认开启 reviewer
    const wantReview = opts.review !== false;
    if (wantReview) {
      try {
        await this.startReviewerInternal(sessionId, opts);
      } catch (err) {
        this.broadcast({
          sessionId,
          type: "error",
          code: "E_REVIEWER_START",
          message: `reviewer 启动失败（不影响 coder）：${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // 异步触发首轮 prompt，不阻塞响应
    // plan 模式：注入「先出计划」系统提示，强制 Coder 只规划不执行
    const firstPrompt = permissionMode === "plan"
      ? `【计划模式】你现在处于只读计划模式，只能用 read/grep/glob/ls 探索代码。\n\n请针对以下任务，先输出一份结构化 markdown 计划，包含：\n## 目标\n## 实现步骤（编号列表）\n## 涉及文件\n## 风险与注意事项\n\n输出计划后停止，不要尝试修改任何文件（你的 write/edit/bash 工具已被禁用）。等待用户批准后再执行。\n\n任务：${opts.prompt ?? ""}`
      : opts.prompt;
    if (firstPrompt) {
      session.prompt(firstPrompt).catch((err: unknown) => {
        this.broadcast({
          sessionId,
          type: "error",
          code: "E_PROMPT",
          message: err instanceof Error ? err.message : String(err),
        });
      });
    }

    return { sessionId, model: modelId, reviewer: wantReview, permissionMode };
  }

  get(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId)?.session;
  }

  async steer(sessionId: string, message: string): Promise<void> {
    await this.require(sessionId).steer(message);
  }

  async followUp(sessionId: string, message: string): Promise<void> {
    await this.require(sessionId).followUp(message);
  }

  async abort(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error(`session not found: ${sessionId}`);
    entry.aborted = true;
    await entry.session.abort();
  }

  setPermissionMode(sessionId: string, mode: PermissionMode): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error(`session not found: ${sessionId}`);
    entry.permissionMode = mode;
    this.broadcast({ sessionId, type: "permission.updated", permissionMode: mode });
  }

  async prompt(sessionId: string, message: string, streamingBehavior?: "steer" | "followUp"): Promise<void> {
    const session = this.require(sessionId);
    await session.prompt(message, streamingBehavior ? { streamingBehavior } : undefined);
  }

  /** 启动 reviewer 子 agent（同一 session 下独立 pi session） */
  private async startReviewerInternal(sessionId: string, opts: StartOptions): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error(`session not found: ${sessionId}`);
    if (entry.reviewer) return; // 幂等

    const createOpts: Parameters<typeof createAgentSession>[0] = {
      cwd: opts.cwd,
      sessionManager: SessionManager.inMemory(),
      // ★ Reviewer 必须只读：工具白名单只暴露 read/grep/ls/glob，
      //   根本不暴露 write/edit/bash，从工具层杜绝 Reviewer 改文件。
      //   之前没传 tools = Reviewer 拿到全部工具，只靠 prompt 约束，违背"只读审查"设计。
      tools: ["read", "grep", "ls", "glob"],
    };
    const modelSpec = opts.model ?? config.defaultModel;
    if (modelSpec) {
      const model = resolveModel(modelSpec);
      if (model) (createOpts as { model?: unknown }).model = model;
    }
    const { session: reviewerSession } = await createAgentSession(createOpts);

    const ctx: BridgeContext = { cwd: opts.cwd };
    const reviewerUnsub = reviewerSession.subscribe((e) => {
      const mapped = mapEvent(sessionId, e, ctx, "reviewer");
      for (const ev of mapped) this.broadcast(ev);
      // ★ 按 sessionId 过滤，避免跨 session 污染
      const pending = flushPendingFileReads(sessionId);
      for (const p of pending) {
        this.broadcast({
          sessionId: p.sessionId,
          type: "file.changed",
          agent: p.agent,
          path: p.path,
          kind: p.kind,
          content: p.content,
          toolCallId: p.toolCallId,
        });
      }
    });
    entry.reviewer = {
      session: reviewerSession,
      unsubscribe: reviewerUnsub,
      busy: false,
    };
  }

  /**
   * 触发一次 reviewer 审查（入队 Copilot 队列）。
   */
  private async triggerReview(sessionId: string, changedFiles: string[]): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry || !entry.reviewer) return;
    const filesToReview = changedFiles.filter(
      (p) => /\.(js|ts|jsx|tsx|html|css|json|md|py|sh|sql)$/i.test(p),
    );
    if (filesToReview.length === 0) return;
    // 审查任务入队（优先级低于 chat，chat 会插队到前面）
    entry.copilotQueue.push({ type: "review", files: filesToReview });
    this.emitCopilotStatus(sessionId);
    this.drainCopilotQueue(sessionId).catch((err) => {
      this.broadcast({
        sessionId,
        agent: "reviewer",
        type: "error",
        code: "E_REVIEW",
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // ===== Copilot 队列管理 =====

  /** 广播 Copilot 当前状态 */
  private emitCopilotStatus(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry || !entry.reviewer) return;
    const busy = entry.reviewer.busy;
    const queueLen = entry.copilotQueue.length;
    if (busy) {
      const next = entry.copilotQueue[0];
      this.broadcast({
        sessionId,
        type: "copilot.status",
        status: next?.type === "chat" ? "chatting" : "reviewing",
        queuePosition: 0,
        currentTask: next?.type === "review"
          ? `正在审查 ${(next.files || []).join(", ")}`
          : "正在回答你的问题",
        queueLength: Math.max(0, queueLen - 1),
      });
    } else if (queueLen > 0) {
      this.broadcast({
        sessionId,
        type: "copilot.status",
        status: "queued",
        queuePosition: queueLen,
        currentTask: undefined,
        queueLength: queueLen,
      });
    } else {
      this.broadcast({
        sessionId,
        type: "copilot.status",
        status: "idle",
        queuePosition: 0,
        queueLength: 0,
      });
    }
  }

  /** 依次处理队列中的任务 */
  private async drainCopilotQueue(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry || !entry.reviewer) return;
    if (entry.reviewer.busy) return;
    while (entry.copilotQueue.length > 0) {
      const task = entry.copilotQueue.shift()!;
      entry.reviewer.busy = true;
      this.emitCopilotStatus(sessionId);
      try {
        if (task.type === "review") {
          await this.executeReview(sessionId, task.files || []);
        } else {
          await this.executeChat(sessionId, task.message || "");
        }
      } catch (err) {
        this.broadcast({
          sessionId,
          agent: "reviewer",
          type: "error",
          code: "E_COPILOT",
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        // ★ BUG 修复：dispose 期间 entry.reviewer 可能被置为 undefined，
        //   此时访问 .busy 会抛 TypeError 并掩盖真实异常。
        //   重新取 entry 并检查 reviewer 是否还存在。
        const ent2 = this.sessions.get(sessionId);
        if (ent2?.reviewer) {
          ent2.reviewer.busy = false;
          this.emitCopilotStatus(sessionId);
        }
      }
    }
  }

  /**
   * 事件驱动收集 reviewer 输出（B6/B7/B23 修复）。
   * 返回：
   *   - raw(): 取当前累积的文本
   *   - cancel(): 等待 agent_end 或超时，返回后已 unsubscribe，无 timer 泄漏
   * 用法：
   *   const c = this.collectReviewerOutput(sessionId);
   *   await reviewer.session.prompt(...);
   *   await c.cancel();       // 等到结束 / 超时
   *   const out = c.raw();
   */
  private collectReviewerOutput(sessionId: string): {
    raw: () => string;
    cancel: () => Promise<void>;
  } {
    const entry = this.sessions.get(sessionId);
    if (!entry?.reviewer) {
      return { raw: () => "", cancel: async () => {} };
    }
    let buf = "";
    let resolveFn: (() => void) | null = null;
    const unsub = entry.reviewer.session.subscribe((e) => {
      if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") {
        buf += e.assistantMessageEvent.delta;
      }
      if (e.type === "agent_end") {
        if (resolveFn) { const r = resolveFn; resolveFn = null; r(); }
      }
    });
    // 60s 超时兜底（之前是 120s，过长；reviewer 正常几秒就完事）
    let timer: NodeJS.Timeout | null = setTimeout(() => {
      if (resolveFn) { const r = resolveFn; resolveFn = null; r(); }
      // ★ BUG 修复：超时后 reviewer 底层 prompt 仍在运行，下一轮 prompt 会与之重叠，
      //   导致输出串台（新 collector 订阅到上一轮延迟的 text_delta）。
      //   超时后主动 abort，确保 reviewer 真正停止再进入下一任务。
      const ent = this.sessions.get(sessionId);
      ent?.reviewer?.session.abort().catch(() => {});
    }, 60000);
    const donePromise = new Promise<void>((resolve) => { resolveFn = resolve; });
    return {
      raw: () => buf,
      cancel: async () => {
        try { await donePromise; } finally {
          unsub();
          if (timer) { clearTimeout(timer); timer = null; }
        }
      },
    };
  }

  /** 执行一次代码审查 */
  private async executeReview(sessionId: string, filesToReview: string[]): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry?.reviewer) return;
    const prompt = [
      "你是代码审查员（Reviewer）。你的同事（Coder）刚刚修改了这些文件：",
      filesToReview.map((p) => "  - " + p).join("\n"),
      "",
      "请审查以下内容（使用 view_file 工具逐个阅读文件内容）：",
      "  1. 代码是否存在明显 bug（语法错、漏判空、边界错误）；",
      "  2. 是否有安全隐患（XSS、SQL注入、路径穿越、硬编码密钥等）；",
      "  3. 是否严重违背初始需求。",
      "",
      "审查完毕后，只输出下面格式（不要写多余内容）：",
      "SEVERE=YES  （或 SEVERE=NO）",
      "SUMMARY=<简短中文意见，1~3 句>",
      "FILES=<审查过的文件名，逗号分隔>",
      "",
      "注意：只有发现严重 bug / 安全问题 / 明显不满足需求 才写 SEVERE=YES，否则一律 NO。",
      "不要使用 write_file/edit_file/bash 等修改工具，只能用只读 view 类工具。",
    ].join("\n");
    // ★ 事件驱动收集 reviewer 输出，避免轮询（B6/B7/B23）
    const { raw, cancel } = this.collectReviewerOutput(sessionId);
    try {
      await entry.reviewer.session.prompt(prompt);
    } catch {
      // reviewer prompt 出错继续解析已收到的内容
    }
    await cancel();
    const out = raw();

    const severeLine = /SEVERE\s*=\s*(YES|NO)/i.exec(out);
    const summaryLine = /SUMMARY\s*=\s*(.+)/i.exec(out);
    const filesLine = /FILES\s*=\s*(.+)/i.exec(out);
    const severe = severeLine ? severeLine[1].toUpperCase() === "YES" : false;
    const summary = summaryLine ? summaryLine[1].trim() : (out.slice(0, 200).trim() || "无审查输出");
    const reviewed = filesLine
      ? filesLine[1].split(/[,，]/).map((s) => s.trim()).filter(Boolean)
      : filesToReview;

    this.broadcast({ sessionId, type: "review.finished", summary, severe, reviewed });

    if (severe) {
      const fmsg = [
        "【代码审查发现严重问题，需要你立即修改】",
        "审查意见：" + summary,
        "涉及文件：" + reviewed.join(", "),
        "",
        "请阅读相关文件并修复上述严重问题，修复后正常回复。",
      ].join("\n");
      try {
        // ★ 与 copilotApply/planApprove 同理：Coder 在 turn_end 后已空闲，
        //   followUp 只在 Agent 运行中排队（pi 文档：followUp = "Queue a follow-up
        //   message to be processed after the agent finishes"），空闲时调用不会
        //   触发新 turn，严重 bug 永远不会被自动修复。
        //   修复：用 wakeCoder 自适应——运行中用 followUp 排队（不打断当前 turn），
        //   空闲时用 prompt 主动触发新 turn 开始修复。
        //   注意：这里不能用 steer，steer 会在当前 turn 工具调用后立即注入，
        //   可能打断 Coder 正在做的连续操作；followUp 等当前完全结束更安全。
        const isRunning = !!(entry.session.agent.state as { streamingMessage?: unknown }).streamingMessage;
        let actualMode: "steer" | "prompt";
        if (isRunning) {
          await entry.session.followUp(fmsg);
          actualMode = "steer";
        } else {
          await entry.session.prompt(fmsg);
          actualMode = "prompt";
        }
        // ★ BUG 修复：之前自动注入严重修复时没有任何可见事件广播，用户看到 🚨 严重
        //   review 后界面毫无反馈，误以为"没自动修复"。复用 copilot.applied 事件，
        //   前端会显示"✅ Copilot 指令已注入 Coder（prompt/steer）: ..."，让用户
        //   明确看到自动修复已触发。
        this.broadcast({
          sessionId,
          type: "copilot.applied",
          instruction: fmsg,
          mode: actualMode,
        });
      } catch (err) {
        this.broadcast({
          sessionId,
          agent: "coder",
          type: "error",
          code: "E_FOLLOWUP",
          message: `自动修复注入失败：${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  /** 执行一次 Copilot 对话 */
  private async executeChat(sessionId: string, userMessage: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry?.reviewer) return;

    // 构建上下文：文件列表 + 最近变更文件内容，避免 Copilot 只能靠 view_file 自己猜
    const context = await this.buildCopilotContext(sessionId);

    const prompt = [
      "你是 AI Cowork 的副驾驶（Copilot），和主程序员（Coder）一起工作。",
      "你和 Coder 共享同一个工作目录，你可以用 view_file 工具查看文件内容。",
      "",
      "用户是你的同事，他可能问你以下类型的问题：",
      "1. 进度查询：「写到哪了？」→ 参考下方【当前项目快照】如实汇报，必要时再 view_file",
      "2. 代码审查：「这段代码有问题吗？」→ 你审查代码并报告问题",
      "3. 概念解释：「flexbox 怎么用？」→ 你直接解释，不需要工具",
      "4. 修改建议：「把按钮改成蓝色」→ 你给出方案，用户确认后你会注入 Coder",
      "5. 实现思路：「这个功能怎么实现？」→ 你给出思路建议",
      "",
      "回答要求：",
      "- 简洁、直接，用中文回答",
      "- 下方【当前项目快照】已是最新代码，能直接答就别再 view_file；需要看其它文件再用工具",
      "- 如果是修改建议或实现方案，在回复末尾加一行：",
      '  [APPLY: <给 Coder 的清晰指令>]',
      "  用户点「让 Coder 执行」时，这个指令会被注入 Coder",
      "- 不要自己修改文件，只能用 view_file 查看",
      "- 不要使用 write_file/edit_file/bash 等修改工具",
      "",
      context,
    ].join("\n");

    let raw = "";
    // ★ 事件驱动收集 reviewer 输出，避免轮询（B6/B7/B23）
    const collector = this.collectReviewerOutput(sessionId);
    raw = "";
    try {
      await entry.reviewer.session.prompt(`${prompt}\n\n用户问题：${userMessage}`);
    } catch {
      // 出错继续解析已收到的内容
    }
    await collector.cancel();
    raw = collector.raw();

    // 提取 [APPLY:] 指令
    const applyMatch = /\[APPLY:\s*(.+?)\]/i.exec(raw);
    const applyInstruction = applyMatch ? applyMatch[1].trim() : undefined;
    // 去掉 [APPLY:] 行作为显示文本
    const displayText = raw.replace(/\[APPLY:\s*.+?\]/gi, "").trim() || raw.trim();

    this.broadcast({
      sessionId,
      type: "copilot.reply",
      message: {
        id: randomUUID(),
        role: "copilot",
        text: displayText,
        applyInstruction,
        ts: Date.now(),
      },
    });
  }

  /**
   * 构建 Copilot 上下文快照：当前文件列表 + 最近变更文件内容。
   * 控制 token 量：最近变更文件最多 3 个、每个截断 4000 字符；文件列表截断 50 项。
   */
  private async buildCopilotContext(sessionId: string): Promise<string> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return "";
    const lines: string[] = ["【当前项目快照】"];

    // 1. 文件列表
    try {
      const files: FileEntry[] = [];
      await walk(entry.cwd, entry.cwd, files, 0);
      const fileItems = files
        .filter((f) => f.type === "file")
        .slice(0, 50)
        .map((f) => `  - ${f.path}`);
      if (fileItems.length > 0) {
        lines.push("文件列表:");
        lines.push(...fileItems);
        if (files.length > 50) lines.push(`  (共 ${files.length} 项，已截断展示前 50)`);
      } else {
        lines.push("文件列表: (空目录，Coder 还没写文件)");
      }
    } catch {
      lines.push("文件列表: (读取失败)");
    }

    // 2. 最近变更文件内容（turnChangedFiles 是相对路径 Set）
    const recent = [...entry.turnChangedFiles].slice(-3).reverse();
    if (recent.length > 0) {
      lines.push("");
      lines.push("最近变更的文件（Coder 上次 turn 改动过的）:");
      for (const relPath of recent) {
        try {
          const abs = pathResolve(entry.cwd, relPath);
          let content = await readFile(abs, "utf-8");
          const truncated = content.length > 4000;
          if (truncated) content = content.slice(0, 4000);
          lines.push(`--- ${relPath} ${truncated ? "(截断，仅前 4000 字符)" : ""} ---`);
          lines.push(content);
          if (truncated) lines.push(`--- ${relPath} 截断结束 ---`);
        } catch {
          lines.push(`--- ${relPath} (读取失败) ---`);
        }
      }
    } else {
      lines.push("");
      lines.push("最近变更的文件: (Coder 尚未修改任何文件)");
    }

    lines.push("【项目快照结束】");
    return lines.join("\n");
  }

  /** 用户向 Copilot 发消息（入队，chat 优先于 review） */
  async copilotChat(sessionId: string, message: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry?.reviewer) {
      throw new Error("Copilot 未启动");
    }
    // chat 任务插队到所有 review 前面（但不动正在处理的任务）
    const firstReviewIdx = entry.copilotQueue.findIndex((t) => t.type === "review");
    const chatTask: CopilotTask = { type: "chat", message };
    if (firstReviewIdx >= 0) {
      entry.copilotQueue.splice(firstReviewIdx, 0, chatTask);
    } else {
      entry.copilotQueue.push(chatTask);
    }
    this.emitCopilotStatus(sessionId);
    this.drainCopilotQueue(sessionId).catch((err) => {
      this.broadcast({
        sessionId,
        agent: "reviewer",
        type: "error",
        code: "E_COPILOT_CHAT",
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * 将 Copilot 的指令注入 Coder。
   *
   * ★ 关键修复：之前无条件用 steer，但 steer 只在 Agent 运行中才生效
   *   （pi 文档：steer = "Queue a steering message while the agent is running"）。
   *   如果 Coder 当前空闲，steer 的消息会永远卡在队列里，Coder 不会主动醒来处理。
   *   修复：检测 Coder 是否空闲（agent.state.streamingMessage 为空 = 空闲），
   *   空闲时改用 prompt 主动触发新 turn，运行中才用 steer 插队。
   */
  async copilotApply(sessionId: string, instruction: string, mode?: "steer" | "prompt"): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error(`session not found: ${sessionId}`);

    // 实际使用的注入方式（用于事件上报，避免上报与实际行为不符）
    let actualMode: "steer" | "prompt";
    if (mode === "prompt") {
      // 用户显式指定用 prompt
      await entry.session.prompt(instruction);
      actualMode = "prompt";
    } else if (mode === "steer") {
      // 用户显式指定用 steer（注意：Coder 空闲时 steer 不会触发新 turn，但尊重用户选择）
      await entry.session.steer(instruction);
      actualMode = "steer";
    } else {
      // 自动判断：Coder 运行中用 steer 插队，空闲用 prompt 触发新 turn
      const isRunning = !!(entry.session.agent.state as { streamingMessage?: unknown }).streamingMessage;
      if (isRunning) {
        await entry.session.steer(instruction);
        actualMode = "steer";
      } else {
        await entry.session.prompt(instruction);
        actualMode = "prompt";
      }
    }
    this.broadcast({
      sessionId,
      type: "copilot.applied",
      instruction,
      mode: actualMode,
    });
  }

  /** plan 模式：处理用户对计划的决定 */
  async planApprove(
    sessionId: string,
    decision: "approved" | "rejected" | "iterate",
    feedback?: string,
  ): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error(`session not found: ${sessionId}`);
    if (entry.permissionMode !== "plan") throw new Error("当前不是 plan 模式");
    if (entry.planState?.phase !== "proposing") throw new Error("没有待批准的计划");

    this.broadcast({ sessionId, type: "plan.decision", decision, feedback });

    if (decision === "approved") {
      // 批准后降级为 free：plan 模式的写工具拦截在 tool_start 里靠
      // `permissionMode === "plan" && phase !== "approved"` 判断，降级后即放行；
      // 同时 free 模式启用危险命令拦截。Coder 的 tools 白名单创建时已含
      // read/grep/ls/bash/edit/write，无需重建 session 即可执行。
      entry.planState = { phase: "approved", plan: entry.planState.plan };
      entry.permissionMode = "free"; // 降级为 free，放行写工具 + 启用危险命令拦截
      await entry.session.prompt(
        `【计划已批准】用户批准了你刚才的计划。现在请直接开始执行计划中的步骤，可以使用 write/edit/bash 等所有工具。不要再询问，直接做。\n\n计划回顾：\n${entry.planState.plan}`,
      );
    } else if (decision === "rejected") {
      entry.planState = null;
      // ★ 与 copilotApply 同理：plan 模式下 Coder 输出计划后 turn 已结束、Coder 空闲，
      //   steer 不会唤醒空闲 Coder（pi 文档：steer = "Queue a steering message while the agent is running"）。
      //   之前用 steer → 用户点"拒绝"后 Coder 完全无响应。修复：空闲时改用 prompt 触发新 turn。
      await this.wakeCoder(sessionId, "【计划被拒绝】用户拒绝了你的计划。请重新理解需求，输出一份新的计划。仍然只能只读探索，不要尝试修改文件。");
    } else {
      // iterate：要求修改
      const fb = feedback || "请调整计划";
      entry.planState = null;
      // ★ 同上：Coder 空闲时用 prompt 而非 steer
      await this.wakeCoder(sessionId, `【计划需修改】用户要求调整计划，反馈如下：${fb}\n请基于反馈输出修改后的新计划。仍然只读，不要修改文件。`);
    }
  }

  /**
   * 唤醒 Coder：运行中用 steer 插队，空闲用 prompt 触发新 turn。
   * ★ 与 copilotApply 的自动判断逻辑一致，提取为复用方法。
   *   steer 只在 Agent 运行中才生效，空闲时 steer 的消息会卡在队列里，
   *   Coder 不会主动醒来处理。空闲时必须用 prompt 主动触发新 turn。
   */
  private async wakeCoder(sessionId: string, message: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error(`session not found: ${sessionId}`);
    const isRunning = !!(entry.session.agent.state as { streamingMessage?: unknown }).streamingMessage;
    if (isRunning) {
      await entry.session.steer(message);
    } else {
      await entry.session.prompt(message);
    }
  }

  // ===== checkpoint =====
  async createCheckpoint(sessionId: string, label?: string): Promise<CheckpointInfo> {
    return CP.createCheckpoint(this.cwdOf(sessionId), label);
  }

  async listCheckpoints(sessionId: string): Promise<CheckpointInfo[]> {
    return CP.listCheckpoints(this.cwdOf(sessionId));
  }

  async rollbackCheckpoint(sessionId: string, checkpointId: string): Promise<void> {
    await CP.rollbackCheckpoint(this.cwdOf(sessionId), checkpointId);
  }

  // ===== preview =====
  async startPreview(sessionId: string, entry?: string): Promise<PreviewInfo> {
    const cwd = this.cwdOf(sessionId);
    const info = await PV.startPreview(sessionId, cwd, entry);
    return { sessionId, ...info };
  }

  async stopPreview(sessionId: string): Promise<void> {
    await PV.stopPreview(sessionId);
  }

  getPreviewPort(sessionId: string): number | undefined {
    return PV.getPreview(sessionId)?.port;
  }

  dispose(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    // ★ BUG 修复：dispose 时若 preview 在运行，必须广播 preview.stopped，
    //   否则前端面板一直显示"预览运行中"而实际 server 已关闭，
    //   server.ts 的 clearPreviewTimer 也依赖该事件清理 debounce timer。
    if (PV.getPreview(sessionId)) {
      PV.stopPreview(sessionId).catch(() => {});
      this.broadcast({ sessionId, type: "preview.stopped" });
    }
    // ★ 释放 Reviewer session（之前漏了，会导致 session 泄漏：pi 内部状态 + 订阅 + 可能的 socket）
    if (entry.reviewer) {
      entry.reviewer.unsubscribe();
      entry.reviewer.session.dispose();
      entry.reviewer = undefined;
    }
    entry.unsubscribe();
    entry.session.dispose();
    this.sessions.delete(sessionId);
  }

  disposeAll(): void {
    // dispose 内部已对每个 session 调 PV.stopPreview，这里不再重复 stopAllPreviews
    for (const id of [...this.sessions.keys()]) this.dispose(id);
  }

  private require(sessionId: string): AgentSession {
    const s = this.get(sessionId);
    if (!s) throw new Error(`session not found: ${sessionId}`);
    return s;
  }

  /** 列出 session cwd 下的文件树（过滤 node_modules/.git 等噪音，深度限制 8） */
  async listFiles(sessionId: string): Promise<FileEntry[]> {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error(`session not found: ${sessionId}`);
    const result: FileEntry[] = [];
    await walk(entry.cwd, entry.cwd, result, 0);
    return result;
  }

  /** 读取 session cwd 下某文件内容 */
  async readFile(sessionId: string, path: string): Promise<string> {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error(`session not found: ${sessionId}`);
    const abs = pathResolve(entry.cwd, path);
    // 防止路径穿越（仅对前端 file.read API 有效）
    // 注意：Coder/Reviewer Agent 通过 pi-coding-agent 的 read/write/edit 工具直接操作文件，
    //       那一层的 cwd 校验由 pi 内部负责，本方法管不到。如需对 Agent 也强制路径限制，
    //       需在 tool_start 事件里拦截并检查 args.path，目前未实现，依赖 pi 的 cwd 沙箱。
    const rel = relative(entry.cwd, abs);
    if (rel.startsWith("..")) throw new Error(`path outside cwd: ${path}`);
    return readFile(abs, "utf-8");
  }

  /** session 的 cwd */
  cwdOf(sessionId: string): string {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error(`session not found: ${sessionId}`);
    return entry.cwd;
  }
}

const NOISE_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", ".cache"]);
const MAX_DEPTH = 8;

async function walk(root: string, dir: string, out: FileEntry[], depth: number): Promise<void> {
  if (depth > MAX_DEPTH) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const name = e.name.toString();
    if (NOISE_DIRS.has(name)) continue;
    // ★ 符号链接保护（B25）：跳过 symlink，避免循环链接（如 ln -s . self）导致无限递归栈溢出
    if (e.isSymbolicLink()) continue;
    const abs = join(dir, name);
    const rel = relative(root, abs);
    if (e.isDirectory()) {
      out.push({ path: rel, name, type: "dir" });
      await walk(root, abs, out, depth + 1);
    } else if (e.isFile()) {
      let size: number | undefined;
      try {
        size = (await stat(abs)).size;
      } catch {
        // 忽略
      }
      out.push({ path: rel, name, type: "file", size });
    }
  }
}

/**
 * 把 "provider/model" 形式的 spec 解析成 pi-ai 的 Model。
 * - 内置 provider (anthropic/openai/google/...) 直接用 getModel
 * - deepseek: pi-ai 0.73.1 虽有 KnownProvider 但未预置 model，手动构造 OpenAI 兼容 Model
 * - 其他 OpenAI 兼容服务: 按 deepseek 同样的方式扩展
 */
function resolveModel(spec: string): Model<"openai-completions"> | undefined {
  const slash = spec.indexOf("/");
  if (slash <= 0) return undefined;
  const provider = spec.slice(0, slash);
  const id = spec.slice(slash + 1);

  // deepseek 手动构造（OpenAI 兼容协议）。pi-ai 0.73.1 的 deepseek provider 未预置 model。
  if (provider === "deepseek") {
    if (!config.deepseekKey) return undefined;
    return makeOpenAICompatModel({
      provider: "deepseek",
      id,
      name: id,
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: config.deepseekKey,
      contextWindow: 64000,
      maxTokens: 8192,
    });
  }

  // openai: 支持自定义 baseURL（如第三方兼容服务）
  if (provider === "openai") {
    if (!config.openaiKey) return undefined;
    if (!id) return undefined;
    if (config.openaiBaseUrl) {
      // 校验 URL 格式有效性
      try {
        new URL(config.openaiBaseUrl);
      } catch {
        console.warn(`[config] Invalid OPENAI_BASE_URL format: ${config.openaiBaseUrl}, falling back to official API`);
        const m = getModel("openai" as any, id as any);
        return m ? (m as unknown as Model<"openai-completions">) : undefined;
      }
      return makeOpenAICompatModel({
        provider: "openai",
        id,
        name: id,
        baseUrl: config.openaiBaseUrl,
        apiKey: config.openaiKey,
        contextWindow: 128000,
        maxTokens: 16384,
      });
    }
    // 默认走官方 API
    const m = getModel("openai" as any, id as any);
    return m ? (m as unknown as Model<"openai-completions">) : undefined;
  }

  // 内置 provider 走 getModel（anthropic/google/openrouter/...），cast 成 openai-completions 仅用于类型通过
  const builtins = ["anthropic", "google", "groq", "cerebras", "xai", "zai", "mistral", "github-copilot", "openrouter"];
  if (builtins.includes(provider)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = getModel(provider as any, id as any);
    return m ? (m as unknown as Model<"openai-completions">) : undefined;
  }

  return undefined;
}

/** 构造一个走 openai-completions api 的自定义 Model。 */
function makeOpenAICompatModel(opts: {
  provider: string;
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  contextWindow: number;
  maxTokens: number;
}): Model<"openai-completions"> {
  return {
    id: opts.id,
    name: opts.name,
    api: "openai-completions",
    provider: opts.provider,
    baseUrl: opts.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: opts.contextWindow,
    maxTokens: opts.maxTokens,
    headers: { Authorization: `Bearer ${opts.apiKey}` },
  };
}

/**
 * 危险命令检测：开源安全防护，防止 AI 被诱导执行破坏性命令。
 * - free 模式（含 plan 批准后降级为 free）：只拦高危（rm -rf / sudo / git push --force / mkfs / dd 写设备 等）
 * - read-only 模式：bash 根本不暴露（tools 白名单），不会走到这
 * - plan 模式未批准：bash/edit/write 在 tool_start 被 PLAN_BLOCKED_TOOLS 拦截，不会走到这
 *
 * 返回命中的规则名（供 UI 展示），未命中返回 null。
 * 注意：正则做"宽松匹配"防绕过（如 rm -rf / r'm' -rf / rm -r -f）。
 */
/** plan 模式未批准时拦截的工具名（写操作 + 命令执行），强制 Coder 只读规划 */
const PLAN_BLOCKED_TOOLS = new Set([
  "bash", "run_command",
  "edit", "write", "write_file", "edit_file", "delete_file",
]);
const DANGEROUS_RULES: Array<{ rule: string; re: RegExp }> = [
  // 递归强删
  { rule: "rm -rf", re: /\brm\s+(-[a-z]*r[a-z]*f?|--recursive\s+(--force|-\w*f)|-[a-z]*f[a-z]*r)\s/i },
  { rule: "rm 根目录", re: /(^|[\s;&|`(])rm\s+(-\w*\s+)*\/(\s|$)/ }, // rm -rf /
  // 提权：sudo/su/mkfs/npm publish/docker 必须在命令首位（^\s*），避免 echo sudo 误中
  { rule: "sudo", re: /^\s*sudo(\s|$)/ },
  { rule: "su 提权", re: /^\s*su\s+/ },
  { rule: "chmod 777", re: /^\s*chmod\s+(-\w+\s+)*777\b/ },
  { rule: "mkfs", re: /^\s*mkfs\b/ },
  { rule: "dd 写设备", re: /^\s*dd\s+.*\bof=\/dev\//i },
  // git 破坏历史
  { rule: "git push --force", re: /\bgit\s+push\s+(-\w*f|--force)/ },
  { rule: "git reset --hard", re: /\bgit\s+reset\s+--hard\b/ },
  // 远程脚本执行
  { rule: "curl|sh 管道执行", re: /\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh)\b/i },
  // 全局安装（可能装恶意包）
  { rule: "npm 全局安装", re: /\bnpm\s+(i|install|add)\s+(-g|--global)\b/ },
  { rule: "pip 全局安装", re: /\bpip\s+install\s+(-\w*g\w*|--global)\b/ },
  // 发布：必须命令首位
  { rule: "npm publish", re: /^\s*npm\s+publish\b/ },
  // 写入启动配置（持久化后门）
  { rule: "写 .bashrc/.profile", re: />>?\s*(~?\/?\.(bashrc|bash_profile|profile|zshrc))\b/ },
  // 读密钥：cat 在命令首位
  { rule: "读取 SSH 密钥", re: /^\s*cat\s+~?\/?\.ssh\// },
  // 容器清理：docker 在命令首位
  { rule: "docker system prune", re: /^\s*docker\s+system\s+prune\b/ },
  { rule: "docker rm 容器", re: /^\s*docker\s+rm\s+/ },
];

export function checkDangerousCommand(
  command: string,
  mode: PermissionMode,
): { rule: string } | null {
  // 只在 free 模式做高危命令拦截：
  // - read-only：bash 不暴露，不会走到这
  // - plan 未批准：bash/edit/write 在 tool_start 被 PLAN_BLOCKED_TOOLS 拦截，不会走到这
  // - plan 已批准：调用方传入的 mode 已降级为 free，正常检查
  if (mode !== "free") return null;
  for (const r of DANGEROUS_RULES) {
    if (r.re.test(command)) return { rule: r.rule };
  }
  return null;
}

/** 从计划 markdown 提取摘要：首个 # 标题 + 首段非标题文本（截断 120 字） */
export function extractPlanSummary(plan: string): string {
  const lines = plan.split("\n").map((l) => l.trim()).filter(Boolean);
  let title = "";
  let firstPara = "";
  for (const l of lines) {
    if (l.startsWith("#")) {
      if (!title) title = l.replace(/^#+\s*/, "");
    } else if (!firstPara) {
      // 走到这里 l 必然不以 # 开头（上面 if 已处理），不再重复判断
      firstPara = l;
    }
    if (title && firstPara) break;
  }
  const summary = title && firstPara ? `${title} — ${firstPara}` : title || firstPara || plan.slice(0, 120);
  return summary.length > 120 ? summary.slice(0, 117) + "..." : summary;
}
