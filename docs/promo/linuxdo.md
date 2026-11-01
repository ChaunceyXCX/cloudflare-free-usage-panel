# linux.do 推广文案（草稿）

> 仓库：https://github.com/ChaunceyXCX/cloudflare-free-usage-panel
> 打赏页（论坛帖里**不要**放，只在仓库里保留）：https://chaunceyxcx.github.io/cloudflare-free-usage-panel/docs/donate.html

## 标题备选

1. 【自荐】写了个油猴脚本：在 Cloudflare 控制台一眼看清免费额度还剩多少
2. 免费 Worker 又跑满了？给控制台加了个 13 项额度的进度条看板
3. 受够了翻 Cloudflare 账单页：做了个免费额度实时看板（开源 / 无后端）
4. 【开源】Cloudflare 免费额度面板 · 油猴脚本 · 中英双语 · 每轮只 2 个请求
5. 给 dash.cloudflare.com 挂了个「CF」悬浮球，免费额度一目了然

---

## 主帖正文（长版）

**先说结论**：一个油猴脚本，在 Cloudflare 控制台右下角挂个悬浮球，点开就是 13 项免费额度的进度条。零配置，不抓 HTML，不截图，没有后端。

### 为什么要做这个

免费账号跑 Workers / Pages / KV / D1 / R2 的人应该都遇到过这两种情况：

- 早上发现 Worker 突然不响应了，翻半天才想起来是 **100k 请求/天**跑满了；
- 想确认 KV 今天写了多少、R2 这个月 Class A 用了几成，得去 Billing 页面按结算口径算，还不一定对得上。

这些数字其实**控制台的图表里都有**，只是分散在几个页面、要切来切去。于是我把它们抓成了一个面板。

### 它长什么样

右下角一个橙色「CF」悬浮球（可以拖），点开后：

- 13 行进度条：`< 70%` 绿 / `≥ 70%` 琥珀 / `≥ 90%` 红色呼吸闪烁
- 超过额度时进度条裁到 100%，但百分比照实显示（比如 104%），不会假装没事
- 悬停任意一行看「已用 / 额度 / 剩余」
- 每日额度、每月额度、存储占用三个分区，标注 UTC 重置时间
- 悬浮球和面板都能拖，位置记住；`Alt + U` 快捷开关
- 界面中英双语，设置里即时切换

【图1：面板展开的截图】
【图2：某个指标接近 90% 的红色状态】

### 数据是怎么拿的（技术部分）

走的是控制台图表背后那套 **GraphQL Analytics API**（账号级 dataset），不解析 HTML、不截图：

```graphql
{ viewer { accounts(filter:{accountTag:"<account-id>"}) {
  a0: kvOperationsAdaptiveGroups(limit:100, filter:{date_geq:"2026-11-01", date_leq:"2026-11-01"}) {
    dimensions { actionType } sum { requests }
  }
} } }
```

踩过的几个坑，顺手记一下：

1. **别一次一个请求**。10 个 dataset 各发一次 = 11 个并发请求，控制台的风控会随机甩 403。现在按过滤器类型（`date` / `datetime`）分组，用 GraphQL `alias` 合并成 **2 个文档**，一轮就 2 个请求。
2. **alias 级容错**。合并文档里某个字段在你账号的 schema 上不存在，整个文档会校验失败、一个数据都拿不到。所以逐个 alias 判成败，失败的那几行单独灰掉。
3. **字段名不统一**。D1 有的账号只有 `readQueries/writeQueries`，没有 `rowsRead/rowsWritten`；Workers AI 有 `totalNeurons` 和 `neurons` 两种写法。所以每个指标准备了多个查询变体，前一个失败自动换下一个，**并把能用的变体记住**，下一轮直接用它（请求数从 8 降到 2）。
4. **403 是风控不是鉴权**。只有 401 / 令牌错误才算鉴权失败；403 当节流处理，退避 700ms 重试一次，还失败就立刻停掉这轮，别把剩下的 20 个请求全打出去。
5. **刷新失败别清空面板**。全灭了就保留上一次的数据，只在元信息里写「刷新失败，展示上次数据」，比一片灰有用得多。
6. **用扩展请求兜底是错的**。`GM_xmlhttpRequest` 打的同源请求会被 WAF 一律判 403，控制台瞬间一片红。现在只走同源 `fetch`。

### 覆盖的 13 项与免费额度

| 分区 | 指标 | 免费额度 |
|---|---|---|
| 每日 | Workers 请求 | 100k / 天 |
| 每日 | KV 读取 | 100k / 天 |
| 每日 | KV 写入+删除+列表 | 1k / 天 |
| 每日 | D1 行读取 | 5M / 天 |
| 每日 | D1 行写入 | 100k / 天 |
| 每日 | Durable Objects 请求 | 100k / 天 |
| 每日 | Queues 操作 | 10k / 天 |
| 每日 | Workers AI Neurons | 10k / 天 |
| 每月 | R2 Class A 操作 | 1M / 月 |
| 每月 | R2 Class B 操作 | 10M / 月 |
| 存储 | KV / D1 / R2 | 1 GB / 5 GB / 10 GB-month |

额度取自 <https://www.cloudflare.com/plans> 的 Free Tier Summary，官方改了改脚本顶部 `LIMITS` 就行。

### 安装

1. 装 Tampermonkey（Violentmonkey 也能用）
2. 打开仓库里的 `cf-free-usage-panel.user.js`，全文复制到新建脚本，`Ctrl+S`
3. 打开 <https://dash.cloudflare.com>，点右下角「CF」

仓库：https://github.com/ChaunceyXCX/cloudflare-free-usage-panel

### 关于安全（估计有人要问）

- **没有后端、没有遥测、没有统计上报**，所有请求只发往 `dash.cloudflare.com` 或 `api.cloudflare.com`
- 只做**读取**，不调用任何写接口，不改账号设置
- 只读 `XSRF-TOKEN` 这一个 cookie 用于请求头，其它 cookie 不碰
- 默认的会话模式复用你的控制台登录态，所以**不需要**给它任何令牌；如果你介意，可以在设置里换成只读 API Token 模式（只需 `Account Analytics : Read`），令牌只存本地油猴存储
- 脚本是**单文件明文**，没有混淆，几百行，欢迎直接审

### 已知限制（说在前面）

- 存储类指标取的是**近期峰值**（KV/D1 近 2 天 `max`，R2 近 24h `max(payload+metadata)`），跟账单页的 GB-month 平均口径不完全一致，适合看趋势不适合对账
- R2 的 Class A/B 是本地按 `actionType` 推断的近似归类（带 `*` 标记）
- Pages 构建次数、Images 转换、Vectorize 维度、Hyperdrive 查询这些目前没有稳定的账号级 dataset，**没做**
- 会话模式偶发 403 是控制台风控，再点一次刷新就好；持续失败请用 Token 模式

### 有问题

直接在楼下回复或去仓库提 Issue，附上设置页「诊断信息」里的内容最快（版本、模式、请求数、失败任务都在里面）。

觉得有用点个 Star 就行，别的不需要 🙂

---

## 短版（时间线 / 回复别人时用）

> 顺手做了个油猴脚本，在 Cloudflare 控制台右下角挂个球，点开是 13 项免费额度的进度条（Workers / KV / D1 / R2 / Queues / DO / Workers AI），每日每月存储分开，超 90% 变红。零配置复用登录态，无后端、只读、单文件明文可审，每轮只发 2 个合并后的 GraphQL 请求。
> https://github.com/ChaunceyXCX/cloudflare-free-usage-panel

---

## 楼里可能会问的（可以提前回）

**Q：和官方 Billing 页 / 用量页有什么区别？**
Billing 按结算口径算（GB-month 平均、Queues 按 64KB 分块、采样），本脚本直读 analytics dataset，是实时近似值，用来提前预警。数字不一致是正常的。

**Q：会不会偷我的 Cookie / 账号密码？**
不碰密码，只读 `XSRF-TOKEN` 拼请求头，代码明文，可以 `Ctrl+F` 搜 `cookie` 看全貌。介意就切 Token 模式，权限只给 `Account Analytics : Read`。

**Q：为什么不用 API Token 做默认？**
零配置是核心体验。Token 要手动建、还要管权限，会话模式开箱可用；被风控拦的时候面板会直接提示切 Token。

**Q：能加 Pages 构建数 / Images 吗？**
目前没有稳定的账号级 dataset，硬做只能抓 HTML，一改版就废，所以没做。有 dataset 名的话欢迎告诉我。

**Q：403 一片红怎么办？**
更新到 v1.4.0 之后不会再一片红：合并成 2 个请求 + 403 只重试一次 + 失败保留上次数据。还是不行就切 Token 模式。

---

## 发布注意

- 发在「**资源分享 / 开发调优**」这类技术板块，别发多个板块重复推，也**不要**私信拉 Star
- 标题朴实一点，linux.do 对标题党反感，`【自荐】`/`【开源】` 这类前缀够用
- 图自己截：面板展开图 + 一张接近 90% 的红色状态图，比纯文字有效得多
- **打赏页/收款码不要放帖子里**，论坛不喜欢这种；仓库 README 里保留就够
- 首楼自己补一条「已知限制」和「安全说明」，能挡掉一半质疑
- 发完自己盯两小时，问题当场回，帖子热度主要靠这个
