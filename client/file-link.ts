export interface FileLinkTarget {
  path: string;
  relative: boolean;
  directory: boolean;
}

export interface WorkspaceRoute {
  serverId: string;
  workspaceId: string;
}

/** Only current, unambiguous workspace routes can authorize a local desktop action. */
export function parseWorkspaceRoute(pathname: string): WorkspaceRoute | null {
  const match = /^\/h\/([^/]+)\/workspace\/([^/?#]+)(?:[/?#]|$)/.exec(pathname);
  if (!match) return null;
  try {
    const serverId = decodeURIComponent(match[1]!);
    const workspaceId = decodeURIComponent(match[2]!);
    // Legacy path-encoded workspaces require the host's decoder; do not guess their directory.
    if (!serverId || !workspaceId || workspaceId.startsWith("b64_")) return null;
    return { serverId, workspaceId };
  } catch {
    return null;
  }
}

export function parseFileLink(raw: string): FileLinkTarget | null {
  let value = raw.trim();
  if (!value || value.startsWith("#")) return null;
  if (/^file:/i.test(value)) {
    // Only file URLs on this computer, not file://another-machine/share.
    if (/^file:\/\/localhost\//i.test(value)) value = value.replace(/^file:\/\/localhost/i, "");
    else if (/^file:\/\//i.test(value)) {
      if (!/^file:\/\/\//i.test(value)) return null;
      value = value.slice(7);
    } else value = value.slice(5);
  } else if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) {
    return null;
  }
  // Strip location markers before decoding, so a literal encoded '#' remains a filename character.
  value = value.replace(/#(?:L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?|page=\d+)$/i, "");
  value = value.replace(/:\d+(?::\d+)?(?:-\d+(?::\d+)?)?$/, "");
  try { value = decodeURIComponent(value); } catch { /* A literal '%' is a legal filename. */ }
  value = value.replace(/\\/g, "/").replace(/^\/([a-z]:\/)/i, "$1");
  if (!value || /[\x00-\x1f\x7f]/.test(value) || value.startsWith("//")) return null;
  // Recheck after decoding; an encoded web/protocol URL must never become a local path.
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:\//i.test(value)) return null;
  const absolute = /^[a-z]:\//i.test(value) || value.startsWith("/") || value.startsWith("~/");
  if (!absolute && !value.includes("/") && !/\.[\p{L}\d_-]+$/u.test(value) && value !== "." && value !== "..") return null;
  return { path: value, relative: !absolute, directory: value.endsWith("/") || value === "." || value === ".." };
}

/** Resolve only against an explicitly identified local workspace, never the process cwd. */
export function resolveFileLink(target: FileLinkTarget, workspaceDirectory: string | null, platform: string): string | null {
  let value = target.path;
  if (target.relative) {
    if (!workspaceDirectory) return null;
    value = workspaceDirectory.replace(/\\/g, "/").replace(/\/$/, "") + "/" + value;
  }
  if (platform === "win32") {
    if (!/^[a-z]:\//i.test(value) && !value.startsWith("~/")) return null;
    // Device paths, alternate streams, and reserved filename characters are not normal file links.
    if (/[<>"|?*]/.test(value) || value.replace(/^[a-z]:/i, "").includes(":")) return null;
  } else if (!value.startsWith("/") && !value.startsWith("~/")) return null;
  const root = /^[a-z]:\//i.exec(value)?.[0] ?? (value.startsWith("~/") ? "~/" : "/");
  const segments: string[] = [];
  for (const segment of value.slice(root.length).split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return root + segments.join("/");
}
