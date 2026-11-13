# Mearl Firefox Provider

[简体中文](./README.md) | [English](./README.en.md)

Attach to a running desktop Firefox via WebDriver BiDi. Firefox must already be listening on a local BiDi port. If the running instance was started without one, quit it and start it with `--remote-debugging-port`. See the [Firefox Remote Agent documentation](https://firefox-source-docs.mozilla.org/remote/Security.html). No browser extension is required.

```bash
# Install and register the optional Provider once its package is published.
npx @mearl/setup provider install @mearl/provider-firefox

# Use the actual Firefox executable; add --profile <directory> for a separate instance.
firefox --remote-debugging-port 9223

mearl browser_manage --local --payload '{"operation":"attach","provider":"firefox","providerOptions":{"port":9223}}'
mearl tab_list --local --browser '<browserId>'
mearl page_screenshot --local --browser '<browserId>' --payload '{"tabId":123}' --output firefox.png
mearl browser_manage --local --browser '<browserId>' --payload '{"operation":"detach"}'
```

Replace the example values with the `browserId` from attach and the `tabId` from `tab_list`. Page actions use the same payloads as Chrome CDP: tabs, navigation, snapshots and `@eN` refs, click, hover, drag, type, press, scroll, eval (including an isolated sandbox), wait, inspect, upload, viewport or full-page screenshots (`captureMode: "cdp"`), plus cookies, timezone, viewport device emulation, requests and logs, tracking events, mocks, request-header rules, WebMCP, native dialogs, and `run_actions`. Use `get_capabilities` to check the available actions. Firefox does not provide App profiles or device shells, nor tab groups, downloads, recordings, or extension permissions. A device shell replaces the top document and then delivers that same original response to the inner WebView. BiDi can replace a response only before its body arrives, so the original body is discarded and cannot be handed to the frame once. App profiles also intercept custom schemes and protocol streams, which BiDi does not expose.

`detach` ends the BiDi session created by Mearl and preserves the Firefox process, tabs, and page state. If a Mearl control session is active, end it with `session_manage end` first. Look up tab IDs again after reattaching. A Firefox instance accepts one BiDi session at a time; have any other client end its session before attaching. Tested with Firefox 153.0.3.

If the BiDi connection drops unexpectedly and Firefox still reports an active session, you may need to restart that Firefox instance before reattaching.
