# 打赏二维码 / Donation QR codes

这里放两条收款码，README 会自动引用同名文件：

| 文件 | 用途 |
|---|---|
| `wechat.png` | 微信赞赏码 / WeChat Pay QR |
| `alipay.png` | 支付宝收款码 / Alipay QR |

## 替换步骤

1. 微信：我 → 服务 → 收付款 → 赞赏码，保存图片；支付宝：收付款 → 收款码，保存图片。
2. 把图片重命名成 `wechat.png` / `alipay.png`，覆盖本目录下的占位图（建议裁成正方形，≥ 400×400）。
3. PayPal 链接在 `README.md` / `README.en.md` 里搜 `paypal.me` 替换成你的 PayPal.Me 用户名。
4. 提交：`git add assets/donate && git commit -m "docs: 更新打赏二维码" && git push`。

> 当前两张图是脚本生成的**占位图**（灰底 + “PLACEHOLDER” 字样），扫不出任何东西，替换前不用担心误导访客。
