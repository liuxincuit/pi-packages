/**
 * bash-tool-env
 *
 * 为 bash 工具注入 ~/.pi/agent/.env 中的环境变量，并移除代理变量（bash 直连）。
 *
 * 行为：
 * - ~/.pi/agent/.env 不存在时：不注册任何覆盖，保持默认 bash 工具
 * - .env 存在时：spawnHook 删除 HTTP_PROXY 等代理变量，再注入 .env 的 KEY=VALUE
 * - 每次命令执行前读取 .env，文件改动即时生效
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ENV_FILE = join(homedir(), ".pi", "agent", ".env");

/** 解析 KEY=VALUE 格式，支持 # 注释、空行、引号 */
function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let value = t.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export default function (pi: ExtensionAPI) {
  // 没有 .env 文件：保持默认 bash 工具，不做任何覆盖
  if (!existsSync(ENV_FILE)) return;

  const bashTool = createBashTool(process.cwd(), {
    spawnHook: ({ command, cwd, env }) => {
      // 1. 移除代理变量，bash 工具直连
      const clean = { ...env };
      for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
        delete clean[key];
      }
      // 2. 注入 .env 中的变量
      Object.assign(clean, parseEnvFile(ENV_FILE));
      return { command, cwd, env: clean };
    },
  });

  pi.registerTool({
    ...bashTool,
    execute: async (id, params, signal, onUpdate) =>
      bashTool.execute(id, params, signal, onUpdate),
  });
}