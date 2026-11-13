# Mearl Firefox Provider

[简体中文](./README.md) | [English](./README.en.md)

Attach to a running desktop Firefox through WebDriver BiDi. No browser extension is required.

Page actions use the same payloads as Chrome CDP. Use `get_capabilities` for the actions this Provider actually implements.

## Get started

Firefox must already be listening on a local BiDi port. If the running instance was started without one, quit it and start it with `--remote-debugging-port`. See the [Firefox Remote Agent documentation](https://firefox-source-docs.mozilla.org/remote/Security.html). Requires **Node.js ≥ 20.18.0**. Tested with Firefox 153.0.3.

Install the Provider and attach:

```bash
npx @mearl/setup provider install @mearl/provider-firefox

# Add --profile <directory> for a separate instance.
firefox --remote-debugging-port 9223

mearl browser_manage --local --payload '{"operation":"attach","provider":"firefox","providerOptions":{"port":9223}}'
```

Save the returned `browserId`. Later commands use the `tabId` from `tab_list`:

```bash
mearl tab_list --local --browser '<browserId>'
mearl page_screenshot --local --browser '<browserId>' --payload '{"tabId":123}' --output firefox.png
mearl browser_manage --local --browser '<browserId>' --payload '{"operation":"detach"}'
```

## Capabilities

- Tabs, navigation, snapshots, and `@eN` refs
- Click, hover, drag, type, press, and scroll
- Eval, including an isolated sandbox, plus wait, inspect, and upload
- Viewport screenshots; `captureMode: "cdp"` captures the full page
- Cookies, timezone, and viewport device emulation
- Requests, logs, tracking events, mocks, and request-header rules
- WebMCP, native dialogs, and `run_actions`

## Unavailable

- App profiles and device shells
- Tab groups, downloads, recordings, and extension permissions

A device shell replaces the top document and then delivers that same original response to the inner WebView. BiDi can replace a response only before its body arrives, so the original body is discarded. App profiles also intercept custom schemes and protocol streams, which BiDi does not expose.

## Sessions

`detach` ends only the BiDi session created by Mearl. The Firefox process, tabs, and page state stay open. If a Mearl control session is active, end it with `session_manage end` first. Look up tab IDs again after reattaching.

A Firefox instance accepts one BiDi session at a time. Have any other client end its session before attaching. If the connection drops and Firefox still reports an active session, restart that instance before reattaching.

## Development

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Source is licensed under Apache-2.0.
