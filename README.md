# Paseo Link Menu

Right-click a link in a Paseo chat to copy its underlying address or file path. The menu uses the raw link target rather than a browser-resolved URL, and decodes percent-escaped characters for copying.

## Install

Install on the Paseo daemon that owns your workspace:

```sh
paseo plugin add git:frowang-ai/paseo-link-menu
```

Connected desktop and web clients receive the plugin from that host. The runtime plugin ID is `link-menu`. No API keys, backend process, or runtime npm dependencies are required.

The manifest requires Paseo 0.10.1 or later. This checkout has been typechecked and used with Paseo 0.11.4; newer client versions have not been separately verified.

## Use

1. Right-click a web link or linked file path inside a chat.
2. Select **Copy link address** / **复制链接地址**.
3. The menu briefly shows whether copying succeeded.

Click outside the menu or press Escape to dismiss it. Right-clicking selected text keeps the host's selection behavior. Colors follow the surrounding chat, with a system-theme fallback. Labels follow the browser language (Chinese or English).

## Scope and privacy

This plugin supports desktop and browser clients. Native iOS and Android do not provide this DOM-based link menu.

It reads the clicked chat link and writes its address to your clipboard when you choose Copy. It has no backend, makes no network requests, and does not persist link contents.

The implementation relies on Paseo's chat DOM (`agent-chat-scroll` and anchor elements), because Paseo has no public link-context-menu API. Host DOM changes may require an update.

## Development

```sh
npm ci --ignore-scripts
npm run typecheck
paseo plugin install /absolute/path/to/paseo-link-menu
```

After editing source, typecheck and reload the installed plugin:

```sh
npm run typecheck
paseo plugin reload link-menu
```

MIT licensed. See [LICENSE](LICENSE).
