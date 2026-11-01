// UI 冒烟测试: node test-dom.mjs —— jsdom 跑真实挂载、合并查询渲染、设置交互、403 与快照保护
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

// 模拟 GraphQL：同时支持「单 dataset」与「alias 合并」两种查询
function serve(query) {
  const aliased = [...query.matchAll(/\b(a\d+):\s*([A-Za-z][A-Za-z0-9]+)\s*\(/g)].map((m) => ({ alias: m[1], dataset: m[2] }));
  if (aliased.length) {
    const account = {};
    for (const { alias, dataset } of aliased) account[alias] = rows[dataset] || [];
    return { data: { viewer: { accounts: [account] } }, errors: [] };
  }
  const dataset = Object.keys(rows).find((d) => query.includes(d));
  if (!dataset) return { data: null, errors: [{ message: 'no such dataset' }] };
  return { data: { viewer: { accounts: [{ [dataset]: rows[dataset] }] } }, errors: [] };
}

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://dash.cloudflare.com/0123456789abcdef0123456789abcdef/workers-and-pages',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;

const store = new Map();
store.set('cfu.mode', 'session');
store.set('cfu.lang', 'zh'); // jsdom 默认 en-US，这里固定中文以便断言文案
window.GM_getValue = (k, d) => (store.has(k) ? store.get(k) : d);
window.GM_setValue = (k, v) => store.set(k, v);
window.GM_registerMenuCommand = () => {};
let gmCalls = 0;
window.GM_xmlhttpRequest = (opts) => {
  gmCalls += 1;
  setTimeout(() => opts.onload({ status: 403, responseText: JSON.stringify({ success: false, errors: [{ message: 'blocked' }] }) }), 0);
};

let force403 = false;
let fetchCalls = 0;
window.fetch = async (url, opts) => {
  if (url.startsWith('/api/v4/accounts')) {
    return { ok: true, status: 200, json: async () => ({ success: true, result: [{ id: '0123456789abcdef0123456789abcdef', name: 'Demo Account' }] }) };
  }
  fetchCalls += 1;
  if (force403) {
    return { ok: false, status: 403, json: async () => ({ success: false, errors: [{ code: 10000, message: 'Forbidden' }], result: null }) };
  }
  const r = serve(JSON.parse(opts.body).query);
  return { ok: true, status: 200, json: async () => r };
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
assert(panel.dataset.hidden === '1', '默认收起');

// ---- 打开面板并刷新 ----
launcher.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 250));
assert(panel.dataset.hidden === '0', '点击后展开');
assert(fetchCalls === 2, `打开面板只用 2 个合并请求（实际 ${fetchCalls}）`);

const bodyRows = [...root.querySelectorAll('.row')];
assert(bodyRows.length === 13, `渲染 13 行指标（实际 ${bodyRows.length}）`);
assert(!root.querySelector('.banner') && !root.querySelector('.notice'), '成功时既无错误横幅也无提示条');

const txt = (k) => root.querySelector(`.row[data-key="${k}"]`).textContent.replace(/\s+/g, ' ').trim();
console.log('  workersReq ->', txt('workersReq'));
console.log('  queueOps   ->', txt('queueOps'));
console.log('  r2Storage  ->', txt('r2Storage'));
assert(/91k \/ 100k/.test(txt('workersReq')), 'Workers 行显示 91k / 100k');
assert(root.querySelector('.row[data-key="workersReq"]').classList.contains('warn'), '70%+ 进入 warn 状态');
assert(root.querySelector('.row[data-key="queueOps"]').classList.contains('over'), '超额度进入 over 状态');
assert(/会话模式/.test(root.querySelector('[data-el=meta]').textContent), '元信息标注当前模式');
assert(/本次 2 个 GraphQL 请求/.test(root.querySelector('.foot').textContent), '页脚展示本次请求数');

// ---- 设置页交互 ----
const settingsBtn = root.querySelector('[data-act=settings]');
settingsBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
assert(settingsBtn.textContent === '返回', '进入设置后按钮文案变为「返回」');
assert(root.querySelector('[data-el=body]').style.display === 'none', '用量列表暂时隐藏');
assert(root.querySelector('[data-el=tokenBox]').style.display === 'none', '会话模式下隐藏 Token 输入框');
const modeSel = root.querySelector('[data-f=mode]');
modeSel.value = 'token';
modeSel.dispatchEvent(new window.Event('change', { bubbles: true }));
assert(root.querySelector('[data-el=tokenBox]').style.display === 'block', '切到 Token 模式后显示 Token 输入框');
settingsBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
assert(settingsBtn.textContent === '设置', '返回后按钮文案恢复为「设置」');
assert(root.querySelector('[data-el=body]').style.display === 'block', '返回后用量列表恢复显示');



// ---- 方案 A：star 引导（不拦人，可永久关闭）----
assert(!!root.querySelector('.star'), '首屏出现一次性 star 引导卡片');
assert(/github\.com/.test(root.querySelector('.foot a').getAttribute('href')), '页脚挂了 GitHub 仓库链接');
root.querySelector('[data-act=star-later]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
assert(!root.querySelector('.star'), '点「以后再说」后消失');
assert(store.get('cfu.starPromptDone') === true, 'star 引导状态已持久化（cfu.starPromptDone），不再打扰');

// ---- 中英切换 ----
const labelOf = (k) => root.querySelector(`.row[data-key="${k}"] .name`).textContent.replace(/\s+/g, ' ').trim();
assert(labelOf('workersReq') === 'Workers 请求', `默认中文标签（${labelOf('workersReq')}）`);
root.querySelector('[data-act=settings]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const langSel = root.querySelector('[data-f=lang]');
assert(!!langSel, '设置里存在语言选择器');
langSel.value = 'en';
langSel.dispatchEvent(new window.Event('change', { bubbles: true }));
assert(root.querySelector('[data-el=title]').textContent === 'Free tier usage', '标题切到英文');
assert(labelOf('workersReq') === 'Workers requests', `指标名切到英文（${labelOf('workersReq')}）`);
assert(/Daily quota/.test(root.querySelector('.sec-h').textContent), '分区标题切到英文');
assert(/GraphQL requests this round/.test(root.querySelector('.foot').textContent), '页脚切到英文');
assert(store.get('cfu.lang') === 'en', '语言选择已持久化');
assert(root.querySelector('[data-act=save]').textContent === 'Save & refresh', '设置按钮文案切英文');
// 切回中文
root.querySelector('[data-f=lang]').value = 'zh';
root.querySelector('[data-f=lang]').dispatchEvent(new window.Event('change', { bubbles: true }));
assert(labelOf('workersReq') === 'Workers 请求', '切回中文生效');
root.querySelector('[data-act=settings]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

// ---- 拖拽：悬浮球 ----
const pointer = (el, type, x, y) => el.dispatchEvent(new window.MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));
const drag = (el, from, to) => {
  pointer(el, 'pointerdown', from[0], from[1]);
  pointer(el, 'pointermove', to[0], to[1]);
  pointer(el, 'pointerup', to[0], to[1]);
};

// 先关掉面板，验证「拖动后不应误触展开」
root.querySelector('[data-act=close]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
assert(panel.dataset.hidden === '1', '拖拽测试前先收起面板');

drag(launcher, [200, 200], [320, 260]);
assert(launcher.style.left === '120px' && launcher.style.top === '60px', `悬浮球按位移移动（left=${launcher.style.left}, top=${launcher.style.top}）`);
assert(launcher.style.right === 'auto' && launcher.style.bottom === 'auto', '定位从 right/bottom 切换为 left/top');
assert(store.has('cfu.launcherPos'), '悬浮球坐标已落盘');

launcher.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
assert(panel.dataset.hidden === '1', '拖动结束补发的 click 被吞掉（面板不弹出）');
launcher.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
assert(panel.dataset.hidden === '0', '无拖动的正常点击仍能展开面板');

// ---- 拖拽：面板（头部把手） ----
const header = panel.querySelector('header');
drag(header, [400, 100], [450, 130]);
assert(panel.style.left === '50px' && panel.style.top === '30px', `面板随头部拖动（left=${panel.style.left}, top=${panel.style.top}）`);
assert(store.has('cfu.panelPos'), '面板坐标已落盘');

// 头部按钮上的操作不应触发拖拽
const leftBefore = panel.style.left;
drag(root.querySelector('[data-act=refresh]'), [400, 100], [600, 300]);
assert(panel.style.left === leftBefore, '按住头部按钮拖动不会移动面板');

// ---- 重置位置 ----
root.querySelector('[data-act=settings]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
root.querySelector('[data-act=resetpos]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
assert(panel.style.left === '' && panel.style.top === '', '重置后面板回到 CSS 默认位置');
assert(store.get('cfu.panelPos', 'x') === null && store.get('cfu.launcherPos', 'x') === null, '重置后坐标记录被清空');
root.querySelector('[data-act=settings]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

// ---- 全灭 403：保留上次数据 + 元信息提示，不清空面板 ----
force403 = true;
const before = txt('workersReq');
root.querySelector('[data-act=refresh]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 1300)); // 含一次 700ms 退避重试
assert(txt('workersReq') === before, '刷新失败时保留上次数据（面板不被清空）');
assert(!!root.querySelector('.meta .stale'), '元信息标注「展示上次数据」');
assert(!root.querySelector('.banner'), '保留旧数据时不弹全屏错误横幅');
assert(gmCalls === 0, '会话模式全程没有发 GM 请求（不会刷一片 403）');

// ---- 清缓存后再全灭：给出横幅与切换入口 ----
root.querySelector('[data-act=settings]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
root.querySelector('[data-act=clearcache]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
root.querySelector('[data-act=settings]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
root.querySelector('[data-act=refresh]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 1300));
const banner = root.querySelector('.banner');
assert(!!banner, '无缓存且全灭时展示错误横幅');
assert(!!banner.querySelector('[data-act=settings]'), '横幅带「切换 Token 模式」入口');

// ---- 诊断区 ----
root.querySelector('[data-act=settings]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const diag = root.querySelector('[data-el=diag]');
assert(/403|致命/.test(diag.textContent), '诊断区记录 403 / fatal 细节');
assert(/会话模式|session/.test(diag.textContent), '诊断区包含模式信息');
root.querySelector('[data-act=settings]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

// ---- 关闭 ----
root.querySelector('[data-act=close]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
assert(panel.dataset.hidden === '1', '关闭后收起');
assert(launcher.style.display === 'block', '启动按钮恢复');

console.log('\nUI 冒烟测试结束');

// 脚本里有 setInterval 自动刷新，浏览器里无所谓，但在 node 里会挂住进程：手动收尾
window.close();
process.exit(process.exitCode || 0);
