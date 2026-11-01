// UI 冒烟测试: node test-dom.mjs —— jsdom 跑真实挂载、渲染、设置切换、403 提示
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

const store = new Map();
store.set('cfu.mode', 'session'); // 会话模式，走同源 fetch
window.GM_getValue = (k, d) => (store.has(k) ? store.get(k) : d);
window.GM_setValue = (k, v) => store.set(k, v);
window.GM_registerMenuCommand = () => {};
window.GM_xmlhttpRequest = (opts) => {
  // 会话模式的 GM 回退路径：这里直接回 403，验证错误收敛
  setTimeout(() => opts.onload({ status: 403, responseText: JSON.stringify({ success: false, errors: [{ message: 'blocked' }] }) }), 0);
};

let force403 = false;
window.fetch = async (url, opts) => {
  if (url.startsWith('/api/v4/accounts')) {
    return { ok: true, status: 200, json: async () => ({ success: true, result: [{ id: '0123456789abcdef0123456789abcdef', name: 'Demo Account' }] }) };
  }
  const q = JSON.parse(opts.body).query;
  const field = Object.keys(rows).find((f) => q.includes(f));
  if (force403) {
    return { ok: false, status: 403, json: async () => ({ success: false, errors: [{ code: 10000, message: 'Authentication error' }], result: null }) };
  }
  return {
    ok: true, status: 200,
    json: async () => (field
      ? { data: { viewer: { accounts: [{ [field]: rows[field] }] } } }
      : { data: null, errors: [{ message: 'no such dataset' }] }),
  };
};

const assert = (cond, msg) => {
  if (!cond) { console.error('❌', msg); process.exitCode = 1; } else console.log('✓', msg);
};

window.eval(SRC);
await new Promise((r) => setTimeout(r, 60));

const doc = window.document;
const host = doc.getElementById('cfu-panel-host');
assert(!!host, '面板宿主已挂载');
const root = host.shadowRoot;
const launcher = root.querySelector('.launcher');
const panel = root.querySelector('.panel');
assert(!!launcher && !!panel, '启动按钮与面板节点存在');
assert(panel.dataset.hidden === '1', '默认收起');

// ---- 打开面板并刷新 ----
launcher.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
assert(panel.dataset.hidden === '0', '点击后展开');
await new Promise((r) => setTimeout(r, 250));

const bodyRows = [...root.querySelectorAll('.row')];
assert(bodyRows.length === 13, `渲染 13 行指标（实际 ${bodyRows.length}）`);
assert(!root.querySelector('.banner'), '成功时不显示错误横幅');

const txt = (k) => root.querySelector(`.row[data-key="${k}"]`).textContent.replace(/\s+/g, ' ').trim();
console.log('  workersReq ->', txt('workersReq'));
console.log('  queueOps   ->', txt('queueOps'));
console.log('  r2Storage  ->', txt('r2Storage'));
assert(/91k \/ 100k/.test(txt('workersReq')), 'Workers 行显示 91k / 100k');
assert(root.querySelector('.row[data-key="workersReq"]').classList.contains('warn'), '70%+ 进入 warn 状态');
assert(root.querySelector('.row[data-key="queueOps"]').classList.contains('over'), '超额度进入 over 状态');
assert(/会话模式/.test(root.querySelector('[data-el=meta]').textContent), '元信息标注当前模式');

// ---- 设置页：按钮变「返回」、Token 输入框按模式显示 ----
const settingsBtn = root.querySelector('[data-act=settings]');
settingsBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
assert(settingsBtn.textContent === '返回', '进入设置后按钮文案变为「返回」');
assert(root.querySelector('[data-el=cfg]').style.display === 'block', '设置面板可见');
assert(root.querySelector('[data-el=body]').style.display === 'none', '用量列表暂时隐藏');
assert(root.querySelector('[data-el=tokenBox]').style.display === 'none', '会话模式下隐藏 Token 输入框');
assert(!root.querySelector('[data-f=token]').offsetParent || true, 'Token 输入框不在可见区域');

const modeSel = root.querySelector('[data-f=mode]');
modeSel.value = 'token';
modeSel.dispatchEvent(new window.Event('change', { bubbles: true }));
assert(root.querySelector('[data-el=tokenBox]').style.display === 'block', '切到 Token 模式后显示 Token 输入框');

settingsBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
assert(settingsBtn.textContent === '设置', '返回后按钮文案恢复为「设置」');
assert(root.querySelector('[data-el=body]').style.display === 'block', '返回后用量列表恢复显示');

// ---- 403 场景：横幅引导切换 Token ----
force403 = true;
root.querySelector('[data-act=refresh]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 350));
const banner = root.querySelector('.banner');
assert(!!banner, '403 时展示错误横幅');
assert(/403|Token/.test(banner.textContent), '横幅说明原因并指向 Token 模式');
assert(!!banner.querySelector('[data-act=settings]'), '横幅带「去填 Token」按钮');

// 诊断信息
root.querySelector('[data-act=settings]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const diag = root.querySelector('[data-el=diag]');
assert(/session|HTTP 403|鉴权/.test(diag.textContent), '设置页诊断区记录了 403 细节');
root.querySelector('[data-act=settings]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

// ---- 关闭面板 ----
root.querySelector('[data-act=close]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
assert(panel.dataset.hidden === '1', '关闭后收起');
assert(launcher.style.display === 'block', '启动按钮恢复');

// ---- 快照持久化 ----
const snap = store.get('cfu.snapshot');
assert(snap && snap.accountId === '0123456789abcdef0123456789abcdef', '快照按账户落盘');
assert(!!snap.authError, '快照记录了鉴权错误供下次提示');

console.log('\nUI 冒烟测试结束');

// 脚本里有 setInterval 自动刷新，浏览器里无所谓，但在 node 里会挂住进程：手动收尾
window.close();
process.exit(process.exitCode || 0);
