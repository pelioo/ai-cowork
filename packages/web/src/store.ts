import { create } from "zustand";
import type { FileEntry, CheckpointInfo, PreviewInfo, CopilotMessage, CopilotStatus, AgentRole, PermissionMode } from "@ai-cowork/shared";

/**
 * 生成唯一 id：crypto.randomUUID 需要安全上下文（https/localhost），
 * 在预览代理或 http 部署下可能不可用，做兜底（与 ws.ts 的 genId 同逻辑）。
 * 不能直接 import ws.ts 的 genId，会形成循环依赖（ws.ts 反向 import store）。
 */
function safeUUID(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // 忽略，走兜底
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 计算新旧文本之间的行级 diff，返回「新文本中新增/修改行」的 0-based 行号数组。
 * 用 LCS 做行级比对。
 *
 * ★ B16 性能保护：
 *   - LCS DP 是 O(m*n) 时间 + O(m*n) 空间，在主线程同步跑。
 *   - 之前阈值 2000 行 → 2000×2000 = 400 万格子，会卡 UI 几百毫秒。
 *   - 现在阈值降到 800 行（800×800 = 64 万，<16ms），更大文件直接返回 []，
 *     跳过高亮（不影响功能，只是不再标"变更行"）。
 *   - 后续如需支持大文件 diff，应迁移到 Web Worker。
 */
function diffLineNumbers(oldText: string, newText: string): number[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const m = oldLines.length;
  const n = newLines.length;
  if (m > 800 || n > 800) return [];
  // LCS DP（从后往前填表）
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  // 回溯：new 中不在 LCS 里的行 = 新增/修改
  const changed: number[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++; // old 行被删除
    } else {
      changed.push(j); // new 行是新增/修改
      j++;
    }
  }
  while (j < n) {
    changed.push(j);
    j++;
  }
  return changed;
}

/** 单条日志条目，对应一个 ServerEvent 的渲染结果 */
export type LogEntry =
  | { kind: "thinking"; agent: AgentRole; text: string; ts: number }
  | { kind: "text"; agent: AgentRole; text: string; ts: number }
  | { kind: "tool_start"; agent: AgentRole; toolName: string; args: unknown; ts: number }
  | { kind: "tool_end"; agent: AgentRole; toolName: string; isError: boolean; ts: number }
  | { kind: "lifecycle"; agent?: AgentRole; type: string; ts: number }
  | { kind: "queue"; steering: number; followUp: number; ts: number }
  | { kind: "error"; agent?: AgentRole; message: string; ts: number }
  | { kind: "review"; severe: boolean; summary: string; reviewed?: string[]; ts: number }
  | { kind: "blocked"; toolName: string; command: string; rule: string; mode: PermissionMode; ts: number };

/** plan 模式状态：proposing=已出计划待批准 / approved=已批准执行中（rejected/iterate 后 planState 直接清空） */
export type PlanPhase = "proposing" | "approved";

export interface PlanState {
  phase: PlanPhase;
  /** 计划 markdown 全文 */
  plan: string;
  /** 计划摘要 */
  summary: string;
  /** 批准时间戳（仅 approved 时有值） */
  decidedAt?: number;
}

/** 终端行 */
export interface TerminalLine {
  toolCallId: string;
  kind: "cmd" | "stdout" | "stderr" | "exit";
  text: string;
  ts: number;
}

interface CoworkState {
  connected: boolean;
  sessionId: string | null;
  model: string | undefined;
  isStreaming: boolean;
  /** reviewer 是否启用 */
  reviewer: boolean;
  /** 权限模式：free/read-only/plan */
  permissionMode: PermissionMode;
  log: LogEntry[];
  steeringCount: number;
  followUpCount: number;

  // 文件树
  files: FileEntry[];
  /** 当前选中的文件 path */
  currentPath: string | null;
  /** 当前文件内容（按 path 缓存，key=path） */
  fileContents: Record<string, string>;
  /** 每个文件最近一次变更的「新增/修改行」0-based 行号（用于 diff 高亮） */
  fileDiffLines: Record<string, number[]>;
  /** 最近一次变更的文件 path（用于自动跳转 + diff 高亮） */
  lastChangedPath: string | null;
  /** 最近一次变更的 toolCallId（用于 diff 标记） */
  lastChangedToolCallId: string | null;

  // 终端
  terminalLines: TerminalLine[];

  // checkpoint
  checkpoints: CheckpointInfo[];

  // preview
  /** 预览运行信息（null=未启动） */
  preview: PreviewInfo | null;
  /** 预览需要刷新的递增序号：每次变化触发 iframe reload */
  previewRev: number;

  // copilot
  /** Copilot 对话消息列表 */
  copilotMessages: CopilotMessage[];
  /** Copilot 当前状态 */
  copilotStatus: CopilotStatus;
  /** Copilot 排队位置 */
  copilotQueuePosition: number;
  /** Copilot 当前任务描述 */
  copilotCurrentTask: string | null;
  /** Copilot 队列长度 */
  copilotQueueLength: number;

  // plan 模式
  /** 当前计划状态（null=未进入 plan 模式或已结束） */
  planState: PlanState | null;

  // 动作
  setConnected: (b: boolean) => void;
  setSession: (id: string | null, model?: string, reviewer?: boolean, permissionMode?: PermissionMode) => void;
  setStreaming: (b: boolean) => void;
  setQueue: (s: number, f: number) => void;
  setPermissionMode: (mode: PermissionMode) => void;
  append: (entry: LogEntry) => void;
  setFiles: (files: FileEntry[]) => void;
  setCurrentPath: (path: string | null) => void;
  setFileContent: (path: string, content: string) => void;
  markFileChanged: (path: string, toolCallId: string) => void;
  addTerminalLine: (line: TerminalLine) => void;
  setCheckpoints: (cps: CheckpointInfo[]) => void;
  addCheckpoint: (cp: CheckpointInfo) => void;
  setPreview: (p: PreviewInfo | null) => void;
  bumpPreviewRev: () => void;
  addCopilotUserMessage: (text: string) => void;
  addCopilotReply: (msg: CopilotMessage) => void;
  setCopilotStatus: (status: CopilotStatus, queuePosition?: number, currentTask?: string, queueLength?: number) => void;
  /** plan.proposed 事件：Coder 提出了计划，进入待批准状态 */
  setPlanProposed: (plan: string, summary: string) => void;
  /** plan.decision 事件：用户已决策，更新 phase（approved/rejected/iterated） */
  setPlanDecision: (decision: "approved" | "rejected" | "iterate", feedback?: string) => void;
  /** approved 执行完成后或新 session 时清空 */
  clearPlan: () => void;
  clear: () => void;
}

export const useStore = create<CoworkState>((set, get) => ({
  connected: false,
  sessionId: null,
  model: undefined,
  isStreaming: false,
  reviewer: false,
  permissionMode: "free" as PermissionMode,
  log: [],
  steeringCount: 0,
  followUpCount: 0,

  files: [],
  currentPath: null,
  fileContents: {},
  fileDiffLines: {},
  lastChangedPath: null,
  lastChangedToolCallId: null,

  terminalLines: [],

  checkpoints: [],

  preview: null,
  previewRev: 0,

  copilotMessages: [],
  copilotStatus: "idle" as CopilotStatus,
  copilotQueuePosition: 0,
  copilotCurrentTask: null,
  copilotQueueLength: 0,

  planState: null,

  setConnected: (b) => set({ connected: b }),
  setSession: (id, model, reviewer, permissionMode) => set({ sessionId: id, model, reviewer: reviewer ?? false, permissionMode: permissionMode ?? "free" }),
  setStreaming: (b) => set({ isStreaming: b }),
  setQueue: (s, f) => set({ steeringCount: s, followUpCount: f }),
  setPermissionMode: (mode) => set({ permissionMode: mode }),
  append: (entry) => {
    const log = get().log;
    const last = log[log.length - 1];
    if (
      (last?.kind === "thinking" || last?.kind === "text") &&
      last.kind === entry.kind &&
      last.agent === (entry as { agent?: unknown }).agent
    ) {
      const merged = { ...last, text: last.text + (entry as { text: string }).text };
      set({ log: [...log.slice(0, -1), merged] });
    } else {
      set({ log: [...log, entry] });
    }
  },
  setFiles: (files) => set({ files }),
  setCurrentPath: (path) => set({ currentPath: path }),
  setFileContent: (path, content) =>
    set((state) => {
      const prev = state.fileContents[path];
      // 只在内容真正变化时计算 diff；首次读取(无旧值)或内容相同则保持已有 diff
      let diff = state.fileDiffLines[path] ?? [];
      if (prev !== undefined && prev !== content) {
        diff = diffLineNumbers(prev, content);
      } else if (prev === undefined) {
        diff = [];
      }
      return {
        fileContents: { ...state.fileContents, [path]: content },
        fileDiffLines: { ...state.fileDiffLines, [path]: diff },
      };
    }),
  markFileChanged: (path, toolCallId) =>
    set({ lastChangedPath: path, lastChangedToolCallId: toolCallId }),
  addTerminalLine: (line) =>
    set({ terminalLines: [...get().terminalLines, line] }),
  setCheckpoints: (cps) => set({ checkpoints: cps }),
  // ★ 去重：CheckpointPanel.create() 在拿到 response 后会先本地 addCheckpointLocal，
  //   紧接着 checkpoint.created 事件也会触发本方法。若不去重，同一 cp 会被加入两次。
  //   按 id 去重，已存在则保持原顺序不变。
  addCheckpoint: (cp) =>
    set((state) => {
      if (state.checkpoints.some((c) => c.id === cp.id)) return {};
      return { checkpoints: [cp, ...state.checkpoints].sort((a, b) => b.createdAt - a.createdAt) };
    }),
  setPreview: (p) => set({ preview: p }),
  bumpPreviewRev: () => set({ previewRev: get().previewRev + 1 }),
  addCopilotUserMessage: (text) =>
    set({
      copilotMessages: [
        ...get().copilotMessages,
        { id: safeUUID(), role: "user", text, ts: Date.now() },
      ],
    }),
  addCopilotReply: (msg) => set({ copilotMessages: [...get().copilotMessages, msg] }),
  setCopilotStatus: (status, queuePosition, currentTask, queueLength) =>
    set({
      copilotStatus: status,
      ...(queuePosition !== undefined ? { copilotQueuePosition: queuePosition } : {}),
      ...(currentTask !== undefined ? { copilotCurrentTask: currentTask } : {}),
      ...(queueLength !== undefined ? { copilotQueueLength: queueLength } : {}),
    }),
  setPlanProposed: (plan, summary) =>
    set({ planState: { phase: "proposing", plan, summary } }),
  setPlanDecision: (decision, _feedback) =>
    set((state) => {
      if (!state.planState) return {};
      // approved 后保留 plan 文本供回看，但标记已批准；rejected/iterate 后清空待 Coder 重新出计划
      // _feedback 仅用于 ws.ts 的日志展示，不在此存储（planState 已被清空）
      if (decision === "approved") {
        return { planState: { ...state.planState, phase: "approved", decidedAt: Date.now() } };
      }
      // rejected/iterate：清空当前计划，等 Coder 输出新计划
      return { planState: null };
    }),
  clearPlan: () => set({ planState: null }),
  // ★ BUG 修复：clear 之前漏重置 isStreaming/steeringCount/followUpCount/sessionId/model/files，
  //   导致启动新 session 时残留上一 session 的状态（如 isStreaming=true 卡住 UI）。
  //   现在完整重置所有业务字段，sessionId/model 清空让 App.tsx 显示启动表单。
  clear: () => set({
    log: [], terminalLines: [], checkpoints: [], preview: null, previewRev: 0,
    reviewer: false, permissionMode: "free",
    copilotMessages: [], copilotStatus: "idle", copilotQueuePosition: 0, copilotCurrentTask: null, copilotQueueLength: 0,
    fileContents: {}, fileDiffLines: {}, lastChangedPath: null, lastChangedToolCallId: null, currentPath: null,
    planState: null,
    sessionId: null, model: undefined, isStreaming: false, steeringCount: 0, followUpCount: 0,
    files: [],
  }),
}));
