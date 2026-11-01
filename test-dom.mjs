// UI 冒烟测试: node test-dom.mjs —— 用 jsdom 跑真实挂载、渲染、交互
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const SRC = readFileSync(new URL('./cf-free-usage-panel.user.js', import.meta.url), 'utf8');

const rows = {
  workersInvocationsAdaptive: [{ sum: { requests: 91_234 } }],
  kvOperationsAdaptiveGroups: [
    { dimensions: { actionType: 'read' }, sum: { requests: 87_000 } },
    { dimensions: { actionType: 'write' }, sum: { requests: 900 } },
  ],
  d1AnalyticsAdaptiveGroups: [{ sum: { rowsRead: 1_200_000, rowsWritten: 30_000 } }],
  durableObjectsInvocationsAdaptiveGroups: [{ sum: { requests: 0 } }],
  queueMessageOperationsAdaptiveGroups: [{ count: 10_400 }],
  aiInferenceAdaptiveGroups: [{ sum: { totalNeurons: 120 } }],
  r2OperationsAdaptiveGroups: [
    { dimensions: { actionType: 'PutObject' }, sum: { requests: 300_000 } },
    { dimensions: { actionType: 'GetObject' }, sum: { requests: 900_000 } },
  ],
  kvStorageAdaptiveGroups: [{ max: { byteCount: 0.4 * 1024 ** 3 } }],
  d1StorageAdaptiveGroups: [{ max: { databaseSizeBytes: 1.2 * 1024 ** 3 } }],
  r2StorageAdaptiveGroups: [{ max: { payloadSize: 9.5 * 1024 ** 3, metadataSize: 1024 } }],
};

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://dash.cloudflare.com/0123456789abcdef0123456789abcdef/workers-and-pages',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;
const doc = window.document;

const store = new Map();
window.GM_getValue = (k, d) => (store.has(k) ? store.get(k) : d);
window.GM_setValue = (k, v) => store.set(k, v);
window.GM_registerMenuCommand = () => {};
window.GM_xmlhttpRequest = () => { throw new Error('unexpected'); };

window.fetch = async (url, opts) => {
  if (url.startsWith('/api/v4/accounts')) {
    return { ok: true, status: 200, json: async () => ({ success: true, result: [{ id: '0123456789abcdef0123456789abcdef', name: 'Demo Account' }] }) };
  }
  const q = JSON.parse(opts.body).query;
  const field = Object.keys(rows).find((f) => q.includes(f));
  return {
    ok: true, status: 200,
    json: async () => (field
      ? { data: { viewer: { accounts: [{ [field]: rows[field] }] } } }
      : { data: null, errors: [{ message: 'no such dataset: ' + q.slice(0, 60) }] }),
  };
};

const assert = (cond, msg) => {
  if (!cond) { console.error('❌', msg); process.exitCode = 1; } else console.log('✓', msg);
};

window.eval(SRC);

// 等待 init 完成
await new Promise((r) => setTimeout(r, 50));

const host = doc.getElementById('cfu-panel-host');
assert(!!host, '面板宿主已挂载');
const root = host.shadowRoot;
assert(!!root, 'shadow root 存在');
const launcher = root.querySelector('.launcher');
const panel = root.querySelector('.panel');
assert(!!launcher && !!panel, '启动按钮与面板节点存在');
assert(panel.dataset.hidden === '1', '默认收起');

// 打开面板 -> 触发刷新
launcher.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
assert(panel.dataset.hidden === '0', '点击后展开');
await new Promise((r) => setTimeout(r, 200));

const bodyRows = [...root.querySelectorAll('.row')];
assert(bodyRows.length === 13, `渲染 13 行指标（实际 ${bodyRows.length}）`);

const txt = (k) => root.querySelector(`.row[data-key="${k}"]`).textContent.replace(/\s+/g, ' ').trim();
console.log('  workersReq ->', txt('workersReq'));
console.log('  kvWrite    ->', txt('kvWrite'));
console.log('  queueOps   ->', txt('queueOps'));
console.log('  r2Storage  ->', txt('r2Storage'));

assert(/91k \/ 100k/.test(txt('workersReq')), 'Workers 行显示 91k / 100k');
const wpct = root.querySelector('.row[data-key="workersReq"] .pct');
assert(/9[01]%/.test(wpct.textContent), 'Workers 百分比 ≈ 91%');
assert(root.querySelector('.row[data-key="workersReq"]').classList.contains('warn'), '70%+ 进入 warn 状态');
assert(root.querySelector('.row[data-key="queueOps"]').classList.contains('over'), '超额度进入 over 状态');

const bar = root.querySelector('.row[data-key="workersReq"] .bar > i');
assert(parseFloat(bar.style.width) > 90 && parseFloat(bar.style.width) <= 100, '进度条宽度被裁剪到 100% 内且 > 90');

assert(/Demo Account/.test(root.querySelector('[data-el=meta]').textContent), '账户名展示');
assert(/更新于/.test(root.querySelector('[data-el=meta]').textContent), '显示更新时间');

// 设置面板
root.querySelector('[data-act=settings]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
assert(root.querySelector('[data-el=cfg]').style.display === 'block', '设置面板打开');
assert(!!root.querySelector('[data-f=token]'), '存在 Token 输入框');
assert(root.querySelector('[data-f=token]').value === '', 'Token 默认不为空泄漏');

// 关闭面板
root.querySelector('[data-act=close]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
assert(panel.dataset.hidden === '1', '关闭后收起');
assert(launcher.style.display === 'block', '启动按钮恢复');

// 快照持久化
assert(store.has('cfu.snapshot'), '快照写入本地存储');
const snap = store.get('cfu.snapshot');
assert(snap.values.workersReq === 91_234 && snap.accountId === '0123456789abcdef0123456789abcdef', '快照内容正确');

// 半屏刷新不应崩溃
launcher.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 150));
assert(root.querySelectorAll('.row').length === 13, '二次打开仍渲染 13 行');

console.log('\nUI 冒烟测试结束');

// 脚本里有 setInterval 自动刷新，浏览器里无所谓，但在 node 里会挂住进程：手动收尾
window.close();
process.exit(process.exitCode || 0);
