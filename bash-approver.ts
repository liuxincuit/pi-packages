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
 *
 * 服务定位：pi-permission-system 的服务发布在 sessionId 键控的进程级 Map 上
 * （service.ts 的 SESSION_SERVICES_KEY）。27.0.0 起零参 `getPermissionsService()`
 * 被弃用，29.0.0 起 process-root 槽 `Symbol.for("...:service")` 不再写入——
 * 读旧槽只会拿到 undefined，注册静默失效。这里用 Symbol.for 直读键控 Map，
 * 绕开对 node_modules 的依赖（本仓库无 node_modules，
 * import("@gotgenes/pi-permission-system") 会解析失败）；Symbol.for 是
 * process-global，jiti 的模块隔离拦不住。
 *
 * 注册范围：一个进程可有多个节点（父会话 + 每个 in-process 子代理），各自持
 * 有独立的 registry 和 authorizer chain，且只读本节点注册的 link。所以按
 * sessionId 逐节点注册、逐节点释放，不做跨节点去重。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LINK_NAME = "bash-approver";
const READY_CHANNEL = "permissions:ready";

// pi-permission-system service.ts 的 SESSION_SERVICES_KEY：node 自己发布服务
// 的 Map<string, PermissionsService>。
const SESSION_SERVICES_KEY = Symbol.for(
  "@gotgenes/pi-permission-system:session-services",
);

// 结构类型，避免对 @gotgenes/pi-permission-system 的类型依赖。
type AskDetails = {
  requestId?: string;
  surface?: string | null;
  command?: string;
  value?: string | null;
  accessIntent?: { surface?: string };
};

type AuthorizerLogLike = {
  review?: (event: string, payload: unknown) => void;
};

type PermissionsServiceLike = {
  registerAuthorizer: (name: string, authorize: unknown) => () => void;
};

/**
 * 取某个节点（sessionId）的服务；该节点未发布服务时返回 undefined。
 */
function getPermissionsService(
  sessionId: string,
): PermissionsServiceLike | undefined {
  const services = (globalThis as Record<symbol, unknown>)[
    SESSION_SERVICES_KEY
  ] as Map<string, PermissionsServiceLike> | undefined;
  if (!(services instanceof Map)) return undefined;
  return services.get(sessionId);
}

const authorize = async (
  details: AskDetails,
  _query: unknown,
  log: AuthorizerLogLike | undefined,
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

// ── Extension ────────────────────────────────────────────────────────────────

export default function bashApprover(pi: ExtensionAPI) {
  // 本节点已注册 link 的释放句柄，按 sessionId 去重：`permissions:ready`
  // 每个节点至少触发两次（session_start 后一次、首个 before_agent_start
  // 一次），重复注册会撞上 registerAuthorizer 的重名抛出。
  const disposers = new Map<string, () => void>();

  function tryRegister(sessionId: string): void {
    if (disposers.has(sessionId)) return;
    const service = getPermissionsService(sessionId);
    if (!service) return;
    try {
      disposers.set(
        sessionId,
        service.registerAuthorizer(LINK_NAME, authorize),
      );
    } catch (error) {
      console.warn(`[pi-bash-approver] registerAuthorizer failed:`, error);
    }
  }

  // ready 事件本身就是足够的注册点：它在首个 before_agent_start 还会再触发
  // 一次，晚于所有扩展的 session_start，因此不依赖扩展加载顺序。
  pi.events.on(READY_CHANNEL, (event) => {
    const sessionId = (event as { sessionId?: string | null } | undefined)
      ?.sessionId;
    if (typeof sessionId === "string") tryRegister(sessionId);
  });

  // session_shutdown 只释放本节点（本扩展实例）注册的 link。
  pi.on("session_shutdown", () => {
    for (const dispose of disposers.values()) dispose();
    disposers.clear();
  });
}
