import { getPaseoClient } from "@getpaseo/plugin/client";
import { copyText } from "@getpaseo/plugin/client/react-native";
import { Platform } from "react-native";
import { parseFileLink, parseWorkspaceRoute, type WorkspaceRoute } from "./file-link";
import { prepareLocalReveal, warmLocalReveal, type DesktopFileBridge, type RevealInput } from "./reveal";

/*
 * Right-click a chat link to copy its address or reveal a local file in the system file manager.
 *
 * Web and desktop only. Mobile chat links are native text spans, not anchors.
 *
 * Why this exists: on web the host renders every chat link (Markdown links,
 * autolinked paths, inline-code paths) as a real <a href="..."> element whose
 * href is the RAW Markdown target, then intercepts the click and routes it to
 * its own opener. Right-click does nothing in the desktop shell, and in a
 * browser the native "Copy link address" copies the browser-resolved URL,
 * which mangles file paths and relative hrefs. This menu copies the raw
 * attribute instead: exactly the text the agent wrote.
 *
 * There is no plugin API for link context menus, so this module drives the
 * host DOM directly, the same way paseo-quote does. Every host selector it
 * relies on is listed below.
 */

// ---------------------------------------------------------------------------
// Host DOM contract (Paseo 0.10)

/** One chat transcript. Inactive tabs keep theirs mounted with display: none. */
const CHAT_SCROLL = '[data-testid="agent-chat-scroll"]';
/** Chat links are real anchors; the href attribute holds the raw Markdown target. */
const ANCHOR = "a[href]";
const MENU_HOST = "[data-paseo-link-menu]";
const SHARED = Symbol.for("frowang.paseo-link-menu.installation.v1");
type DirectoryReader = (route: WorkspaceRoute) => Promise<string | null>;
interface MenuInstallation {
  readers: Map<symbol, DirectoryReader>;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Minimal DOM declarations; the plugin typechecks without the DOM library.

interface DomEvent {
  readonly type: string;
  readonly target: DomNode | null;
  preventDefault(): void;
  stopPropagation(): void;
  stopImmediatePropagation(): void;
}

interface DomMouseEvent extends DomEvent {
  readonly clientX: number;
  readonly clientY: number;
}

interface DomKeyboardEvent extends DomEvent {
  readonly key: string;
}

type DomListener = (event: DomEvent) => void;

interface DomEventTarget {
  addEventListener(type: string, listener: DomListener, capture?: boolean): void;
  removeEventListener(type: string, listener: DomListener, capture?: boolean): void;
}

interface DomNode extends DomEventTarget {
  readonly nodeType: number;
  readonly parentElement: DomElement | null;
}

interface DomStyle {
  setProperty(name: string, value: string, priority?: string): void;
  readonly color: string;
  readonly backgroundColor: string;
  readonly fontFamily: string;
}

interface MediaQueryList {
  readonly matches: boolean;
}

interface DomElement extends DomNode {
  readonly style: DomStyle;
  className: string;
  readonly offsetWidth: number;
  readonly offsetHeight: number;
  textContent: string | null;
  innerHTML: string;
  hidden: boolean;
  closest(selector: string): DomElement | null;
  querySelector(selector: string): DomElement | null;
  querySelectorAll(selector: string): Array<DomElement>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  appendChild<Child extends DomNode>(child: Child): Child;
  contains(node: DomNode | null): boolean;
  remove(): void;
  attachShadow(init: { mode: "open" }): DomShadowRoot;
}

interface DomButton extends DomElement {
  disabled: boolean;
}

interface DomShadowRoot {
  innerHTML: string;
  querySelector(selector: string): DomElement | null;
}

interface DomRange {
  intersectsNode(node: DomNode): boolean;
}

interface DomSelection {
  readonly isCollapsed: boolean;
  readonly rangeCount: number;
  getRangeAt(index: number): DomRange;
}

declare const window: DomEventTarget & {
  readonly location: { pathname: string; hash: string };
  readonly paseoDesktop?: DesktopFileBridge;
  readonly innerWidth: number;
  readonly innerHeight: number;
  getSelection(): DomSelection | null;
  getComputedStyle(element: DomElement): DomStyle;
  matchMedia(query: string): MediaQueryList;
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(handle: number): void;
};
declare const document: DomEventTarget & {
  readonly body: DomElement;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
  createElement(tag: "div"): DomElement;
  [key: symbol]: MenuInstallation | undefined;
};
declare const navigator: { readonly language: string };

// ---------------------------------------------------------------------------
// Labels

const ZH = typeof navigator !== "undefined" && (navigator.language?.toLowerCase().startsWith("zh") ?? false);
const LABEL = {
  copy: ZH ? "复制链接地址" : "Copy link address",
  copied: ZH ? "已复制" : "Copied",
  failed: ZH ? "复制失败" : "Copy failed",
  reveal: ZH ? "在文件管理器中显示" : "Show in file manager",
  explorer: ZH ? "在资源管理器中显示" : "Show in Explorer",
  finder: ZH ? "在 Finder 中显示" : "Show in Finder",
  checking: ZH ? "正在准备打开位置…" : "Preparing file location…",
  opening: ZH ? "正在打开文件位置…" : "Opening file location…",
  revealed: ZH ? "已打开文件位置" : "File location opened",
  revealFailed: ZH ? "打开失败，可重试" : "Could not open; retry",
  missing: ZH ? "文件或文件夹不存在：" : "File or folder does not exist: ",
  checkFailed: ZH ? "无法确认文件位置，请关闭菜单后重试。" : "Could not check the file location. Reopen the menu to retry.",
  openFailed: ZH ? "请确认文件仍在原位置且可以访问，然后重试。" : "Check that the file still exists and is accessible, then retry.",
  unavailable: ZH ? "当前桌面端不支持此操作" : "Unavailable in this desktop client",
  "unknown-workspace": ZH ? "无法确认链接所属的工作区" : "Could not identify the link's workspace",
  remote: ZH ? "这是远程主机的文件，无法在本机定位" : "This file belongs to a remote host",
  "unsupported-path": ZH ? "无法解析为本机文件路径" : "Could not resolve a local file path",
} as const;

/** The address as the user wrote it: undo the renderer's percent-encoding. */
function displayAddress(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// ---------------------------------------------------------------------------
// Colors, read from the link itself so the menu follows every theme

type Rgba = [number, number, number, number];

function parseColor(value: string): Rgba | null {
  const match = value.match(/rgba?\(([^)]+)\)/);
  if (!match) return null;
  const parts = match[1]!.split(/[\s,/]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) return null;
  return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
}

function css([r, g, b]: Rgba, alpha = 1): string {
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${alpha})`;
}

function mix(a: Rgba, b: Rgba, amount: number): Rgba {
  return [
    a[0] + (b[0] - a[0]) * amount,
    a[1] + (b[1] - a[1]) * amount,
    a[2] + (b[2] - a[2]) * amount,
    1,
  ];
}

function luminance([r, g, b]: Rgba): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** The OS color scheme, for when the DOM offers no surface to read. */
function systemPrefersDark(): boolean | null {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return null;
  }
}

/**
 * The color the link's text actually paints. On web the host renders the
 * anchor `display: contents; color: inherit` and RN-web paints the real color
 * on inner Text spans, so the anchor's own computed color is the initial
 * black — useless on a dark theme. Prefer a descendant's color that differs
 * from the anchor's own; that divergence marks the styled text.
 */
function displayedColor(anchor: DomElement): Rgba | null {
  const own = parseColor(window.getComputedStyle(anchor).color);
  const nodes = anchor.querySelectorAll("span, code, p, div");
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    if (!node.textContent || !node.textContent.trim()) continue;
    const color = parseColor(window.getComputedStyle(node).color);
    if (color && (own === null || color[0] !== own[0] || color[1] !== own[1] || color[2] !== own[2])) {
      return color;
    }
  }
  return own;
}

function applyPalette(host: DomElement, anchor: DomElement): void {
  const style = window.getComputedStyle(anchor);
  const foreground = displayedColor(anchor) ?? [220, 220, 220, 1];
  let background: Rgba | null = null;
  for (let node: DomElement | null = anchor; node && !background; node = node.parentElement) {
    const color = parseColor(window.getComputedStyle(node).backgroundColor);
    if (color && color[3] > 0.95) background = color;
  }
  // No opaque surface up the chain: follow the OS scheme, and only guess from
  // the link's own color when even that is unavailable.
  background ??=
    (systemPrefersDark() ?? luminance(foreground) > 0.5)
      ? [24, 24, 27, 1]
      : [250, 250, 250, 1];
  const dark = luminance(background) < 0.5;
  const surface = mix(background, foreground, dark ? 0.07 : 0.025);

  const tokens: Array<[string, string]> = [
    ["--lm-fg", css(foreground)],
    ["--lm-muted", css(foreground, 0.62)],
    ["--lm-border", css(foreground, dark ? 0.16 : 0.14)],
    ["--lm-hover", css(foreground, 0.09)],
    ["--lm-bg", css(surface)],
    ["--lm-danger", dark ? "#f87171" : "#dc2626"],
    ["--lm-shadow", dark ? "0 12px 32px rgba(0, 0, 0, 0.5)" : "0 12px 32px rgba(0, 0, 0, 0.16)"],
    ["--lm-font", style.fontFamily || "system-ui, sans-serif"],
  ];
  for (const [name, value] of tokens) host.style.setProperty(name, value);
}

// ---------------------------------------------------------------------------
// The menu

const ICON = {
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v1"/><path d="M3 7h18l-3 14H3z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
} as const;

function svg(paths: string): string {
  return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
.menu {
  min-width: 180px;
  max-width: min(360px, calc(100vw - 16px));
  padding: 4px;
  font-family: var(--lm-font);
  font-size: 13px;
  line-height: 18px;
  color: var(--lm-fg);
  background: var(--lm-bg);
  border: 1px solid var(--lm-border);
  border-radius: 9px;
  box-shadow: var(--lm-shadow);
  user-select: none;
  -webkit-user-select: none;
}
button {
  appearance: none;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  margin: 0;
  padding: 6px 9px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-weight: 500;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}
button:hover:not(:disabled) { background: var(--lm-hover); }
button:disabled { opacity: 0.6; cursor: default; }
button.done { color: var(--lm-muted); }
button.failed { color: var(--lm-danger); }
.status { margin: 4px 9px; font-size: 11.5px; color: var(--lm-muted); white-space: normal; overflow-wrap: anywhere; }
.status.failed { color: var(--lm-danger); }
.addr {
  margin: 2px 4px 3px;
  padding: 5px 7px;
  border-radius: 6px;
  background: var(--lm-hover);
  color: var(--lm-muted);
}
/* Keep padding outside the clamped box so it cannot reveal a third line. */
.addr-text {
  font-size: 11.5px;
  line-height: 15px;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
`;

const MARKUP = `
<style>${STYLE}</style>
<div class="menu" role="menu" aria-label="Link">
  <button data-action="copy">${svg(ICON.link)}<span class="label"></span></button>
  <button data-action="reveal" hidden>${svg(ICON.folder)}<span class="label"></span></button>
  <div class="status" role="status" hidden></div>
  <div class="addr"><div class="addr-text"></div></div>
</div>
`;

const GAP = 8;
const FLASH_MS = 700;

interface Current {
  /** The raw Markdown href, percent-decoded for display and copying. */
  address: string;
  route: WorkspaceRoute | null;
  anchor: DomElement;
  bridge?: DesktopFileBridge;
  revealInput?: RevealInput;
}

function workspaceRoute(): WorkspaceRoute | null {
  const path = window.location.hash.startsWith("#/h/")
    ? window.location.hash.slice(1) : window.location.pathname;
  return parseWorkspaceRoute(path);
}

function sameRoute(left: WorkspaceRoute | null, right: WorkspaceRoute | null): boolean {
  return Boolean(left && right && left.serverId === right.serverId && left.workspaceId === right.workspaceId);
}

async function readWorkspaceDirectory(route: WorkspaceRoute): Promise<string | null> {
  const workspace = getPaseoClient(route.serverId).workspaces.ref(route.workspaceId);
  return workspace.directory ?? (await workspace.refresh())?.workspaceDirectory ?? null;
}

function elementOf(node: DomNode | null): DomElement | null {
  if (!node) return null;
  return node.nodeType === 1 ? (node as DomElement) : node.parentElement;
}

/** The chat link under a contextmenu event, if the event is on one. */
function linkAt(target: DomNode | null, host: DomElement): DomElement | null {
  const element = elementOf(target);
  if (!element || host.contains(element)) return null;
  const anchor = element.closest(ANCHOR);
  if (!anchor || !anchor.getAttribute("href")) return null;
  if (!anchor.closest(CHAT_SCROLL)) return null;
  return anchor;
}

/** A right-press on selected text belongs to the selection, not to the link. */
function selectionCovers(anchor: DomElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  try {
    return selection.getRangeAt(0).intersectsNode(anchor);
  } catch {
    return false;
  }
}

/** One menu per page, even when multiple connected hosts contribute this plugin. */
export function installLinkMenu(): () => void {
  if (Platform.OS !== "web" || typeof document === "undefined") return () => {};
  let installation = document[SHARED];
  if (!installation) {
    const readers = new Map<symbol, DirectoryReader>();
    installation = {
      readers,
      dispose: mountLinkMenu((route) => {
        // Use a live installation's SDK. The first owner's API may have been disposed.
        const readDirectory = Array.from(readers.values()).at(-1);
        return readDirectory ? readDirectory(route) : Promise.resolve(null);
      }),
    };
    document[SHARED] = installation;
  }
  const owner = Symbol();
  installation.readers.set(owner, readWorkspaceDirectory);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    installation.readers.delete(owner);
    if (installation.readers.size === 0) {
      installation.dispose();
      if (document[SHARED] === installation) delete document[SHARED];
    }
  };
}

function mountLinkMenu(readDirectory: DirectoryReader): () => void {
  void warmLocalReveal(window.paseoDesktop).catch(() => {
    // A startup failure is retried by the next menu request, which displays its error.
  });

  const host = document.createElement("div");
  host.setAttribute("data-paseo-link-menu", "");
  for (const [property, value] of [
    ["position", "fixed"],
    ["top", "0"],
    ["left", "0"],
    ["z-index", "2147483000"],
    ["display", "none"],
    ["margin", "0"],
    ["padding", "0"],
  ] as const) {
    host.style.setProperty(property, value, "important");
  }
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = MARKUP;
  const menu = shadow.querySelector(".menu")!;
  const button = shadow.querySelector('[data-action="copy"]') as DomButton;
  const revealButton = shadow.querySelector('[data-action="reveal"]') as DomButton;
  const status = shadow.querySelector(".status")!;
  const addr = shadow.querySelector(".addr-text")!;
  document.body.appendChild(host);

  let open = false;
  let current: Current | null = null;
  let flashTimer = 0;
  let menuPosition = { x: GAP, y: GAP };

  const hide = () => {
    window.clearTimeout(flashTimer);
    open = false;
    current = null;
    host.style.setProperty("display", "none", "important");
  };

  const place = (x: number, y: number) => {
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const left = Math.min(Math.max(x, GAP), Math.max(GAP, window.innerWidth - width - GAP));
    const top = Math.min(Math.max(y, GAP), Math.max(GAP, window.innerHeight - height - GAP));
    host.style.setProperty("left", `${Math.round(left)}px`, "important");
    host.style.setProperty("top", `${Math.round(top)}px`, "important");
  };

  const show = (anchor: DomElement, x: number, y: number) => {
    const raw = anchor.getAttribute("href");
    if (!raw) return;
    window.clearTimeout(flashTimer);
    menuPosition = { x, y };
    const snapshot: Current = { address: displayAddress(raw), route: workspaceRoute(), anchor, bridge: window.paseoDesktop };
    current = snapshot;
    open = true;
    button.disabled = false;
    button.className = "";
    button.innerHTML = `${svg(ICON.link)}<span class="label"></span>`;
    button.querySelector(".label")!.textContent = LABEL.copy;
    status.hidden = true;
    status.className = "status";
    status.textContent = "";
    revealButton.hidden = true;
    revealButton.disabled = true;
    revealButton.className = "";
    revealButton.innerHTML = `${svg(ICON.folder)}<span class="label"></span>`;
    addr.textContent = snapshot.address;
    applyPalette(host, anchor);
    host.style.setProperty("display", "block", "important");
    const target = parseFileLink(raw);
    const bridge = snapshot.bridge;
    if (target && bridge?.editor?.openTarget && bridge.invoke) {
      revealButton.hidden = false;
      revealButton.querySelector(".label")!.textContent = LABEL.checking;
      void prepareLocalReveal({ bridge, route: snapshot.route, target, readDirectory }).then(
        (result) => {
          if (!open || current !== snapshot) return;
          if (!sameRoute(snapshot.route, workspaceRoute())) {
            revealButton.querySelector(".label")!.textContent = LABEL["unknown-workspace"];
          } else if (result.ready) {
            snapshot.revealInput = result.input;
            revealButton.disabled = false;
            revealButton.querySelector(".label")!.textContent = bridge.platform === "win32" ? LABEL.explorer : bridge.platform === "darwin" ? LABEL.finder : LABEL.reveal;
          } else {
            revealButton.querySelector(".label")!.textContent = LABEL.reveal;
            status.hidden = false;
            status.textContent = LABEL[result.reason];
          }
          place(x, y);
        },
        (_error: unknown) => {
          if (!open || current !== snapshot) return;
          revealButton.querySelector(".label")!.textContent = LABEL.unavailable;
          status.hidden = false;
          status.className = "status failed";
          status.textContent = LABEL.checkFailed;
          place(x, y);
        },
      );
    }
    place(x, y);
  };

  const flash = (kind: "done" | "failed") => {
    button.disabled = false;
    button.className = kind;
    button.innerHTML = `${svg(kind === "done" ? ICON.check : ICON.x)}<span class="label"></span>`;
    button.querySelector(".label")!.textContent = kind === "done" ? LABEL.copied : LABEL.failed;
    window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(hide, FLASH_MS);
  };

  const copy = () => {
    if (!current || button.disabled) return;
    const snapshot = current;
    button.disabled = true;
    void copyText(snapshot.address).then(
      () => { if (open && current === snapshot) flash("done"); },
      () => { if (open && current === snapshot) flash("failed"); },
    );
  };

  const reveal = () => {
    const snapshot = current;
    if (!snapshot?.revealInput || !snapshot.bridge?.editor?.openTarget || revealButton.disabled) return;
    if (!sameRoute(snapshot.route, workspaceRoute()) || !document.body.contains(snapshot.anchor)) { hide(); return; }
    window.clearTimeout(flashTimer);
    revealButton.disabled = true;
    revealButton.className = "";
    revealButton.querySelector(".label")!.textContent = LABEL.opening;
    status.hidden = true;
    void snapshot.bridge.editor.openTarget(snapshot.revealInput).then(
      () => {
        if (!open || current !== snapshot) return;
        revealButton.className = "done";
        revealButton.querySelector(".label")!.textContent = LABEL.revealed;
        flashTimer = window.setTimeout(hide, FLASH_MS);
      },
      (error: unknown) => {
        if (!open || current !== snapshot) return;
        revealButton.disabled = false;
        revealButton.className = "failed";
        revealButton.querySelector(".label")!.textContent = LABEL.revealFailed;
        status.className = "status failed";
        status.hidden = false;
        const missingPath = error instanceof Error ? /Path does not exist:\s*(.+)$/.exec(error.message)?.[1] : null;
        status.textContent = missingPath ? LABEL.missing + missingPath : LABEL.openFailed;
        place(menuPosition.x, menuPosition.y);
      },
    );
  };

  const onContextMenu: DomListener = (raw) => {
    const event = raw as DomMouseEvent;
    const anchor = linkAt(event.target, host);
    if (!anchor || selectionCovers(anchor)) return;
    event.preventDefault();
    // Older host copies listen on document. Claim the event in window's capture
    // phase before those copies can open a second menu over this one.
    event.stopImmediatePropagation();
    for (const other of Array.from(document.querySelectorAll(MENU_HOST))) {
      if (other !== host) other.style.setProperty("display", "none", "important");
    }
    show(anchor, event.clientX, event.clientY);
  };

  const onMenuPointerDown: DomListener = (event) => {
    event.preventDefault();
  };
  const onMenuClick: DomListener = (event) => {
    const action = elementOf(event.target)?.closest("button[data-action]")?.getAttribute("data-action");
    if (action === "copy") copy();
    if (action === "reveal") reveal();
  };
  menu.addEventListener("mousedown", onMenuPointerDown);
  menu.addEventListener("click", onMenuClick);

  const onPointerDown: DomListener = (event) => {
    if (!open) return;
    const element = elementOf(event.target);
    if (element && host.contains(element)) return;
    hide();
  };
  const onKeyDown: DomListener = (raw) => {
    const event = raw as DomKeyboardEvent;
    if (!open || event.key !== "Escape") return;
    // The host maps Escape to "interrupt agent"; an open menu swallows it.
    event.preventDefault();
    event.stopPropagation();
    hide();
  };
  const onViewportChange: DomListener = () => {
    if (open) hide();
  };

  window.addEventListener("contextmenu", onContextMenu, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("scroll", onViewportChange, true);
  window.addEventListener("resize", onViewportChange);

  return () => {
    hide();
    window.removeEventListener("contextmenu", onContextMenu, true);
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("scroll", onViewportChange, true);
    window.removeEventListener("resize", onViewportChange);
    menu.removeEventListener("mousedown", onMenuPointerDown);
    menu.removeEventListener("click", onMenuClick);
    host.remove();
  };
}
