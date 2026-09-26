/**
 * 双端共享的命令与事件 schema。
 * 前端发 ClientCommand，后端回 CommandResponse；后端推 ServerEvent，前端按 type 渲染。
 * 事件层做了一层映射，屏蔽 pi-coding-agent 内部结构（assistantMessageEvent 等），前端只看扁平事件。
 */
import { z } from "zod";

// ===== 命令（前端 → 后端）=====

const base = z.object({ id: z.string() });

/** 权限模式：free=全开 / read-only=只读+白名单bash / plan=只读须先出计划 */
export const PermissionMode = z.enum(["free", "read-only", "plan"]);
export type PermissionMode = z.infer<typeof PermissionMode>;

/** 动态切换会话的权限模式 */
export const PermissionUpdateCommand = base.extend({
  type: z.literal("permission.update"),
  sessionId: z.string(),
  permissionMode: PermissionMode,
});
export type PermissionUpdateCommand = z.infer<typeof PermissionUpdateCommand>;

export const StartSessionCommand = base.extend({
  type: z.literal("session.start"),
  cwd: z.string(),
  /** 初始任务（可选，不传则等待用户在 InputBar 输入） */
  prompt: z.string().optional(),
  /** 形如 "deepseek/deepseek-chat" / "anthropic/claude-sonnet-4-5"；省略则用默认 model */
  model: z.string().optional(),
  /** 是否同时启动独立的 Reviewer Agent（结对编程）。默认 true：主 Agent 每个 turn 结束后 Reviewer 独立审查，发现严重问题以 follow_up 注入主 Agent */
  review: z.boolean().optional(),
  /** 权限模式：free=全开(默认) / read-only=只读+白名单bash / plan=只读且须先出计划。开源安全防护。 */
  permissionMode: PermissionMode.optional(),
});

export const SteerCommand = base.extend({
  type: z.literal("steer"),
  sessionId: z.string(),
  message: z.string(),
});

export const FollowUpCommand = base.extend({
  type: z.literal("follow_up"),
  sessionId: z.string(),
  message: z.string(),
});

export const AbortCommand = base.extend({
  type: z.literal("abort"),
  sessionId: z.string(),
});

export const PromptCommand = base.extend({
  type: z.literal("prompt"),
  sessionId: z.string(),
  message: z.string(),
  /** 流式中发送时如何入队；非流式可省略 */
  streamingBehavior: z.enum(["steer", "followUp"]).optional(),
});

/** 列出 cwd 下文件树（前端启动 session 后拉取初始结构） */
export const FileListCommand = base.extend({
  type: z.literal("file.list"),
  sessionId: z.string(),
});

/** 读取某个文件内容（前端点文件树切换时拉取） */
export const FileReadCommand = base.extend({
  type: z.literal("file.read"),
  sessionId: z.string(),
  path: z.string(),
});

/** 创建工作区快照（当前 cwd 全量 cp 到 .aicowork/checkpoints/<id>） */
export const CheckpointCreateCommand = base.extend({
  type: z.literal("checkpoint.create"),
  sessionId: z.string(),
  /** 可选描述，比如"写了 landing page 之前" */
  label: z.string().optional(),
});

/** 列出某 session 的所有 checkpoint */
export const CheckpointListCommand = base.extend({
  type: z.literal("checkpoint.list"),
  sessionId: z.string(),
});

/** 回滚到某个 checkpoint：清空 cwd 用户内容，把快照 cp 回来 */
export const CheckpointRollbackCommand = base.extend({
  type: z.literal("checkpoint.rollback"),
  sessionId: z.string(),
  checkpointId: z.string(),
});

/** 启动静态预览服务器（指向 session cwd 的静态文件） */
export const PreviewStartCommand = base.extend({
  type: z.literal("preview.start"),
  sessionId: z.string(),
  /** 可选指定入口文件（相对 cwd），如 "index.html"、"dist/index.html"。前端默认拼根路径 / */
  entry: z.string().optional(),
});

/** 停止静态预览服务器 */
export const PreviewStopCommand = base.extend({
  type: z.literal("preview.stop"),
  sessionId: z.string(),
});

/** 向 Copilot 发送对话消息（提问/要求/审查请求） */
export const CopilotChatCommand = base.extend({
  type: z.literal("copilot.chat"),
  sessionId: z.string(),
  message: z.string(),
});

/** 将 Copilot 回复中的 [APPLY:] 指令注入 Coder */
export const CopilotApplyCommand = base.extend({
  type: z.literal("copilot.apply"),
  sessionId: z.string(),
  /** Copilot 生成的给 Coder 的指令 */
  instruction: z.string(),
  /** 注入方式：steer（运行中注入）或 prompt（空闲时触发新 turn） */
  mode: z.enum(["steer", "prompt"]).optional(),
});

/** 批准/拒绝 Coder 在 plan 模式下提出的计划 */
export const PlanApproveCommand = base.extend({
  type: z.literal("plan.approve"),
  sessionId: z.string(),
  /** approved=批准执行 / rejected=拒绝让 Coder 重新规划 / iterate=要求修改（带反馈） */
  decision: z.enum(["approved", "rejected", "iterate"]),
  /** iterate 时的修改反馈（可选） */
  feedback: z.string().optional(),
});

export const ClientCommand = z.discriminatedUnion("type", [
  StartSessionCommand,
  PermissionUpdateCommand,
  SteerCommand,
  FollowUpCommand,
  AbortCommand,
  PromptCommand,
  FileListCommand,
  FileReadCommand,
  CheckpointCreateCommand,
  CheckpointListCommand,
  CheckpointRollbackCommand,
  PreviewStartCommand,
  PreviewStopCommand,
  CopilotChatCommand,
  CopilotApplyCommand,
  PlanApproveCommand,
]);

export type ClientCommand = z.infer<typeof ClientCommand>;
export type StartSessionCommand = z.infer<typeof StartSessionCommand>;
export type SteerCommand = z.infer<typeof SteerCommand>;
export type FollowUpCommand = z.infer<typeof FollowUpCommand>;
export type AbortCommand = z.infer<typeof AbortCommand>;
export type PromptCommand = z.infer<typeof PromptCommand>;
export type FileListCommand = z.infer<typeof FileListCommand>;
export type FileReadCommand = z.infer<typeof FileReadCommand>;
export type CheckpointCreateCommand = z.infer<typeof CheckpointCreateCommand>;
export type CheckpointListCommand = z.infer<typeof CheckpointListCommand>;
export type CheckpointRollbackCommand = z.infer<typeof CheckpointRollbackCommand>;
export type PreviewStartCommand = z.infer<typeof PreviewStartCommand>;
export type PreviewStopCommand = z.infer<typeof PreviewStopCommand>;
export type CopilotChatCommand = z.infer<typeof CopilotChatCommand>;
export type CopilotApplyCommand = z.infer<typeof CopilotApplyCommand>;
export type PlanApproveCommand = z.infer<typeof PlanApproveCommand>;

// ===== 命令响应（后端 → 前端，ACK）=====

export const CommandResponse = z.object({
  id: z.string(),
  type: z.literal("response"),
  command: z.string(),
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});
export type CommandResponse = z.infer<typeof CommandResponse>;

// ===== 事件（后端 → 前端）=====

const sessionIdField = { sessionId: z.string() };

/** Agent 角色：主编码 / 审查者 / 副驾驶 */
export const AgentRole = z.enum(["coder", "reviewer", "copilot"]);
export type AgentRole = z.infer<typeof AgentRole>;

/** Copilot 对话消息（一条用户消息或一条 Copilot 回复） */
export const CopilotMessage = z.object({
  id: z.string(),
  role: z.enum(["user", "copilot"]),
  text: z.string(),
  /** Copilot 回复中提取的给 Coder 的指令（有则前端显示「让 Coder 执行」按钮） */
  applyInstruction: z.string().optional(),
  ts: z.number(),
});
export type CopilotMessage = z.infer<typeof CopilotMessage>;

/** Copilot 队列状态 */
export const CopilotStatus = z.enum(["idle", "reviewing", "chatting", "queued"]);
export type CopilotStatus = z.infer<typeof CopilotStatus>;

/** 文件树条目（list 响应 data 与 file.tree 事件复用） */
export const FileEntry = z.object({
  path: z.string(),
  name: z.string(),
  type: z.enum(["file", "dir"]),
  size: z.number().optional(),
});
export type FileEntry = z.infer<typeof FileEntry>;

/** 文件变更 kind：write=新建/覆盖, edit=局部编辑, delete=删除 */
export const FileChangeKind = z.enum(["write", "edit", "delete"]);
export type FileChangeKind = z.infer<typeof FileChangeKind>;

/** 一个 checkpoint 元数据 */
export const CheckpointInfo = z.object({
  id: z.string(),
  /** 创建时毫秒时间戳 */
  createdAt: z.number(),
  /** 用户可选描述 */
  label: z.string().optional(),
  /** 快照下文件数量 */
  fileCount: z.number().optional(),
});
export type CheckpointInfo = z.infer<typeof CheckpointInfo>;

/** 预览服务器元信息 */
export const PreviewInfo = z.object({
  sessionId: z.string(),
  /** 监听端口 */
  port: z.number(),
  /** 对外可访问的 base URL（如果需要 host 重写由前端自己拼 WS 相对路径，这里先给 http://host:port/） */
  url: z.string(),
  /** 入口文件相对路径（原样返回） */
  entry: z.string().optional(),
  /** 运行状态 */
  running: z.boolean(),
});
export type PreviewInfo = z.infer<typeof PreviewInfo>;

export const ServerEvent = z.discriminatedUnion("type", [
  z.object({ ...sessionIdField, type: z.literal("session.ready"), model: z.string().optional(), reviewer: z.boolean().optional(), permissionMode: PermissionMode.optional() }),
  z.object({ ...sessionIdField, type: z.literal("agent_start"), agent: AgentRole }),
  z.object({ ...sessionIdField, type: z.literal("agent_end"), agent: AgentRole }),
  z.object({ ...sessionIdField, type: z.literal("turn_start"), agent: AgentRole }),
  z.object({ ...sessionIdField, type: z.literal("turn_end"), agent: AgentRole }),
  z.object({ ...sessionIdField, type: z.literal("message_start"), agent: AgentRole, role: z.string() }),
  z.object({ ...sessionIdField, type: z.literal("message_end"), agent: AgentRole }),
  z.object({ ...sessionIdField, type: z.literal("thinking_delta"), agent: AgentRole, contentIndex: z.number(), delta: z.string() }),
  z.object({ ...sessionIdField, type: z.literal("text_delta"), agent: AgentRole, contentIndex: z.number(), delta: z.string() }),
  z.object({ ...sessionIdField, type: z.literal("tool_start"), agent: AgentRole, toolCallId: z.string(), toolName: z.string(), args: z.unknown() }),
  z.object({ ...sessionIdField, type: z.literal("tool_end"), agent: AgentRole, toolCallId: z.string(), toolName: z.string(), isError: z.boolean() }),
  z.object({ ...sessionIdField, type: z.literal("queue_update"), steering: z.array(z.string()), followUp: z.array(z.string()) }),
  // 文件变更：从 write_file/edit_file/delete_file 等 tool 事件派生，附带新内容供前端直接渲染
  z.object({
    ...sessionIdField,
    type: z.literal("file.changed"),
    agent: AgentRole,
    path: z.string(),
    kind: FileChangeKind,
    content: z.string().optional(),
    toolCallId: z.string(),
  }),
  // 终端：Agent 通过 run_command 工具执行命令的输出流
  z.object({ ...sessionIdField, type: z.literal("terminal.cmd"), agent: AgentRole, toolCallId: z.string(), command: z.string() }),
  z.object({ ...sessionIdField, type: z.literal("terminal.output"), agent: AgentRole, toolCallId: z.string(), stream: z.enum(["stdout", "stderr"]), delta: z.string() }),
  z.object({ ...sessionIdField, type: z.literal("terminal.exit"), agent: AgentRole, toolCallId: z.string(), exitCode: z.number() }),
  z.object({ ...sessionIdField, type: z.literal("error"), agent: AgentRole.optional(), code: z.string(), message: z.string() }),
  // checkpoint 事件
  z.object({ ...sessionIdField, type: z.literal("checkpoint.created"), checkpoint: CheckpointInfo }),
  z.object({ ...sessionIdField, type: z.literal("checkpoint.rolled_back"), checkpointId: z.string() }),
  // 预览服务器事件
  z.object({ ...sessionIdField, type: z.literal("preview.started"), preview: PreviewInfo }),
  z.object({ ...sessionIdField, type: z.literal("preview.stopped") }),
  /** 文件变更时通知前端预览刷新（debouce 由后端或前端自己做） */
  z.object({ ...sessionIdField, type: z.literal("preview.updated"), path: z.string().optional() }),
  // Reviewer 审查完成：summary 是人类可读意见，severe=true 表示有严重问题（已自动注入 follow_up）
  z.object({
    ...sessionIdField,
    type: z.literal("review.finished"),
    summary: z.string(),
    severe: z.boolean(),
    /** 审查覆盖的文件列表 */
    reviewed: z.array(z.string()).optional(),
  }),
  // ===== Copilot 事件 =====
  /** Copilot 状态变化（排队/空闲/审查中/对话中） */
  z.object({
    ...sessionIdField,
    type: z.literal("copilot.status"),
    status: CopilotStatus,
    /** 排队位置（0=正在处理，1+=前面还有几个任务） */
    queuePosition: z.number().optional(),
    /** 当前任务描述（如"正在审查 index.html"） */
    currentTask: z.string().optional(),
    /** 队列中等待的任务数 */
    queueLength: z.number().optional(),
  }),
  /** Copilot 对话回复 */
  z.object({
    ...sessionIdField,
    type: z.literal("copilot.reply"),
    /** 对话消息 */
    message: CopilotMessage,
  }),
  /** Copilot 指令已注入 Coder */
  z.object({
    ...sessionIdField,
    type: z.literal("copilot.applied"),
    /** 注入的指令 */
    instruction: z.string(),
    /** 注入方式：steer=运行中插队 / prompt=触发新 turn（自动判断时上报实际使用的值） */
    mode: z.enum(["steer", "prompt"]),
  }),
  /** 权限拦截：Coder 试图执行的危险命令/工具被阻止，已 abort 并 steer 提示 */
  z.object({
    ...sessionIdField,
    type: z.literal("permission.blocked"),
    /** 触发拦截的工具名（通常是 bash） */
    toolName: z.string(),
    /** 被拦截的命令或工具参数摘要 */
    command: z.string(),
    /** 命中的规则名（如 "rm -rf" / "sudo" / "git push --force"） */
    rule: z.string(),
    /** 当前权限模式 */
    mode: PermissionMode,
  }),
  /** plan 模式：Coder 提出了计划，等待用户批准 */
  z.object({
    ...sessionIdField,
    type: z.literal("plan.proposed"),
    /** 计划 markdown 全文 */
    plan: z.string(),
    /** 计划摘要（首段或标题） */
    summary: z.string(),
  }),
  /** plan 模式：用户已批准/拒绝/要求修改，Coder 据此继续 */
  z.object({
    ...sessionIdField,
    type: z.literal("plan.decision"),
    /** 用户决定 */
    decision: z.enum(["approved", "rejected", "iterate"]),
    /** 反馈文本（iterate 时） */
    feedback: z.string().optional(),
  }),
  /** 权限模式动态切换成功 */
  z.object({ ...sessionIdField, type: z.literal("permission.updated"), permissionMode: PermissionMode }),
]);

export type ServerEvent = z.infer<typeof ServerEvent>;
