// 用法: node test.mjs —— 打桩 fetch/GM_xhr，验证合并查询、alias 级容错、降级、403 重试与快照保护
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('./cf-free-usage-panel.user.js', import.meta.url), 'utf8');

/* ---------- 打桩 Cloudflare GraphQL ---------- */
let calls = [];
let forced403 = 0;        // 前 N 个请求返回 403（模拟风控突发）
let badD1Rows = true;     // d1 的 rowsRead 变体被判为无效字段（整文档校验失败）

const rows = {
  workersInvocationsAdaptive: () => [{ sum: { requests: 1200 } }, { sum: { requests: 345 } }],
  kvOperationsAdaptiveGroups: () => ([
    { dimensions: { actionType: 'read' }, sum: { requests: 999 } },
    { dimensions: { actionType: 'write' }, sum: { requests: 12 } },
    { dimensions: { actionType: 'list' }, sum: { requests: 3 } },
  ]),
  d1AnalyticsAdaptiveGroups: (q) => (q.includes('sum{rowsRead rowsWritten}')
    ? [{ sum: { rowsRead: 400, rowsWritten: 20 } }]
    : [{ sum: { readQueries: 42, writeQueries: 7 } }]),
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

const DATASETS = Object.keys(rows);

function rowsFor(dataset, query) {
  if (!rows[dataset]) throw Object.assign(new Error(`unknown dataset ${dataset}`), { datasetMissing: true });
  return rows[dataset](query);
}

// 模拟 GraphQL 服务：单 dataset / alias 合并两种形态都支持
function serve(query, { isDash }) {
  const aliased = [...query.matchAll(/\b(a\d+):\s*([A-Za-z][A-Za-z0-9]+)\s*\(/g)].map((m) => ({ alias: m[1], dataset: m[2] }));

  if (!aliased.length) {
    const dataset = DATASETS.find((d) => query.includes(d));
    if (!dataset) return { data: null, errors: [{ message: 'Cannot query field on type "account"' }] };
    if (dataset === 'd1AnalyticsAdaptiveGroups' && badD1Rows && query.includes('sum{rowsRead rowsWritten}')) {
      return { data: null, errors: [{ message: 'Cannot query field "rowsRead" on type "d1AnalyticsAdaptiveGroupsSum"' }] };
    }
    return { data: { viewer: { accounts: [{ [dataset]: rowsFor(dataset, query) }] } }, errors: [] };
  }

  // 合并文档：任一 alias 字段不存在 => 整个文档校验失败（真实 GraphQL 行为）
  if (badD1Rows && aliased.some((a) => a.dataset === 'd1AnalyticsAdaptiveGroups')
      && query.includes('sum{rowsRead rowsWritten}')) {
    return { data: null, errors: [{ message: 'Cannot query field "rowsRead" on type "d1AnalyticsAdaptiveGroupsSum"' }] };
  }

  const account = {};
  const errors = [];
  for (const { alias, dataset } of aliased) {
    if (!rows[dataset]) {
      account[alias] = null;
      errors.push({ message: `Cannot query field "${dataset}"`, path: ['viewer', 'accounts', 0, alias] });
      continue;
    }
    account[alias] = rowsFor(dataset, query);
  }
  return { data: { viewer: { accounts: [account] } }, errors };
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
    const body = JSON.parse(opts.data).query;
    calls.push({ via: 'gm', url: opts.url, query: body });
    const r = serve(body, { isDash: opts.url.includes('dash.cloudflare.com') });
    const status = r.data ? 200 : 400;
    setTimeout(() => opts.onload({ status, responseText: JSON.stringify(r.data ? { data: r.data } : { errors: r.errors }) }), 0);
  },
  location: { pathname: '/abc', hash: '' },
  document: { cookie: 'XSRF-TOKEN=abc123' },
  fetch: async (url, opts) => {
    const query = JSON.parse(opts.body).query;
    calls.push({ via: 'fetch', url, query });
    if (forced403 > 0) {
      forced403 -= 1;
      return { ok: false, status: 403, json: async () => ({ success: false, errors: [{ code: 10000, message: 'Forbidden' }], result: null }) };
    }
    const r = serve(query, { isDash: true });
    return {
      ok: true,
      status: r.data ? 200 : 400,
      json: async () => (r.data ? { data: r.data } : { data: null, errors: r.errors }),
    };
  },
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(SRC, ctx, { filename: 'cf-free-usage-panel.user.js' });

const CFU = ctx.__CFU__;
const assert = (cond, msg) => {
  if (!cond) { console.error('❌', msg); process.exitCode = 1; } else console.log('✓', msg);
};
const ACC = 'a'.repeat(32);

/* ---------- 1. 合并文档结构 ---------- */
const bc = CFU.buildCtx(ACC);
for (const job of CFU.JOBS) {
  for (const [i, v] of job.variants.entries()) {
    const field = v.field(bc);
    const open = (field.match(/{/g) || []).length;
    const close = (field.match(/}/g) || []).length;
    assert(open === close && open > 0, `${job.id}[v${i}] field 括号平衡 (${open}/${close})`);
    assert(!/\$\w+/.test(field), `${job.id}[v${i}] 未使用未声明变量`);
    assert(DATASETS.includes(v.dataset), `${job.id}[v${i}] dataset 名已知: ${v.dataset}`);
    assert(field.startsWith(v.dataset + '('), `${job.id}[v${i}] field 以 dataset 开头`);
  }
}
assert(CFU.GROUPS.length === 2 && CFU.GROUPS.every((g) => g.members.length === 5), '10 个任务被分成 2 组');

/* ---------- 2. 首轮：合并失败 -> 逐项兜底 -> 变体纠正 ---------- */
gvStore.set('cfu.mode', 'token');
gvStore.set('cfu.token', 'tok_abc');
calls = [];
const snap1 = await CFU.collect(ACC);
console.log('首轮采集:', snap1.values, '请求数', snap1.requests);
assert(Object.keys(snap1.failed).length === 0, '首轮全部指标取到（D1 走了降级变体）');
assert(snap1.requests === 8, `首轮 HTTP 请求数 = 8（1 次被拒合并 + 5 项兜底 + d1 变体 2 次 + 1 次成功合并），实际 ${snap1.requests}`);
assert(snap1.values.workersReq === 1545, 'Workers 请求跨 script 累加 = 1545');
assert(snap1.values.kvRead === 999 && snap1.values.kvWrite === 15, 'KV 读写拆分正确');
assert(snap1.values.d1RowsRead === 42 && snap1.values.d1RowsWritten === 7, 'D1 降级口径生效');
assert(snap1.approx.d1RowsRead === true, 'D1 降级标记近似');
assert(snap1.values.queueOps === 200, 'Queues 累加 = 200');
assert(snap1.values.r2ClassA === 1500 && snap1.values.r2ClassB === 20500, 'R2 Class A/B 归类');
assert(snap1.values.r2Storage === 5_000_000_100, 'R2 存储 = payload + metadata');
assert(gvStore.get('cfu.variants').d1 === 1, '坏变体被记住并持久化（d1 -> v1）');

/* ---------- 3. 次轮：合并直接用正确变体，只 2 个请求 ---------- */
calls = [];
const snap2 = await CFU.collect(ACC);
console.log('次轮请求数:', snap2.requests, '请求:', calls.map((c) => c.query.slice(0, 40)));
assert(snap2.requests === 2, `次轮请求数降到 2，实际 ${snap2.requests}`);
assert(snap2.values.workersReq === 1545 && snap2.values.d1RowsRead === 42, '次轮数据一致');
assert(Object.keys(snap2.failed).length === 0, '次轮无失败项');

/* ---------- 4. 会话模式：403 只重试一次，且不再发 GM 请求 ---------- */
gvStore.set('cfu.mode', 'session');
forced403 = 1; // 第一个合并请求 403
calls = [];
const snap3 = await CFU.collect(ACC);
assert(calls.every((c) => c.via === 'fetch'), `会话模式下不再发 GM 请求（控制台里不会整片 403），实际 ${calls.map((c) => c.via)}`);
assert(snap3.requests >= 2 && Object.keys(snap3.values).length > 0, `403 后重试成功，取到 ${Object.keys(snap3.values).length} 项`);

/* ---------- 5. 全部 403：fatal 且不返回任何值 ---------- */
forced403 = 99;
calls = [];
const snap4 = await CFU.collect(ACC);
assert(!!snap4.fatal, '全灭时给出 fatal 原因');
assert(Object.keys(snap4.values).length === 0, '全灭时不含任何值（由 UI 决定保留旧快照）');
assert(snap4.requests <= 2, `全灭时立刻收敛，只发 ${snap4.requests} 个 HTTP 请求（含 1 次重试）`);

/* ---------- 6. Token 失效：authError 明确 ---------- */
forced403 = 0;
gvStore.set('cfu.mode', 'token');
gvStore.set('cfu.token', 'bad');
ctx.GM_xmlhttpRequest = (opts) => {
  calls.push({ via: 'gm', url: opts.url });
  setTimeout(() => opts.onload({ status: 403, responseText: JSON.stringify({ success: false, errors: [{ message: 'Invalid token' }] }) }), 0);
};
const snap5 = await CFU.collect(ACC);
assert(!!snap5.fatal && !!snap5.authError, 'Token 失效时 fatal + authError 都有值');

/* ---------- 7. 格式化 ---------- */
assert(CFU.fmtCount(100_000) === '100k', 'fmtCount(100000)=100k');
assert(CFU.fmtCount(1_500_000) === '1.5M', 'fmtCount(1500000)=1.5M');
assert(CFU.fmtBytes(1024 ** 3) === '1.00 GB', 'fmtBytes(1GiB)=1.00 GB');
assert(CFU.r2Class('DeleteObject') === 'A' && CFU.r2Class('GetObject') === 'B', 'R2 归类规则');

console.log('\n全部用例执行完毕');
process.exit(process.exitCode || 0);
