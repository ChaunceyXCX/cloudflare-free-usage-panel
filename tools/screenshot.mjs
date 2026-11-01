// 生成 README 用的界面截图: node tools/screenshot.mjs
// 用本机 Chrome 无头渲染「真实脚本 + 打桩数据」，输出到 docs/preview/
// 注意：截图里的数字是演示数据，不是真实账号用量。
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'preview');
const SCRIPT = path.join(ROOT, 'cf-free-usage-panel.user.js');
const ACC = '0123456789abcdef0123456789abcdef';
const ACCOUNT_NAME = "demo@example.com's Account";

/* ---------- 演示数据 ---------- */
const MB = 1024 ** 2;
const GB = 1024 ** 3;
const rows = {
  workersInvocationsAdaptive: [{ sum: { requests: 61_240 } }],
  kvOperationsAdaptiveGroups: [
    { dimensions: { actionType: 'read' }, sum: { requests: 88_906 } },
    { dimensions: { actionType: 'write' }, sum: { requests: 906 } },
    { dimensions: { actionType: 'list' }, sum: { requests: 34 } },
  ],
  d1AnalyticsAdaptiveGroups: [{ sum: { rowsRead: 1_240_000, rowsWritten: 12_400 } }],
  durableObjectsInvocationsAdaptiveGroups: [{ sum: { requests: 4_120 } }],
  queueMessageOperationsAdaptiveGroups: [{ count: 8_900 }],
  aiInferenceAdaptiveGroups: [{ sum: { totalNeurons: 5_210 } }],
  r2OperationsAdaptiveGroups: [
    { dimensions: { actionType: 'PutObject' }, sum: { requests: 180_000 } },
    { dimensions: { actionType: 'CopyObject' }, sum: { requests: 30_000 } },
    { dimensions: { actionType: 'ListObjects' }, sum: { requests: 12_000 } },
    { dimensions: { actionType: 'DeleteObject' }, sum: { requests: 106_000 } },
    { dimensions: { actionType: 'GetObject' }, sum: { requests: 9_200_000 } },
    { dimensions: { actionType: 'HeadObject' }, sum: { requests: 440_000 } },
  ],
  kvStorageAdaptiveGroups: [{ max: { byteCount: 486 * MB } }],
  d1StorageAdaptiveGroups: [{ max: { databaseSizeBytes: 1.12 * GB } }],
  r2StorageAdaptiveGroups: [{ max: { payloadSize: 6.5 * GB, metadataSize: 40 * MB } }],
};

function serve(query) {
  const aliased = [...query.matchAll(/\b(a\d+):\s*([A-Za-z][A-Za-z0-9]+)\s*\(/g)]
    .map((m) => ({ alias: m[1], dataset: m[2] }));
  if (aliased.length) {
    const account = {};
    for (const { alias, dataset } of aliased) account[alias] = rows[dataset] || [];
    return { data: { viewer: { accounts: [account] } }, errors: [] };
  }
  const dataset = Object.keys(rows).find((d) => query.includes(d));
  if (!dataset) return { data: null, errors: [{ message: 'no such dataset' }] };
  return { data: { viewer: { accounts: [{ [dataset]: rows[dataset] }] } }, errors: [] };
}

/* ---------- 页面外壳（模拟控制台背景，不含任何 Cloudflare 资源） ---------- */
const SHELL = `<!doctype html><html><head><meta charset="utf-8"><style>
  :root { color-scheme: light; }
  html, body { margin: 0; height: 100%; }
  body {
    font: 14px/1.6 -apple-system, "Segoe UI", "PingFang SC", "Noto Sans CJK SC", sans-serif;
    color: #2c2f36;
    background:
      radial-gradient(1100px 520px at 12% -8%, #eef2f9 0%, transparent 60%),
      radial-gradient(900px 420px at 92% 4%, #f3f0ea 0%, transparent 55%),
      #f7f8fa;
  }
  .topbar { height: 56px; border-bottom: 1px solid #e6e8ec; background: #fff;
    display: flex; align-items: center; gap: 10px; padding: 0 22px; }
  .logo { width: 26px; height: 26px; border-radius: 7px; background: linear-gradient(135deg,#f6821f,#e8620a); }
  .crumbs { color: #6b7280; font-size: 13px; }
  .crumbs b { color: #2c2f36; font-weight: 600; }
  .ghost { height: 10px; border-radius: 6px; background: #eceef2; }
  .main { padding: 26px 24px; }
  .card { background: #fff; border: 1px solid #e8eaee; border-radius: 14px; padding: 20px;
    box-shadow: 0 1px 2px rgba(16,24,40,.04); max-width: 460px; }
  .card .t { font-size: 13px; color: #6b7280; margin-bottom: 14px; }
  .money { font-size: 34px; font-weight: 650; letter-spacing: .5px; color: #111827; }
  .sub { font-size: 12.5px; color: #8b93a3; margin-top: 6px; }
</style></head><body>
  <div class="topbar"><div class="logo"></div><div class="crumbs"><b>Workers &amp; Pages</b> · Overview</div></div>
  <div class="main">
    <div class="card">
      <div class="t">计费 / Billing</div>
      <div class="money">$0.00</div>
      <div class="sub">目前尚未产生可计费的使用量</div>
    </div>
  </div>
</body></html>`;

/* ---------- 截图 ---------- */
const OUT_DIR = OUT;
mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });

async function shot({ lang, mode, file, openSettings = false, width = 1240, height = 1060 }) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    locale: lang === 'en' ? 'en-US' : 'zh-CN',
    colorScheme: 'light',
  });

  // GM_* 打桩：预置语言/模式/账号，跳过 star 引导
  await context.addInitScript(({ acc, name, lang, mode }) => {
    const mem = new Map([
      ['cfu.mode', mode],
      ['cfu.lang', lang],
      ['cfu.interval', 5],
      ['cfu.open', true],
      ['cfu.starPromptDone', true],
      ['cfu.accounts', [{ id: acc, name }]],
      ['cfu.account', acc],
    ]);
    window.GM_getValue = (k, d) => (mem.has(k) ? mem.get(k) : d);
    window.GM_setValue = (k, v) => mem.set(k, v);
    window.GM_registerMenuCommand = () => {};
    window.GM_xmlhttpRequest = () => { throw new Error('unused'); };
  }, { acc: ACC, name: ACCOUNT_NAME, lang, mode });

  const page = await context.newPage();

  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();

    if (url.startsWith(`https://dash.cloudflare.com/api/v4/accounts`)) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, result: [{ id: ACC, name: ACCOUNT_NAME }] }),
      });
    }
    if (url.startsWith('https://dash.cloudflare.com/api/v4/graphql')) {
      const query = JSON.parse(req.postData() || '{}').query || '';
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(serve(query)),
      });
    }
    if (url.startsWith(`https://dash.cloudflare.com/${ACC}`)) {
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: SHELL });
    }
    return route.abort();
  });

  await page.goto(`https://dash.cloudflare.com/${ACC}/workers-and-pages`, { waitUntil: 'domcontentloaded' });
  await page.addStyleTag({ content: '.topbar,.main{filter:saturate(.98)}' });
  await page.addScriptTag({ path: SCRIPT });
  await page.waitForTimeout(1200); // 等首轮数据渲染 + 进度条动画结束

  // 截图需要完整高度：临时取消面板的 max-height（实际使用时内容超出会内部滚动）
  await page.evaluate(() => {
    const root = document.getElementById('cfu-panel-host').shadowRoot;
    const panel = root.querySelector('.panel');
    panel.style.maxHeight = 'none';
    panel.style.bottom = 'auto';
    panel.style.top = '26px';
  });
  await page.waitForTimeout(150);

  if (openSettings) {
    await page.evaluate(() => {
      const root = document.getElementById('cfu-panel-host').shadowRoot;
      root.querySelector('[data-act=settings]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await page.waitForTimeout(400);
  }

  const box = await page.evaluate(() => {
    const root = document.getElementById('cfu-panel-host').shadowRoot;
    const el = openSettingsRef(root);
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
    function openSettingsRef(shadowRoot) {
      const panel = shadowRoot.querySelector('.panel');
      return panel.dataset.hidden === '1' ? shadowRoot.querySelector('.launcher') : panel;
    }
  });

  const pad = 26;
  const clip = {
    x: Math.max(0, Math.round(box.x - pad)),
    y: Math.max(0, Math.round(box.y - pad)),
    width: Math.round(Math.min(width - Math.max(0, box.x - pad), box.width + pad * 2)),
    height: Math.round(Math.min(height - Math.max(0, box.y - pad), box.height + pad * 2)),
  };
  const outPath = path.join(OUT_DIR, file);
  await page.screenshot({ path: outPath, clip });
  console.log('✓', path.relative(ROOT, outPath), `${clip.width}x${clip.height}`);
  await context.close();
}

await shot({ lang: 'zh', mode: 'session', file: 'panel-zh.png' });
await shot({ lang: 'en', mode: 'session', file: 'panel-en.png' });
await shot({ lang: 'zh', mode: 'session', file: 'panel-settings.png', openSettings: true });

await browser.close();
console.log('\n截图完成 → docs/preview/（数据为演示值）');
