Link Menu adds a right-click action to links and file paths inside Paseo chats. Choose Copy link address to copy the underlying target with percent-escaped characters decoded, rather than the browser-resolved URL.

The menu follows the surrounding theme and uses Chinese or English labels. It supports desktop and browser clients; native iOS and Android do not provide this menu. The manifest requires Paseo 0.10.1 or later, and this checkout has been used with Paseo 0.11.4.

There is no backend, API key, or runtime dependency setup. The plugin reads the clicked link and writes its address to the clipboard when you select Copy. It makes no network requests and does not save link contents. It relies on the host chat DOM, so future Paseo layout changes may require an update.
