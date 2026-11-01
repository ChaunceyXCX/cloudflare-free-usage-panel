# 打赏二维码 / Donation QR codes

这里放两条收款码，README 会自动引用同名文件：

| 文件 | 用途 |
|---|---|
| `wechat.png` | 微信赞赏码 / WeChat Pay QR |
| `alipay.png` | 支付宝收款码 / Alipay QR |

## 替换步骤

1. 微信：我 → 服务 → 收付款 → 赞赏码，保存图片；支付宝：收付款 → 收款码，保存图片。
2. 把图片重命名成 `wechat.png` / `alipay.png`，覆盖本目录下的占位图（建议裁成正方形，≥ 400×400）。
3. PayPal 已接好：托管按钮（Hosted Buttons）在 `docs/donate.html`，直达链接是
   `https://www.paypal.com/ncp/payment/3EL6CKZ57Y8NE`（README 里的徽章也指向它）。
   若以后换了收款按钮，记得同步改这三处：`docs/donate.html`、`README.md`、`README.en.md`。
   `client-id` 与 `hosted-button-id` 都是公开标识，可以放在公开仓库；**绝不要**提交 client secret。
4. 提交：`git add assets/donate && git commit -m "docs: 更新打赏二维码" && git push`。

> 当前两张图是脚本生成的**占位图**（灰底 + “PLACEHOLDER” 字样），扫不出任何东西，替换前不用担心误导访客。
