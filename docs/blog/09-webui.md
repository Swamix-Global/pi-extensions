> **Published article:** [Read this guide on swamix.com](https://swamix.com/blog/pi-web-ui-local/).

![A laptop and notebook in a calm workspace](https://raw.githubusercontent.com/Swamix-Global/pi-extensions/main/docs/assets/swamix-webui.jpg)

# A local browser interface for Pi sessions

### Exploring the Pi Web UI module

Sometimes a terminal is ideal. Sometimes you want a browser tab for inspecting a session, attaching to an engine, and following events. The Pi Web UI module explores that second workflow with a local Bun-based server and Pi RPC integration.

## What the local module does

The implementation includes endpoints for listing and searching sessions, attaching to or starting an engine, inspecting and closing engines, and accessing workspace files. A browser can connect to an engine over WebSocket to receive session state and events and send supported Pi RPC commands.

For developers who already have access to a checkout of the module, its package defines these commands to run from the module directory:

```sh
bun run start
bun run check
bun run test
```

Its default bind address is loopback on port 3030; `PI_WEBUI_HOST` and `PI_WEBUI_PORT` can change it. These are source-declared commands, not a claim that a fresh deployment has been tested on every platform.

## Security comes before convenience

The server can access Pi sessions, files, and engines with the server user's permissions. Authentication is optional in the inspected implementation: if `PI_WEBUI_TOKEN` is unset, requests are allowed without a token. Keep it on loopback, review the code and your environment, and do not expose it as a public or multi-user service without appropriate authentication, isolation, and security review. A token in a URL can also leak through browser history or logs.

## Availability

This article describes a **local module**, not a generally available public release. No public repository or one-command public installation is linked here. If you want a browser-based interface for your Pi or agent workflow, get in touch to discuss availability and a custom implementation.

---

**Build a safer, more usable interface for your AI workflow.** [Email Nikhil](mailto:nikhil@swamix.com?subject=Pi%20Web%20UI%20custom%20implementation) at Swamix Global AI Solutions · [swamix.com](https://swamix.com)
