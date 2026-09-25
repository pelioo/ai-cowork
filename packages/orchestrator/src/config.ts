// ★ 必须在读取 process.env 之前加载 .env 文件
//   ★ BUG 修复：`import "dotenv/config"` 默认从 process.cwd() 读 .env，但
//   `npm run dev:orch` 会把 cwd 切到 packages/orchestrator，导致根目录的 .env 读不到。
//   改为显式加载项目根目录（monorepo root）的 .env，用户在根目录配一次即可。
import { config as dotenvConfig } from "dotenv";
import { resolve, fileURLToPath } from "node:url";
import { dirname } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(__dirname, "../../.env") });

/** 运行配置，从环境变量读取。 */
function parsePort(raw: string | undefined, def: number): number {
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid PORT: ${raw} (expected integer in 1..65535)`);
  }
  return n;
}

export const config = {
  port: parsePort(process.env.PORT, 3001),
  anthropicKey: process.env.ANTHROPIC_API_KEY?.trim() || undefined,
  deepseekKey: process.env.DEEPSEEK_API_KEY?.trim() || undefined,
  openaiKey: process.env.OPENAI_API_KEY?.trim() || undefined,
  openaiBaseUrl: process.env.OPENAI_BASE_URL?.trim() || undefined,
  defaultModel: process.env.AICOWORK_DEFAULT_MODEL?.trim() || undefined,
  authToken: process.env.AICOWORK_AUTH_TOKEN?.trim() || undefined,
  host: process.env.AICOWORK_HOST?.trim() || "127.0.0.1",
};