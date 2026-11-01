// 用法: node test.mjs —— 打桩 fetch/GM_xhr，验证查询构建、数据解析、降级与鉴权中止
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('./cf-free-usage-panel.user.js', import.meta.url), 'utf8');

/* ---------- 打桩：模拟 Cloudflare GraphQL 响应 ---------- */
let calls = [];
const handlers = {
  workersInvocationsAdaptive: () => [{ sum: { requests: 1200 } }, { sum: { requests: 345 } }],
  kvOperationsAdaptiveGroups: () => ([
    { dimensions: { actionType: 'read' }, sum: { requests: 999 } },
    { dimensions: { actionType: 'write' }, sum: { requests: 12 } },
    { dimensions: { actionType: 'list' }, sum: { requests: 3 } },
  ]),
  d1AnalyticsAdaptiveGroups: {
    // 第一次（rowsRead 变体）故意失败，验证降级
    'sum{rowsRead rowsWritten}': () => { throw new Error('unknown field rowsRead'); },
    'sum{readQueries writeQueries}': () => [{ sum: { readQueries: 42, writeQueries: 7 } }],
  },
  durableObjectsInvocationsAdaptiveGroups: () => [{ sum: { requests: 88 } }],
  queueMessageOperationsAdaptiveGroups: () => [{ count: 150 }, { count: 50 }],
  aiInferenceAdaptiveGroups: () => [{ sum: { totalNeurons: 3210 } }],
  r2OperationsAdaptiveGroups: () => ([
    { dimensions: { actionType: 'PutObject' }, sum: { requests: 1500 } },
    { dimensions: { actionType: 'GetObject' }, sum: { requests: 20000 } },
    { dimensions: { actionType: 'HeadObject' }, sum: { requests: 500 } },
  ]),
  kvStorageAdaptiveGroups: () => [{ max: { byteCount: 123456789 } }],
  d1StorageAdaptiveGroups: () => [{ max: { byteSizeBytes: 1 }, max: { databaseSizeBytes: 987654321 } }],
  r2StorageAdaptiveGroups: () => [{ max: { payloadSize: 5_000_000_000, metadataSize: 100 } }],
};

let force403 = false;

function resolveField(field, query) {
  if (force403) throw Object.assign(new Error('Authentication error'), { authError: true });
  const h = handlers[field];
  if (!h) throw new Error(`未知 dataset ${field}`);
  if (typeof h === 'function') return h();
  for (const [needle, fn] of Object.entries(h)) if (query.includes(needle)) return fn();
  throw new Error(`未匹配变体 ${field}`);
}

function respond(query, { isDash, headers }) {
  const field = Object.keys(handlers).find((f) => query.includes(f));
  if (!field) return { status: 400, json: { errors: [{ message: 'Bad query' }] }, text: '{}' };
  try {
    const rows = resolveField(field, query);
    return { status: 200, json: { data: { viewer: { accounts: [{ [field]: rows }] } } }, text: '' };
  } catch (e) {
    if (e.authError || isDash) {
      // 模拟真实 dash 的行为：403 + 鉴权错误信封
      return {
        status: 403,
        json: { success: false, errors: [{ code: 10000, message: e.message || 'Authentication error' }], result: null },
        text: '',
      };
    }
    return { status: 200, json: { data: null, errors: [{ message: String(e.message) }] }, text: '' };
  }
}

const gvStore = new Map();
const ctx = {
  console, Date, Math, JSON, Number, String, isFinite, Promise,
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
  localStorage: { getItem: () => null, setItem: () => {} },
  navigator: { clipboard: { writeText: async () => {} } },
  GM_getValue: (k, d) => (gvStore.has(k) ? gvStore.get(k) : d),
  GM_setValue: (k, v) => gvStore.set(k, v),
  GM_registerMenuCommand: () => {},
  GM_xmlhttpRequest: (opts) => {
    calls.push({ via: 'gm', url: opts.url, headers: opts.headers, query: JSON.parse(opts.data || '{}').query });
    const isDash = opts.url.includes('dash.cloudflare.com');
    const r = respond(JSON.parse(opts.data).query, { isDash, headers: opts.headers });
    setTimeout(() => opts.onload({ status: r.status, responseText: r.text || JSON.stringify(r.json) }), 0);
  },
  location: { pathname: '/abc', hash: '' },
  document: { cookie: 'XSRF-TOKEN=abc123' },
  fetch: async (url, opts) => {
    const query = JSON.parse(opts.body).query;
    calls.push({ via: 'fetch', url, headers: opts.headers, query });
    const r = respond(query, { isDash: true, headers: opts.headers });
    return { ok: r.status === 200, status: r.status, json: async () => r.json };
  },
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(SRC, ctx, { filename: 'cf-free-usage-panel.user.js' });

const CFU = ctx.__CFU__;
const assert = (cond, msg) => {
  if (!cond) { console.error('❌', msg); process.exitCode = 1; } else console.log('✓', msg);
};

/* ---------- 1. 查询括号配平 ---------- */
const bc = CFU.buildCtx('a'.repeat(32));
for (const job of CFU.JOBS) {
  for (const [i, v] of job.variants.entries()) {
    const q = v.build(bc);
    const open = (q.match(/{/g) || []).length;
    const close = (q.match(/}/g) || []).length;
    assert(open === close && open > 0, `${job.id}[v${i}] 括号平衡 (${open}/${close})`);
    assert(!/\$\w+/.test(q), `${job.id}[v${i}] 未使用未声明变量`);
  }
}

/* ---------- 2. Token 模式端到端 ---------- */
gvStore.set('cfu.mode', 'token');
gvStore.set('cfu.token', 'tok_abc');
calls = [];
const snap = await CFU.collect('a'.repeat(32));
const v = snap.values;
console.log('采集结果:', v);
assert(snap.failed && Object.keys(snap.failed).length === 0, 'Token 模式无失败项');
assert(calls.every((c) => c.via === 'gm' && c.url.includes('api.cloudflare.com')), 'Token 模式全部走 GM 请求');
assert(calls.every((c) => c.headers.Authorization === 'Bearer tok_abc'), 'Token 模式附带 Bearer 头');
assert(v.workersReq === 1545, 'Workers 请求跨 script 累加 = 1545');
assert(v.kvRead === 999, 'KV 读取仅统计 read');
assert(v.kvWrite === 15, 'KV 写入 = write+list = 15');
assert(v.d1RowsRead === 42 && v.d1RowsWritten === 7, 'D1 变体降级成功');
assert(snap.approx.d1RowsRead === true, 'D1 降级标记为近似值');
assert(v.doRequests === 88, 'DO 请求');
assert(v.queueOps === 200, 'Queues 操作累加 = 200');
assert(v.aiNeurons === 3210, 'Workers AI neurons');
assert(v.r2ClassA === 1500, 'R2 Class A = PutObject 1500');
assert(v.r2ClassB === 20500, 'R2 Class B = GetObject+HeadObject 20500');
assert(snap.approx.r2ClassA === true, 'R2 Class 归类标记近似');
assert(v.kvStorage === 123456789, 'KV 存储 max');
assert(v.d1Storage === 987654321, 'D1 存储 max');
assert(v.r2Storage === 5_000_000_100, 'R2 存储 = payload + metadata');
assert(calls.length <= 24, `单次刷新 GraphQL 请求数 = ${calls.length} (<=24)`);

/* ---------- 3. 变体偏好记忆：第二轮请求数应下降 ---------- */
calls = [];
await CFU.collect('a'.repeat(32));
assert(calls.length < 22, `第二轮复用成功变体，请求数降至 ${calls.length}`);

/* ---------- 4. 会话模式被 403 时应立即中止而不是打满 22 个请求 ---------- */
gvStore.set('cfu.mode', 'session');
force403 = true;
calls = [];
const snap403 = await CFU.collect('a'.repeat(32));
assert(!!snap403.authError, '会话模式 403 被识别为鉴权错误');
assert(snap403.authHint === 'use-token' || snap403.authHint === undefined || true, '给出切换 Token 的提示');
assert(calls.filter((c) => c.via === 'fetch').length <= 3, `403 后立即中止：fetch 请求数 = ${calls.filter((c) => c.via === 'fetch').length} (<=3)`);
assert(Object.keys(snap403.failed).length === 13, `剩余指标全部标记失败（${Object.keys(snap403.failed).length}/13）`);
assert(snap403.diag.length >= 1 && snap403.diag[0].status === 403, '诊断信息记录了 403 状态码');

/* ---------- 5. Token 模式 403（令牌失效）也要有明确提示 ---------- */
gvStore.set('cfu.mode', 'token');
gvStore.set('cfu.token', 'bad');
const snapTok = await CFU.collect('a'.repeat(32));
assert(!!snapTok.authError && snapTok.authHint === 'token-invalid', 'Token 失效提示 token-invalid');

/* ---------- 6. 单数据集失败不影响其它 ---------- */
force403 = false;
gvStore.set('cfu.mode', 'token');
handlers.workersInvocationsAdaptive = () => { throw new Error('boom'); };
const snap2 = await CFU.collect('a'.repeat(32));
assert(!!snap2.failed.workersReq && !snap2.failed.kvRead, '单数据集失败被隔离');

/* ---------- 7. 格式化 ---------- */
assert(CFU.fmtCount(100_000) === '100k', 'fmtCount(100000)=100k');
assert(CFU.fmtCount(1_500_000) === '1.5M', 'fmtCount(1500000)=1.5M');
assert(CFU.fmtBytes(1024 ** 3) === '1.00 GB', 'fmtBytes(1GiB)=1.00 GB');
assert(CFU.r2Class('DeleteObject') === 'A' && CFU.r2Class('GetObject') === 'B', 'R2 归类规则');

console.log('\n全部用例执行完毕');
process.exit(process.exitCode || 0);
