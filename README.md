# Mearl Firefox Provider

[简体中文](./README.md) | [English](./README.en.md)

用 WebDriver BiDi 接入已经运行的桌面 Firefox。Firefox 需要先开放本机 BiDi 端口；如果当前实例没有启用，先退出该实例，再用 `--remote-debugging-port` 启动。参见 [Firefox Remote Agent 文档](https://firefox-source-docs.mozilla.org/remote/Security.html)。无需浏览器扩展。

```bash
# 安装并注册可选 Provider（包发布后可用）
npx @mearl/setup provider install @mearl/provider-firefox

# 用实际的 Firefox 可执行文件；也可给独立实例指定 --profile <目录>
firefox --remote-debugging-port 9223

mearl browser_manage --local --payload '{"operation":"attach","provider":"firefox","providerOptions":{"port":9223}}'
mearl tab_list --local --browser '<browserId>'
mearl page_screenshot --local --browser '<browserId>' --payload '{"tabId":123}' --output firefox.png
mearl browser_manage --local --browser '<browserId>' --payload '{"operation":"detach"}'
```

用接入响应的 `browserId` 和 `tab_list` 返回的 `tabId` 替换示例值。页面动作与 Chrome CDP 使用同一套参数：标签、导航、快照与 `@eN` 引用、点击、悬停、拖拽、输入、按键、滚动、求值（含隔离 sandbox）、等待、检查、上传、视口或整页截图（`captureMode: "cdp"`）、Cookie、时区、视口设备模拟、请求与日志、埋点、Mock、请求头规则、WebMCP、原生对话框和 `run_actions`。`get_capabilities` 返回当前可用动作。Firefox 不提供 App 容器和设备外壳，也不提供标签分组、下载、录屏和扩展权限。设备壳要把主文档换成外壳，并把同一次原始响应交给里面的 WebView；BiDi 只能在正文到达前替换响应，替换后原始正文就没了，不能按 CDP 的方式做一次性交付。App 容器还要拦截自定义 scheme 和协议流，BiDi 没有这条通道。

`detach` 结束 Mearl 建立的 BiDi 会话，保留 Firefox 进程、标签页和页面状态。有活动的 Mearl 控制会话时，先用 `session_manage end` 结束任务会话。重连后重新查询标签页 ID。同一个 Firefox 实例一次只能有一个 BiDi 会话，其他工具正在使用时请先让其正常断开。Firefox 153.0.3 已通过实测。

如果 BiDi 连接异常中断且 Firefox 仍报告会话被占用，可能需要重启该 Firefox 实例才能重新接入。
