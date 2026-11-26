import { resolveFileLink, type FileLinkTarget, type WorkspaceRoute } from "./file-link";

/** Narrow adapter for Paseo Desktop's existing preload bridge (not a public plugin API). */
export interface DesktopFileBridge {
  platform?: string;
  invoke?: (command: string) => Promise<unknown>;
  editor?: {
    openTarget?: (input: RevealInput) => Promise<void>;
  };
}

export interface RevealInput {
  editorId: string;
  workspacePath: string;
  filePath?: string;
}

export type RevealPreparation =
  | { ready: true; input: RevealInput }
  | { ready: false; reason: "unavailable" | "unknown-workspace" | "remote" | "unsupported-path" };

// These IDs are registered by Paseo Desktop itself. Opening a target still checks its
// availability and the requested path; listing every installed editor first is unnecessary.
function fileManagerId(platform: string | undefined): string | null {
  switch (platform) {
    case "win32": return "explorer";
    case "darwin": return "finder";
    case "linux": return "file-manager";
    default: return null;
  }
}

// The desktop's server ID is stable for this bridge/installation's lifetime. Cache only
// a confirmed ID, share pending queries, and let the next attempt retry failures.
const localServerIds = new WeakMap<DesktopFileBridge, Promise<string | null>>();

function readLocalServerId(bridge: DesktopFileBridge): Promise<string | null> {
  const existing = localServerIds.get(bridge);
  if (existing) return existing;
  const pending = Promise.resolve().then(() => bridge.invoke!("desktop_daemon_status")).then(
    (status) => {
      const serverId = status && typeof status === "object" && "serverId" in status &&
        typeof status.serverId === "string" ? status.serverId.trim() : "";
      if (!serverId) localServerIds.delete(bridge);
      return serverId || null;
    },
    (error: unknown) => {
      localServerIds.delete(bridge);
      throw error;
    },
  );
  localServerIds.set(bridge, pending);
  return pending;
}

/** Start the identity query at installation, before the first right-click. */
export async function warmLocalReveal(bridge: DesktopFileBridge | undefined): Promise<void> {
  if (bridge?.invoke && bridge.editor?.openTarget && fileManagerId(bridge.platform)) {
    await readLocalServerId(bridge);
  }
}

export async function prepareLocalReveal({
  bridge,
  route,
  target,
  readDirectory,
}: {
  bridge: DesktopFileBridge;
  route: WorkspaceRoute | null;
  target: FileLinkTarget;
  readDirectory: (route: WorkspaceRoute) => Promise<string | null>;
}): Promise<RevealPreparation> {
  const editorId = fileManagerId(bridge.platform);
  if (!bridge.invoke || !bridge.editor?.openTarget || !editorId) {
    return { ready: false, reason: "unavailable" };
  }
  if (!route) return { ready: false, reason: "unknown-workspace" };
  const serverId = await readLocalServerId(bridge);
  if (!serverId) return { ready: false, reason: "unavailable" };
  if (serverId !== route.serverId) return { ready: false, reason: "remote" };
  const directory = target.relative ? await readDirectory(route) : null;
  const path = resolveFileLink(target, directory, bridge.platform!);
  if (!path) return { ready: false, reason: "unsupported-path" };
  const localPath = bridge.platform === "win32" ? path.replace(/\//g, "\\") : path;
  return {
    ready: true,
    input: {
      editorId,
      workspacePath: localPath,
      ...(target.directory ? {} : { filePath: localPath }),
    },
  };
}
