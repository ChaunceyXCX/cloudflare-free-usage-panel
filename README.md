# Cloudflare 免费额度用量面板（油猴脚本）

`v1.3.0` · Tampermonkey / Violentmonkey

在 `dash.cloudflare.com` 上注入一个悬浮面板，用进度条直观显示免费账号各产品的**已用量 / 免费额度 / 百分比**。

右下角橙色「CF」按钮，或快捷键 `Alt + U`。

- **悬浮球可拖**：按住任意拖动，松手后坐标落盘（拖动不会误触发展开）。
- **面板可拖**：按住标题栏拖动（标题栏上的按钮不受影响），位置同样持久化。
- **重置位置**：设置 → 「重置位置」，回到默认右下角。

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)（Violentmonkey 亦可）。
2. 新建脚本 → 粘贴 `cf-free-usage-panel.user.js` 全部内容 → `Ctrl+S` 保存。
3. 打开 <https://dash.cloudflare.com>，点右下角「CF」。

## 支持的指标

| 分区 | 指标 | 免费额度 |
|---|---|---|
| 每日（UTC 重置） | Workers 请求 | 100k / 天 |
| | KV 读取 | 100k / 天 |
| | KV 写入 + 删除 + 列表 | 1k / 天 |
| | D1 行读取 | 5M / 天 |
| | D1 行写入 | 100k / 天 |
| | Durable Objects 请求 | 100k / 天 |
| | Queues 操作 | 10k / 天 |
| | Workers AI Neurons | 10k / 天 |
| 每月 | R2 Class A 操作 | 1M / 月 |
| | R2 Class B 操作 | 10M / 月 |
| 存储 | KV 存储 | 1 GB |
| | D1 存储（账号总量） | 5 GB |
| | R2 存储 | 10 GB |

额度数值取自 <https://www.cloudflare.com/plans> 的 Free Tier Summary。官方调整后改文件顶部 `LIMITS` 即可。

## 数据来源 / 两种模式

面板读取的是控制台图表背后的 **GraphQL Analytics API**（账号级 dataset），不抓 HTML、不截图、不经过任何第三方服务器。

- **会话模式（默认，零配置）**：复用当前浏览器已登录的控制台 Cookie，同源 POST `https://dash.cloudflare.com/api/v4/graphql`（同源 + `XSRF-TOKEN` → `X-CSRF-Token`）。
  为降低被风控拦下的概率：10 个 dataset 合并成 **2 个 GraphQL 文档**（用 alias 一次问一组）、403 只做一次 700ms 退避重试、**绝不用扩展请求兜底**（GM 请求必被 WAF 挡，只会刷出成片 403）。
- **Token 模式（备用，最稳）**：在「设置」里粘贴一个只读令牌，权限只需 `Account Analytics : Read`。脚本用 `GM_xmlhttpRequest` 直连 `api.cloudflare.com`（绕过页面 CSP），令牌仅保存在本机油猴存储。
  生成路径：控制台右上角头像 → 我的资料 → API 令牌 → 创建令牌 → 自定义令牌 → 权限选 `Account` / `Account Analytics` / `Read` → 作用范围选你的账号（或 All accounts）。

## 设计要点

- **每轮只 2 个请求**：10 个 dataset 按过滤器类型分组，用 GraphQL alias 合并成 2 个文档，逐个 alias 判定成败 —— 单块失败只影响自己那几行（灰色「未取到」+ 悬停原因）。
- **合并失败自动降级**：某个字段在你账号的 schema 上不存在会导致整文档校验失败，此时自动退化为逐项查询，并把坏变体记住（下次合并直接用对的变体），请求数随即回到 2。
- **403 处理**：只做一次 700ms 退避重试；仍失败即判定被风控，立刻停止本轮剩余请求（不刷屏），并**保留上次成功的数据**，只在元信息里标注「刷新失败，展示上次数据」。
- **诊断区**：设置页底部汇总版本、模式、请求数、成功指标与失败任务，可一键复制。
- **多套查询变体自动降级**：字段名在不同账号 schema 上略有差异（例如 D1 的 `rowsRead`、Workers AI 的 `totalNeurons`），前一变体失败自动换下一个，成功的变体被记住，下一轮直接用它（请求数从 11 降到 10）。降级口径会带 `*` 标记为近似值。
- **进度条视觉分档**：< 70% 绿色 / ≥ 70% 琥珀色 / ≥ 90% 红色并呼吸闪烁；超额度时进度条裁剪在 100% 但百分比照实显示 104% 这类数字。
- **本地快照**：结果缓存到油猴存储，重开页面秒开显示上次数据，并标注更新时间。
- **自动刷新**：默认 5 分钟（设置里 1–30 分钟），面板收起时不发请求，2 秒内重复触发会被防抖丢弃。
- **Shadow DOM 隔离**：与 Cloudflare 控制台样式互不干扰。

## 已知限制

- 存储类指标取的是「近期峰值占用」（KV/D1 取近 2 天 `max`，R2 取近 24 小时 `max(payloadSize+metadataSize)`），与控制台按平均值展示的 GB-month 口径略有差异。
- R2 Class A/B 是本地按 `actionType` 归类的近似结果（`Put/List/Copy/Delete/Create/Upload` → A，`Get/Head` → B），带 `*`。
- Pages 构建次数、Images 转换次数、Vectorize 维度等目前**没有稳定的账号级 GraphQL dataset**，未纳入面板。
- 会话模式偶发 403 属控制台风控（尤其短时间连续刷新时），再点一次刷新通常就恢复；持续失败请改用 Token 模式 —— 脚本不会去绕过 Cloudflare 的 CSRF/风控策略。

## 开发 / 测试

```bash
node --check cf-free-usage-panel.user.js   # 语法检查
node test.mjs                              # 采集层单测（打桩 fetch）
node test-dom.mjs                          # jsdom UI 冒烟测试
```

`__CFU__` 暴露了 `JOBS / LIMITS / buildCtx / collect / gql / fmt` 等内部能力，方便在浏览器控制台调试。
