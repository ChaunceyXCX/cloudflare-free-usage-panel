// 用法: node test.mjs  —— 用打桩的 fetch 验证查询构建 / 数据解析 / 降级逻辑
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('./cf-free-usage-panel.user.js', import.meta.url), 'utf8');

/* ---------- 打桩：模拟 Cloudflare GraphQL 响应 ---------- */
const calls = [];
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
  d1StorageAdaptiveGroups: () => [{ max: { databaseSizeBytes: 987654321 } }],
  r2StorageAdaptiveGroups: () => [{ max: { payloadSize: 5_000_000_000, metadataSize: 100 } }],
};

function fakeResolve(field, query) {
  const h = handlers[field];
  if (!h) throw new Error(`未知 dataset ${field}`);
  if (typeof h === 'function') return h();
  for (const [needle, fn] of Object.entries(h)) if (query.includes(needle)) return fn();
  throw new Error(`未匹配变体 ${field}`);
}

const ctx = {
  console,
  Date,
  Math,
  JSON,
  Number,
  String,
  isFinite,
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
  localStorage: { getItem: () => null, setItem: () => {} },
  GM_getValue: (_k, d) => d,
  GM_setValue: () => {},
  GM_registerMenuCommand: () => {},
  GM_xmlhttpRequest: () => { throw new Error('不应在会话模式调用'); },
  location: { pathname: '/abc', hash: '' },
  document: { cookie: 'XSRF-TOKEN=abc' },
  fetch: async (url, opts) => {
    const body = JSON.parse(opts.body);
    const query = body.query;
    calls.push(query);
    if (url !== '/api/v4/graphql') throw new Error('意外 URL ' + url);
    const field = Object.keys(handlers).find((f) => query.includes(f));
    if (!field) throw new Error('查询中没有已知 dataset: ' + query);
    try {
      const rows = fakeResolve(field, query);
      return { ok: true, status: 200, json: async () => ({ data: { viewer: { accounts: [{ [field]: rows }] } } }) };
    } catch (e) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: null, errors: [{ message: String(e.message) }] }),
      };
    }
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

/* ---------- 2. 端到端采集 ---------- */
const snap = await CFU.collect('a'.repeat(32));
const v = snap.values;
console.log('采集结果:', v);
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
assert(Object.keys(snap.failed).length === 0, '无失败项');

/* ---------- 3. 全部数据集失效时不应抛错 ---------- */
handlers.workersInvocationsAdaptive = () => { throw new Error('boom'); };
const snap2 = await CFU.collect('a'.repeat(32));
assert(!!snap2.failed.workersReq, '单数据集失败被隔离，其余照常渲染');

/* ---------- 4. 格式化 ---------- */
assert(CFU.fmtCount(100_000) === '100k', 'fmtCount(100000)=100k');
assert(CFU.fmtCount(1_500_000) === '1.5M', 'fmtCount(1500000)=1.5M');
assert(CFU.fmtBytes(1024 ** 3) === '1.00 GB', 'fmtBytes(1GiB)=1.00 GB');
assert(CFU.r2Class('DeleteObject') === 'A' && CFU.r2Class('GetObject') === 'B', 'R2 归类规则');

/* ---------- 5. 请求量（避免打爆 GraphQL 限额） ---------- */
assert(calls.length <= 24, `单次刷新 GraphQL 请求数 = ${calls.length} (<=24)`);
console.log('\n全部用例执行完毕');
