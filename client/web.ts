import { copyText } from "@getpaseo/plugin/client/react-native";
import { Platform } from "react-native";

/*
 * Right-click a link in a chat, get a menu that copies the address behind it.
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

// ---------------------------------------------------------------------------
// Minimal DOM declarations; the plugin typechecks without the DOM library.

interface DomEvent {
  readonly type: string;
  readonly target: DomNode | null;
  preventDefault(): void;
  stopPropagation(): void;
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
  createElement(tag: "div"): DomElement;
};
declare const navigator: { readonly language: string };

// ---------------------------------------------------------------------------
// Labels

const ZH = navigator.language?.toLowerCase().startsWith("zh") ?? false;
const LABEL = {
  copy: ZH ? "复制链接地址" : "Copy link address",
  copied: ZH ? "已复制" : "Copied",
  failed: ZH ? "复制失败" : "Copy failed",
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
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
} as const;

function svg(paths: string): string {
  return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; }
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
button:hover { background: var(--lm-hover); }
button.done { color: var(--lm-muted); }
button.failed { color: var(--lm-danger); }
.addr {
  margin: 2px 4px 3px;
  padding: 5px 7px;
  border-radius: 6px;
  background: var(--lm-hover);
  color: var(--lm-muted);
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
  <div class="addr"></div>
</div>
`;

const GAP = 8;
const FLASH_MS = 700;

interface Current {
  /** The raw Markdown href, percent-decoded for display and copying. */
  address: string;
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

/** Installs the link menu. Returns cleanup; a no-op off the web. */
export function installLinkMenu(): () => void {
  if (Platform.OS !== "web" || typeof document === "undefined") return () => {};

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
  const addr = shadow.querySelector(".addr")!;
  document.body.appendChild(host);

  let open = false;
  let current: Current | null = null;
  let flashTimer = 0;

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
    current = { address: displayAddress(raw) };
    open = true;
    button.className = "";
    button.innerHTML = `${svg(ICON.link)}<span class="label"></span>`;
    button.querySelector(".label")!.textContent = LABEL.copy;
    addr.textContent = current.address;
    applyPalette(host, anchor);
    host.style.setProperty("display", "block", "important");
    place(x, y);
  };

  const flash = (kind: "done" | "failed") => {
    button.className = kind;
    button.innerHTML = `${svg(kind === "done" ? ICON.check : ICON.x)}<span class="label"></span>`;
    button.querySelector(".label")!.textContent = kind === "done" ? LABEL.copied : LABEL.failed;
    window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(hide, FLASH_MS);
  };

  const copy = () => {
    if (!current) return;
    const address = current.address;
    void copyText(address).then(
      () => flash("done"),
      () => flash("failed"),
    );
  };

  const onContextMenu: DomListener = (raw) => {
    const event = raw as DomMouseEvent;
    const anchor = linkAt(event.target, host);
    if (!anchor || selectionCovers(anchor)) return;
    event.preventDefault();
    event.stopPropagation();
    show(anchor, event.clientX, event.clientY);
  };

  const onMenuPointerDown: DomListener = (event) => {
    event.preventDefault();
  };
  const onMenuClick: DomListener = (event) => {
    if (elementOf(event.target)?.closest('[data-action="copy"]')) copy();
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

  document.addEventListener("contextmenu", onContextMenu, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("scroll", onViewportChange, true);
  window.addEventListener("resize", onViewportChange);

  return () => {
    window.clearTimeout(flashTimer);
    document.removeEventListener("contextmenu", onContextMenu, true);
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("scroll", onViewportChange, true);
    window.removeEventListener("resize", onViewportChange);
    menu.removeEventListener("mousedown", onMenuPointerDown);
    menu.removeEventListener("click", onMenuClick);
    host.remove();
  };
}
