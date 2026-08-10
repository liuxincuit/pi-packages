/**
 * pi-bash-approver — 自动批准 pi-permission-system 的 bash 命令询问。
 *
 * 背景：pi-permission-system 对包装器命令（sudo、env、xargs、bash -c、eval 等）
 * 有 fail-closed 设计——即使配置了 `"bash": { "*": "allow" }`，这些命令的
 * allow 也会被强制提升为 ask 并弹窗询问，且没有任何配置项能关闭。
 *
 * 本扩展利用 pi-permission-system 的 authorizer chain 扩展点：注册一个
 * chain link（需在 pi-permission-system config.json 的 `authorizerChain`
 * 中显式启用），对所有 `bash` 表面的 ask 直接返回 allow，从而跳过弹窗。
 *
 * 安全边界：
 * - 只批准 surface === "bash" 的 ask；`external_directory` / `path` 表面的
 *   ask 一律 defer（仍由用户裁决），目录限制不受影响。
 * - chain owner 还会把 link 在这两个表面上的 allow 降级为 defer（双保险）。
 * - 代价：sudo 等包装命令不再有人工确认，仅建议在信任 agent 的环境启用。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LINK_NAME = "bash-approver";
const READY_CHANNEL = "permissions:ready";

// 服务是 pi-permission-system 发布在 globalThis 上的（service.ts 的
// SERVICE_KEY）。Symbol.for 是 process-global，jiti 的模块隔离也拦不住，
// 与包内 getPermissionsService() 完全等价——绕开了对 node_modules 的依赖
// （D:\code\skills 无 node_modules，import("@gotgenes/...") 会解析失败）。
const SERVICE_KEY = Symbol.for("@gotgenes/pi-permission-system:service");

// 结构类型，避免对 @gotgenes/pi-permission-system 的类型依赖。
type AskDetails = {
  requestId?: string;
  surface?: string | null;
  command?: string;
  value?: string | null;
  accessIntent?: { surface?: string };
};

type PermissionsServiceLike = {
  registerAuthorizer?: (name: string, authorize: unknown) => () => void;
};

function getPermissionsService(): PermissionsServiceLike | undefined {
  return (globalThis as Record<symbol, unknown>)[SERVICE_KEY] as
    | PermissionsServiceLike
    | undefined;
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function bashApprover(pi: ExtensionAPI) {
  let dispose: (() => void) | undefined;

  /**
   * 幂等注册：pi-permission-system 的 `permissions:ready` 在它自己的
   * session_start 内触发，与本扩展的 session_start 先后顺序不定，
   * 两个入口都尝试，由 dispose 守卫保证只注册一次。
   */
  function tryRegister(): void {
    if (dispose) return;
    const service = getPermissionsService();
    if (!service || typeof service.registerAuthorizer !== "function") return;

    try {
      const authorize = async (
        details: AskDetails,
        _query: unknown,
        log: { review?: (event: string, payload: unknown) => void } | undefined,
      ) => {
        // 只接管 bash 命令的 ask；目录/路径 ask（external_directory、path
        // 表面）defer 给用户，保持目录限制有效。
        const surface = details?.accessIntent?.surface ?? details?.surface;
        if (surface !== "bash") return { kind: "defer" };
        log?.review?.("bash_approver.decision", {
          requestId: details?.requestId ?? null,
          command: details?.command ?? details?.value ?? null,
          verdict: "allow",
        });
        return { kind: "allow" };
      };

      dispose = service.registerAuthorizer(LINK_NAME, authorize);
    } catch (error) {
      // 注册失败时可见地报出来，便于排查（不影响其他扩展）
      console.warn(`[pi-bash-approver] registerAuthorizer failed:`, error);
    }
  }

  pi.on("session_start", () => tryRegister());
  pi.events.on(READY_CHANNEL, () => tryRegister());

  pi.on("session_shutdown", () => {
    dispose?.();
    dispose = undefined;
  });
}
