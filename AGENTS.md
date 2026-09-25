# Agents

## 项目概述

TypeScript monorepo：双 Agent 结对编程工作台（Coder + Reviewer），支持：
- 实时预览和权限管控
- 计划审批（Plan Mode）：Coder 输出 markdown 计划，用户批准后才执行
- 快照回滚（Checkpoint）：一键保存/回滚工作区
- 危险命令拦截：15 类破坏性命令实时阻断并重定向

## Packages

| Package | 路径 | 职责 |
|---------|------|------|
| shared | `packages/shared/` | Zod schemas：`ClientCommand` + `ServerEvent` |
| orchestrator | `packages/orchestrator/` | 后端：Fastify + WebSocket + pi-coding-agent |
| web | `packages/web/` | 前端：React + Vite + Zustand |

## 始终加载的合约

### 构建顺序（必须遵守）
```
npm run build:shared   # 先执行 — 所有包都依赖 shared/dist
npm run build -w @ai-cowork/orchestrator
npm run build -w @ai-cowork/web
```

### 开发模式（两个终端）
```bash
# Terminal 1
npm run dev:orch   # 后端 :3001

# Terminal 2
npm run dev:web    # 前端 :3000，代理 /ws 和 /preview 到 :3001
```

### 协议所有权
- Schema 变更：`packages/shared/src/index.ts` → `npm run build:shared` → 同步其他包
- 后端逻辑：`packages/orchestrator/src/session-registry.ts`（权限模式、plan 状态机）
- 事件映射：`packages/orchestrator/src/event-bridge.ts`（pi-coding-agent → ServerEvent）
- 前端状态：`packages/web/src/store.ts` + `packages/web/src/ws.ts`

## 关键行为

### 权限模式
- `free`（默认）：所有工具，拦截 15 类危险命令
- `read-only`：仅允许 read/grep/ls/bash 白名单
- `plan`：仅读，直到用户通过 `plan.approve` 审批 markdown 计划

### 危险命令拦截
定义在 `session-registry.ts` → `checkDangerousCommand`。命中后执行 `abort` + `steer` 重定向 Coder。

### 事件流
`pi-coding-agent` → `event-bridge` → `SessionRegistry` 广播 → WebSocket → `ws.ts` → Zustand `store.ts` → React。

## 完成标准

- 三个包均构建无错
- TypeScript 严格检查通过（`--noUnusedLocals --noUnusedParameters`）
- `npm run dev:orch` + `npm run dev:web` 正常启动
