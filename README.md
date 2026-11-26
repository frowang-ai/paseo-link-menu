# Paseo Link Menu

Right-click a link in a Paseo chat to copy its underlying address or reveal a local file in your desktop file manager. On Windows, **在资源管理器中显示** / **Show in Explorer** opens the containing folder and selects the file, so you can open videos, presentations, PDFs, and other files with your normal applications. Left-clicking links keeps Paseo's normal behavior.

## Install

Install on the Paseo daemon that owns your workspace:

```sh
paseo plugin add git:frowang-ai/paseo-link-menu
```

Connected desktop and web clients receive the plugin from that host. The runtime plugin ID is `link-menu`. No API keys, backend process, or runtime npm dependencies are required.

The manifest requires Paseo 0.10.1 or later for the existing copy menu. File reveal requires a desktop client with the editor/file-manager bridge; it has been exercised on Windows with Paseo 0.16.2. Older desktop clients without that bridge retain copying. macOS and Linux use the host's file-manager target when available, but have not been exercised on those systems.

## Use

1. Right-click a web link or linked file path inside a chat.
2. Choose **Copy link address** / **复制链接地址** to copy the raw target with percent-escaped characters decoded.
3. For a file on the desktop's local Paseo host, choose **Show in Explorer** / **在资源管理器中显示** (Finder or the system file manager on other platforms).

The file-manager action selects a file in its containing folder; directory links ending in `/` open the directory. Relative links resolve against the current workspace. Windows drive paths, slash-prefixed drive paths, local `file:` URLs, spaces, Unicode, and common line/page markers are handled. Missing paths show an error and allow retry.

Remote-host files are explicitly unavailable for local reveal. Network-share paths and WSL-to-Windows path conversion are not supported. Browser clients keep the copy action because they cannot directly control the system file manager.

The plugin prepares and caches the local desktop identity when it loads, and selects the built-in file manager directly from the operating system. Opening the menu does not enumerate installed editors. The first menu may briefly wait if startup preparation is still running; failed identity queries are retried. Each menu still checks its host, and Paseo checks file existence when you choose Reveal.

Connected hosts can each supply this plugin. Versions 0.2.2 and later share one menu and one context-menu listener per app page; unloading one installation keeps the others working. When an older copy is also loaded, the new listener handles the right-click before that copy can display a second menu. This does not uninstall the plugin from any host.

Click outside the menu or press Escape to dismiss it. Right-clicking selected text keeps the host's selection behavior. Colors follow the surrounding chat, with a system-theme fallback. Labels follow the browser language (Chinese or English).

## Scope and privacy

This plugin supports desktop and browser clients. Native iOS and Android do not provide this DOM-based link menu.

It reads the clicked link and writes its address to your clipboard only when you choose Copy. For local reveal, it checks the desktop daemon identity, reads the selected workspace directory through the existing Paseo connection when needed, and calls Paseo Desktop's file-manager bridge. It has no backend, sends no link contents to external services, and does not persist link contents.

There is no public plugin API for link context menus or local file reveal. The implementation uses Paseo's chat DOM (`agent-chat-scroll` and anchor elements), workspace route, and the desktop preload bridge already used by Paseo's Files panel. Bridge calls are isolated in `client/reveal.ts`, DOM access stays in `client/web.ts`, and unsupported contexts remain unavailable instead of falling back to another machine. Future Paseo DOM, route, or bridge changes may require an update.

## Development

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
paseo plugin install /absolute/path/to/paseo-link-menu
```

After editing source, typecheck and reload the installed plugin:

```sh
npm run typecheck
paseo plugin reload link-menu
```

## Validation

- Typecheck and 12 focused test groups cover parsing, local workspace resolution, remote-host rejection, file-manager selection, startup/concurrent-query reuse, cache isolation, and retries after unavailable identities.
- On an isolated Paseo 0.16.2 desktop window, the real menu and native bridge opened Explorer and selected a fixture whose filename contains Chinese and a space. The selected path was read back through Windows Shell.
- The same desktop probe checked missing-file feedback, remote-host unavailability, relative and line-marked links, the existing web-link copy action, and light/dark menu layouts. Relative-path UI checks used a fixture workspace adapter; the native opener was real.
- After the latency optimization, five warmed right-click samples in the isolated Paseo 0.16.2 desktop fixture took 11–27 ms from context-menu dispatch to an enabled Reveal button. Startup identity preparation took about 1.6 s in that run. These observations are not an OS file-manager launch-time guarantee.
- On the same isolated desktop, the pre-fix app loaded a current and a legacy menu; a real right-click displayed both. After the 0.2.2 reload, only the current menu was visible and its Explorer action was enabled. A browser lifecycle probe also exercised two independent current bundles, duplicate installation from one bundle, both unload orders, idempotent cleanup, and legacy/current load order; copy and reveal each dispatched once.
- Native iOS/Android menus and macOS/Linux file managers were not tested.

MIT licensed. See [LICENSE](LICENSE).
