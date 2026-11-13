# Mearl Firefox Provider

[简体中文](./README.md) | [English](./README.en.md)

用 WebDriver BiDi 接入已经运行的桌面 Firefox。无需浏览器扩展。

页面动作与 Chrome CDP 使用同一套参数。可用范围以 `get_capabilities` 为准。

## 开始使用

Firefox 需要先开放本机 BiDi 端口。当前实例没有启用时，先退出，再用 `--remote-debugging-port` 启动。参见 [Firefox Remote Agent 文档](https://firefox-source-docs.mozilla.org/remote/Security.html)。需要 **Node.js ≥ 20.18.0**。已在 Firefox 153.0.3 验证。

安装并接入：

```bash
npx @mearl/setup provider install @mearl/provider-firefox

# 也可加 --profile <目录>，使用独立配置
firefox --remote-debugging-port 9223

mearl browser_manage --local --payload '{"operation":"attach","provider":"firefox","providerOptions":{"port":9223}}'
```

保存返回的 `browserId`。后续命令使用 `tab_list` 返回的 `tabId`：

```bash
mearl tab_list --local --browser '<browserId>'
mearl page_screenshot --local --browser '<browserId>' --payload '{"tabId":123}' --output firefox.png
mearl browser_manage --local --browser '<browserId>' --payload '{"operation":"detach"}'
```

## 能力

- 标签、导航、快照与 `@eN` 引用
- 点击、悬停、拖拽、输入、按键、滚动
- 求值（含隔离 sandbox）、等待、检查、上传
- 视口截图；`captureMode: "cdp"` 为整页截图
- Cookie、时区、视口设备模拟
- 请求与日志、埋点、Mock、请求头规则
- WebMCP、原生对话框、`run_actions`

## 不支持

- App 容器、设备外壳
- 标签分组、下载、录屏、扩展权限

设备壳要把主文档换成外壳，再把同一次原始响应交给里面的 WebView。BiDi 只能在正文到达前替换响应，替换后原始正文就没了。App 容器还要拦截自定义 scheme 和协议流，BiDi 没有这条通道。

## 会话

`detach` 只结束 Mearl 建立的 BiDi 会话，保留 Firefox 进程、标签页和页面状态。有活动的 Mearl 控制会话时，先用 `session_manage end` 结束任务会话。重连后重新查询标签页 ID。

同一个 Firefox 实例一次只能有一个 BiDi 会话。其他工具正在使用时，先让其正常断开。连接异常中断且 Firefox 仍报告会话被占用时，可能需要重启该实例才能重新接入。

## 开发

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

源码采用 Apache-2.0 许可证。
