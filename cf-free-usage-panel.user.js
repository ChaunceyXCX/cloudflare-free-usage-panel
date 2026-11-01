// ==UserScript==
// @name         Cloudflare 免费额度用量面板
// @namespace    https://dash.cloudflare.com/cf-free-usage
// @version      1.2.0
// @description  在 Cloudflare 控制台里用进度条直观查看 Workers / KV / D1 / R2 / Queues / DO / Workers AI 等免费额度的实时使用量
// @author       chauncey
// @match        https://dash.cloudflare.com/*
// @connect      api.cloudflare.com
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * 工作原理
 * ---------
 * 数据来源是 Cloudflare 官方的 GraphQL Analytics API（账号级 dataset），
 * 也就是控制台图表背后的同一套接口。两种取数模式：
 *
 *   1) 会话模式（默认，零配置）：复用 dash.cloudflare.com 的登录 Cookie，同源 POST
 *      /api/v4/graphql。为降低被风控/限流拦下的概率：
 *        · 把 10 个 dataset 合并成 2 个 GraphQL 文档（用 alias 一次问一组）；
 *        · 遇到 403 只做一次 700ms 退避重试，绝不用扩展请求（GM 请求必被 WAF 挡）；
 *        · 合并失败才退化为逐项查询，并在两次之间留 180ms 间隔。
 *   2) Token 模式：粘贴只读 API Token（Account Analytics : Read），用 GM_xmlhttpRequest
 *      直连 https://api.cloudflare.com/client/v4/graphql。令牌只存本机油猴存储。
 *
 * 免费额度数值来自 https://www.cloudflare.com/plans 的 Free Tier Summary，
 * 若官方调整额度，改下面 LIMITS 即可。
 */

(() => {
  'use strict';

  const GB = 1024 ** 3;
  const VERSION = '1.2.0';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* =========================================================================
   * 1. 免费额度配置（来源：cloudflare.com/plans - Free Tier Summary）
   * ========================================================================= */
  const LIMITS = {
    workersReq: 100_000,          // Workers       100k 请求/天
    kvRead: 100_000,              // KV            100k 读取/天
    kvWrite: 1_000,               // KV            1k 写入+删除+列表/天
    d1RowsRead: 5_000_000,        // D1            5M 行读取/天
    d1RowsWritten: 100_000,       // D1            100k 行写入/天
    doRequests: 100_000,          // Durable Objects  100k 请求/天
    queueOps: 10_000,             // Queues        10k 操作/天
    aiNeurons: 10_000,            // Workers AI    10k neurons/天
    r2ClassA: 1_000_000,          // R2            Class A 1M/月
    r2ClassB: 10_000_000,         // R2            Class B 10M/月
    kvStorage: 1 * GB,            // KV            1 GB
    d1Storage: 5 * GB,            // D1            5 GB（账号总量）
    r2Storage: 10 * GB,           // R2            10 GB-month
  };

  const SPECS = {
    workersReq:    { label: 'Workers 请求',        kind: 'count', limit: LIMITS.workersReq },
    kvRead:        { label: 'KV 读取',             kind: 'count', limit: LIMITS.kvRead },
    kvWrite:       { label: 'KV 写入/删除/列表',   kind: 'count', limit: LIMITS.kvWrite },
    d1RowsRead:    { label: 'D1 行读取',           kind: 'count', limit: LIMITS.d1RowsRead },
    d1RowsWritten: { label: 'D1 行写入',           kind: 'count', limit: LIMITS.d1RowsWritten },
    doRequests:    { label: 'Durable Objects 请求', kind: 'count', limit: LIMITS.doRequests },
    queueOps:      { label: 'Queues 操作',         kind: 'count', limit: LIMITS.queueOps },
    aiNeurons:     { label: 'Workers AI Neurons',  kind: 'count', limit: LIMITS.aiNeurons },
    r2ClassA:      { label: 'R2 Class A 操作',     kind: 'count', limit: LIMITS.r2ClassA },
    r2ClassB:      { label: 'R2 Class B 操作',     kind: 'count', limit: LIMITS.r2ClassB },
    kvStorage:     { label: 'KV 存储',             kind: 'bytes', limit: LIMITS.kvStorage },
    d1Storage:     { label: 'D1 存储',             kind: 'bytes', limit: LIMITS.d1Storage },
    r2Storage:     { label: 'R2 存储',             kind: 'bytes', limit: LIMITS.r2Storage },
  };

  const SECTIONS = [
    { title: '每日额度', note: 'UTC 00:00 重置', keys: ['workersReq', 'kvRead', 'kvWrite', 'd1RowsRead', 'd1RowsWritten', 'doRequests', 'queueOps', 'aiNeurons'] },
    { title: '每月额度', note: '每月 1 日 UTC 00:00 重置', keys: ['r2ClassA', 'r2ClassB'] },
    { title: '存储占用', note: '近期峰值占用', keys: ['kvStorage', 'd1Storage', 'r2Storage'] },
  ];

  /* =========================================================================
   * 2. 小工具
   * ========================================================================= */
  const KEY = {
    mode: 'cfu.mode', token: 'cfu.token', account: 'cfu.account',
    accounts: 'cfu.accounts', snapshot: 'cfu.snapshot', open: 'cfu.open',
    interval: 'cfu.interval', variants: 'cfu.variants',
  };

  const store = {
    get(k, d) {
      try {
        if (typeof GM_getValue === 'function') return GM_getValue(k, d);
        const v = localStorage.getItem(k);
        return v == null ? d : JSON.parse(v);
      } catch (e) { return d; }
    },
    set(k, v) {
      try {
        if (typeof GM_setValue === 'function') GM_setValue(k, v);
        else localStorage.setItem(k, JSON.stringify(v));
      } catch (e) { /* 忽略 */ }
    },
  };

  const gq = (o, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
  const num = (v) => (typeof v === 'number' ? v : Number(v) || 0);
  const sumOf = (rows, path) => (rows || []).reduce((a, r) => a + num(gq(r, path)), 0);
  const account0 = (data) => data?.viewer?.accounts?.[0] || {};

  const isoDT = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const isoDate = (d) => d.toISOString().slice(0, 10);
  const pad2 = (n) => String(n).padStart(2, '0');
  const hhmmss = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  const clip = (s, n = 180) => String(s == null ? '' : s).replace(/\s+/g, ' ').slice(0, n);

  function fmtCount(n) {
    if (!isFinite(n)) return '—';
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (n >= 1e4) return Math.round(n / 1e3) + 'k';
    return Math.round(n).toLocaleString('en-US');
  }

  function fmtBytes(n) {
    if (!isFinite(n)) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v < 10 ? v.toFixed(2) : v.toFixed(1)} ${units[i]}`;
  }

  const fmt = (kind, n) => (kind === 'bytes' ? fmtBytes(n) : fmtCount(n));

  /* =========================================================================
   * 3. GraphQL 传输层
   * ========================================================================= */
  let httpCount = 0; // 每次真正发出的 HTTP 请求（含重试）

  class GQLError extends Error {
    constructor(message, info) {
      super(message);
      this.name = 'GQLError';
      this.status = info?.status || 0;
      this.body = info?.body || '';
      this.hint = info?.hint || '';
      // 只有「令牌/登录态」类错误才是真鉴权失败；dash 的 403 多为风控/限流
      this.authError = this.status === 401
        || /invalid (api )?token|unauthorized|authentication error|permission|权限/i.test(message);
      this.throttled = this.status === 403;
    }
  }

  // 默认会话模式：零配置，控制台登录即可用；持续 403 时面板会引导切 Token
  const isTokenMode = () => store.get(KEY.mode, 'session') === 'token';
  const getToken = () => String(store.get(KEY.token, '') || '').trim();

  function csrfToken() {
    const m = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]*)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function gmRequest({ method = 'GET', url, headers = {}, data, timeout = 20000 }) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('GM_xmlhttpRequest 不可用'));
        return;
      }
      GM_xmlhttpRequest({
        method, url, headers, data, timeout, anonymous: false,
        onload: (r) => {
          let json = null;
          try { json = JSON.parse(r.responseText); } catch (e) { /* 非 JSON */ }
          resolve({ status: r.status, json, text: r.responseText });
        },
        onerror: () => reject(new Error('网络错误：请求被阻断或无法连接')),
        ontimeout: () => reject(new Error('请求超时')),
      });
    });
  }

  // 统一解析：返回 { data, errors }，仅当整体不可用时抛错
  function parseGraphQL(body, info) {
    if (!body) throw new GQLError(`响应不是 JSON（HTTP ${info.status}）`, info);
    const env = body.data !== undefined ? body : (body.result && body.result.data !== undefined ? body.result : null);
    if (!env) {
      const e = (body.errors && body.errors[0]) || null;
      const msg = (e && (e.message || e.code)) || body.message || `HTTP ${info.status}`;
      throw new GQLError(String(msg), info);
    }
    if (env.data == null) {
      const msg = (env.errors && env.errors[0] && env.errors[0].message) || '数据集不可用';
      throw new GQLError(String(msg), info);
    }
    return { data: env.data, errors: env.errors || [] };
  }

  async function requestToken(query) {
    httpCount += 1;
    const token = getToken();
    if (!token) throw new GQLError('未配置 API Token，请到「设置」填入', { hint: 'token-empty' });
    const res = await gmRequest({
      method: 'POST',
      url: 'https://api.cloudflare.com/client/v4/graphql',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      data: JSON.stringify({ query }),
      timeout: 20000,
    });
    const info = { status: res.status, body: res.text };
    if (res.status === 401 || res.status === 403) {
      throw new GQLError('Token 无效或权限不足（需要 Account Analytics : Read）', info);
    }
    return parseGraphQL(res.json, info);
  }

  /*
   * 会话模式只走同源 fetch：
   * 扩展发起的请求（GM_xhr）会被控制台 WAF 一律判 403，重试只是徒增一片控制台报错，
   * 所以只在 fetch 抛网络异常（CSP/离线）时才退到 GM。
   */
  async function requestSession(query) {
    const csrf = csrfToken();
    const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'X-XSRF-Token': csrf };
    let res;
    httpCount += 1;
    try {
      res = await fetch('/api/v4/graphql', {
        method: 'POST',
        credentials: 'same-origin',
        headers,
        body: JSON.stringify({ query }),
      });
    } catch (e) {
      // 页面上下文请求发不出去（CSP/网络层），退到扩展请求再试一次
      httpCount += 1;
      const r2 = await gmRequest({
        method: 'POST',
        url: 'https://dash.cloudflare.com/api/v4/graphql',
        headers,
        data: JSON.stringify({ query }),
        timeout: 20000,
      });
      return parseGraphQL(r2.json, { status: r2.status, body: r2.text });
    }
    let json = null;
    try { json = await res.json(); } catch (e) { /* 可能是 HTML 拦截页 */ }
    if (res.status === 403) {
      throw new GQLError('控制台接口返回 403（风控/限流或登录态失效）', { status: 403, body: json ? clip(JSON.stringify(json), 200) : '' });
    }
    return parseGraphQL(json, { status: res.status, body: json ? '' : '' });
  }

  // 403 只做一次短退避重试（并发突发常被判风控，间隔后又好使）
  async function gql(query, { retryOn403 = true } = {}) {
    const run = () => (isTokenMode() ? requestToken(query) : requestSession(query));
    try {
      return await run();
    } catch (e) {
      if (retryOn403 && e.status === 403) {
        await sleep(700);
        return run();
      }
      throw e;
    }
  }

  async function apiGet(pathAndQuery) {
    if (isTokenMode()) {
      const token = getToken();
      if (!token) throw new Error('未配置 API Token');
      const res = await gmRequest({
        url: `https://api.cloudflare.com/client/v4${pathAndQuery}`,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      if (!res.json) throw new Error(`HTTP ${res.status}`);
      if (!res.json.success) throw new Error(res.json.errors?.[0]?.message || `HTTP ${res.status}`);
      return res.json.result;
    }
    const res = await fetch(`/api/v4${pathAndQuery}`, { credentials: 'same-origin' });
    const json = await res.json().catch(() => null);
    if (!json || !json.success) throw new Error(json?.errors?.[0]?.message || `HTTP ${res.status}`);
    return json.result;
  }

  /* =========================================================================
   * 4. 采集任务定义
   *    每个任务可有多个变体（字段名在不同账号 schema 上略有差异），
   *    前一个失败自动降级；成功的变体会被记住并持久化。
   * ========================================================================= */
  const P = (c, body) => `{viewer{accounts(filter:{accountTag:"${c.acc}"}){${body}}}}`;
  const wrapDataset = (dataset, rows) => ({ viewer: { accounts: [{ [dataset]: rows }] } });

  const savedVariants = store.get(KEY.variants, {}) || {};
  const variantPick = new Map(Object.entries(savedVariants).map(([k, v]) => [k, Number(v) || 0]));

  function rememberVariant(jobId, idx) {
    variantPick.set(jobId, idx);
    const obj = {};
    for (const [k, v] of variantPick) obj[k] = v;
    store.set(KEY.variants, obj);
  }

  const R2_CLASS_A = new Set([
    'PutObject', 'CopyObject', 'CreateMultipartUpload', 'CompleteMultipartUpload', 'UploadPart',
    'UploadPartCopy', 'AbortMultipartUpload', 'DeleteObject', 'DeleteObjects', 'DeleteBucket',
    'ListObjects', 'ListObjectsV2', 'ListBuckets', 'ListMultipartUploads', 'ListParts',
    'PutBucketCors', 'PutBucketLifecycleConfiguration', 'PutBucketEncryption', 'PutBucketPolicy',
    'GetBucketLocation', 'LifecycleStorageTransition',
  ]);

  function r2Class(actionType) {
    const a = String(actionType || '');
    if (R2_CLASS_A.has(a)) return 'A';
    if (/^(Get|Head)/i.test(a)) return 'B';
    return /^(List|Put|Copy|Delete|Create|Complete|Abort|Upload)/i.test(a) ? 'A' : 'B';
  }

  const JOBS = [
    {
      id: 'workers', name: 'Workers', keys: ['workersReq'],
      variants: [{
        dataset: 'workersInvocationsAdaptive',
        field: (c) => `workersInvocationsAdaptive(limit:1000,filter:{datetime_geq:"${c.dayStart}",datetime_lt:"${c.dayEnd}"}){sum{requests}}`,
        extract: (d) => ({ workersReq: sumOf(account0(d).workersInvocationsAdaptive, 'sum.requests') }),
      }],
    },
    {
      id: 'kvOps', name: 'KV 操作', keys: ['kvRead', 'kvWrite'],
      variants: [{
        dataset: 'kvOperationsAdaptiveGroups',
        field: (c) => `kvOperationsAdaptiveGroups(limit:100,filter:{date_geq:"${c.today}",date_leq:"${c.today}"}){dimensions{actionType} sum{requests}}`,
        extract: (d) => {
          const rows = account0(d).kvOperationsAdaptiveGroups || [];
          let read = 0;
          let write = 0;
          for (const r of rows) {
            const n = num(gq(r, 'sum.requests'));
            if (String(gq(r, 'dimensions.actionType') || '').toLowerCase() === 'read') read += n;
            else write += n;
          }
          return { kvRead: read, kvWrite: write };
        },
      }],
    },
    {
      id: 'd1', name: 'D1', keys: ['d1RowsRead', 'd1RowsWritten'],
      variants: [
        {
          dataset: 'd1AnalyticsAdaptiveGroups',
          field: (c) => `d1AnalyticsAdaptiveGroups(limit:100,filter:{date_geq:"${c.today}",date_leq:"${c.today}"}){sum{rowsRead rowsWritten}}`,
          extract: (d) => {
            const rows = account0(d).d1AnalyticsAdaptiveGroups || [];
            return { d1RowsRead: sumOf(rows, 'sum.rowsRead'), d1RowsWritten: sumOf(rows, 'sum.rowsWritten') };
          },
        },
        {
          dataset: 'd1AnalyticsAdaptiveGroups',
          approx: true, // 降级口径：只拿到查询条数
          field: (c) => `d1AnalyticsAdaptiveGroups(limit:100,filter:{date_geq:"${c.today}",date_leq:"${c.today}"}){sum{readQueries writeQueries}}`,
          extract: (d) => {
            const rows = account0(d).d1AnalyticsAdaptiveGroups || [];
            return { d1RowsRead: sumOf(rows, 'sum.readQueries'), d1RowsWritten: sumOf(rows, 'sum.writeQueries') };
          },
        },
      ],
    },
    {
      id: 'do', name: 'Durable Objects', keys: ['doRequests'],
      variants: [{
        dataset: 'durableObjectsInvocationsAdaptiveGroups',
        field: (c) => `durableObjectsInvocationsAdaptiveGroups(limit:1000,filter:{date_geq:"${c.today}",date_leq:"${c.today}"}){sum{requests}}`,
        extract: (d) => ({ doRequests: sumOf(account0(d).durableObjectsInvocationsAdaptiveGroups, 'sum.requests') }),
      }],
    },
    {
      id: 'queues', name: 'Queues', keys: ['queueOps'],
      variants: [
        {
          dataset: 'queueMessageOperationsAdaptiveGroups',
          field: (c) => `queueMessageOperationsAdaptiveGroups(limit:1000,filter:{datetime_geq:"${c.dayStart}",datetime_lt:"${c.dayEnd}"}){count}`,
          extract: (d) => ({ queueOps: sumOf(account0(d).queueMessageOperationsAdaptiveGroups, 'count') }),
        },
        {
          dataset: 'queueMessageOperationsAdaptiveGroups',
          field: (c) => `queueMessageOperationsAdaptiveGroups(limit:1000,filter:{datetime_geq:"${c.today}",datetime_lt:"${c.tomorrow}"}){count}`,
          extract: (d) => ({ queueOps: sumOf(account0(d).queueMessageOperationsAdaptiveGroups, 'count') }),
        },
      ],
    },
    {
      id: 'ai', name: 'Workers AI', keys: ['aiNeurons'],
      variants: [
        {
          dataset: 'aiInferenceAdaptiveGroups',
          field: (c) => `aiInferenceAdaptiveGroups(limit:1000,filter:{datetime_geq:"${c.dayStart}",datetime_lt:"${c.dayEnd}"}){sum{totalNeurons}}`,
          extract: (d) => ({ aiNeurons: sumOf(account0(d).aiInferenceAdaptiveGroups, 'sum.totalNeurons') }),
        },
        {
          dataset: 'aiInferenceAdaptiveGroups',
          field: (c) => `aiInferenceAdaptiveGroups(limit:1000,filter:{datetime_geq:"${c.dayStart}",datetime_lt:"${c.dayEnd}"}){sum{neurons}}`,
          extract: (d) => ({ aiNeurons: sumOf(account0(d).aiInferenceAdaptiveGroups, 'sum.neurons') }),
        },
        {
          dataset: 'aiInferenceAdaptiveGroups',
          approx: true,
          field: (c) => `aiInferenceAdaptiveGroups(limit:1000,filter:{datetime_geq:"${c.dayStart}",datetime_lt:"${c.dayEnd}"}){count}`,
          extract: (d) => ({ aiNeurons: sumOf(account0(d).aiInferenceAdaptiveGroups, 'count') }),
        },
      ],
    },
    {
      id: 'r2Ops', name: 'R2 操作', keys: ['r2ClassA', 'r2ClassB'],
      variants: [{
        dataset: 'r2OperationsAdaptiveGroups',
        approx: true, // Class A/B 的归类由本地规则推断
        field: (c) => `r2OperationsAdaptiveGroups(limit:1000,filter:{datetime_geq:"${c.monthStart}",datetime_lt:"${c.monthEnd}"}){dimensions{actionType} sum{requests}}`,
        extract: (d) => {
          const rows = account0(d).r2OperationsAdaptiveGroups || [];
          let a = 0;
          let b = 0;
          for (const r of rows) {
            const n = num(gq(r, 'sum.requests'));
            if (r2Class(gq(r, 'dimensions.actionType')) === 'A') a += n; else b += n;
          }
          return { r2ClassA: a, r2ClassB: b };
        },
      }],
    },
    {
      id: 'kvStorage', name: 'KV 存储', keys: ['kvStorage'],
      variants: [{
        dataset: 'kvStorageAdaptiveGroups',
        field: (c) => `kvStorageAdaptiveGroups(limit:100,filter:{date_geq:"${c.twoDaysAgo}",date_leq:"${c.today}"}){max{byteCount}}`,
        extract: (d) => {
          const rows = account0(d).kvStorageAdaptiveGroups || [];
          return { kvStorage: rows.reduce((m, r) => Math.max(m, num(gq(r, 'max.byteCount'))), 0) };
        },
      }],
    },
    {
      id: 'd1Storage', name: 'D1 存储', keys: ['d1Storage'],
      variants: [
        {
          dataset: 'd1StorageAdaptiveGroups',
          field: (c) => `d1StorageAdaptiveGroups(limit:100,filter:{date_geq:"${c.twoDaysAgo}",date_leq:"${c.today}"}){max{databaseSizeBytes}}`,
          extract: (d) => {
            const rows = account0(d).d1StorageAdaptiveGroups || [];
            return { d1Storage: rows.reduce((m, r) => Math.max(m, num(gq(r, 'max.databaseSizeBytes'))), 0) };
          },
        },
        {
          dataset: 'd1StorageAdaptiveGroups',
          field: (c) => `d1StorageAdaptiveGroups(limit:100,filter:{date_geq:"${c.twoDaysAgo}",date_leq:"${c.today}"}){max{databaseSize}}`,
          extract: (d) => {
            const rows = account0(d).d1StorageAdaptiveGroups || [];
            return { d1Storage: rows.reduce((m, r) => Math.max(m, num(gq(r, 'max.databaseSize'))), 0) };
          },
        },
      ],
    },
    {
      id: 'r2Storage', name: 'R2 存储', keys: ['r2Storage'],
      variants: [{
        dataset: 'r2StorageAdaptiveGroups',
        field: (c) => `r2StorageAdaptiveGroups(limit:100,filter:{datetime_geq:"${c.storageStart}",datetime_lt:"${c.storageEnd}"}){max{payloadSize metadataSize}}`,
        extract: (d) => {
          const rows = account0(d).r2StorageAdaptiveGroups || [];
          return {
            r2Storage: rows.reduce((m, r) => Math.max(m, num(gq(r, 'max.payloadSize')) + num(gq(r, 'max.metadataSize'))), 0),
          };
        },
      }],
    },
  ];

  const JOB_BY_ID = new Map(JOBS.map((j) => [j.id, j]));

  // 按过滤器类型分组，同组 dataset 可以合并进一个 GraphQL 文档（用 alias）
  const GROUPS = [
    { id: 'date', jobs: ['kvOps', 'd1', 'do', 'kvStorage', 'd1Storage'] },
    { id: 'datetime', jobs: ['workers', 'queues', 'ai', 'r2Ops', 'r2Storage'] },
  ].map((g) => ({ ...g, members: g.jobs.map((id) => JOB_BY_ID.get(id)) }));

  /* =========================================================================
   * 5. 采集流程
   * ========================================================================= */
  function buildCtx(accountId) {
    const now = new Date();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const plusHour = new Date(now.getTime() + 3600e3);
    return {
      acc: accountId,
      today: isoDate(now),
      tomorrow: isoDate(new Date(now.getTime() + 864e5)),
      twoDaysAgo: isoDate(new Date(now.getTime() - 48 * 3600e3)),
      dayStart: isoDT(dayStart),
      dayEnd: isoDT(new Date(dayStart.getTime() + 864e5)),
      monthStart: isoDT(monthStart),
      monthEnd: isoDT(plusHour),
      storageStart: isoDT(new Date(now.getTime() - 24 * 3600e3)),
      storageEnd: isoDT(plusHour),
    };
  }

  const currentVariant = (job) => job.variants[variantPick.get(job.id) || 0] || job.variants[0];

  function applyValues(result, job, values, approx) {
    Object.assign(result.values, values);
    if (approx) for (const k of job.keys) result.approx[k] = true;
  }

  function markFailed(result, job, message) {
    const msg = clip(message || '数据集不可用', 140);
    for (const k of job.keys) result.failed[k] = msg;
    result.diag.push({ job: job.id, message: clip(message, 240) });
  }

  // 合并查询：一次请求拿一组 dataset，逐个 alias 判定成败
  async function runGroup(group, ctx, result) {
    const parts = [];
    const map = [];
    group.members.forEach((job, i) => {
      const vi = variantPick.get(job.id) || 0;
      const variant = job.variants[vi] || job.variants[0];
      parts.push(`a${i}: ${variant.field(ctx)}`);
      map.push({ job, alias: `a${i}`, vi });
    });
    result.requests += 1; // 统计「尝试次数」，失败的那次也算，便于诊断真实开销
    const { data, errors } = await gql(P(ctx, parts.join(' ')));

    let anyOk = false;
    for (const { job, alias, vi } of map) {
      const variant = job.variants[vi] || job.variants[0];
      const rows = gq(data, `viewer.accounts.0.${alias}`);
      if (rows == null) {
        const err = errors.find((e) => Array.isArray(e.path) && e.path.includes(alias));
        markFailed(result, job, err ? err.message : '该数据集在合并查询中无返回');
        continue;
      }
      anyOk = true;
      applyValues(result, job, variant.extract(wrapDataset(variant.dataset, rows)), variant.approx);
    }
    return anyOk;
  }

  // 单项查询（合并失败时的兜底，也负责把坏变体纠正掉）
  async function runJob(job, ctx, result) {
    const order = [variantPick.get(job.id) || 0, ...job.variants.keys()].filter((v, i, a) => a.indexOf(v) === i);
    let lastErr = null;
    for (const idx of order) {
      const variant = job.variants[idx];
      if (!variant) continue;
      try {
        result.requests += 1;
        const { data, errors } = await gql(P(ctx, variant.field(ctx)));
        if (errors && errors.length) throw new GQLError(errors[0].message || '数据集不可用');
        rememberVariant(job.id, idx);
        applyValues(result, job, variant.extract(data), variant.approx);
        return true;
      } catch (e) {
        lastErr = e;
        // 鉴权失败换变体没用；被风控（403）换变体也没用，直接上报节流
        if (e.authError) break;
        if (e.throttled) {
          markFailed(result, job, e.message);
          return 'throttled';
        }
      }
    }
    markFailed(result, job, lastErr ? lastErr.message : '采集失败');
    return 'failed';
  }

  async function collect(accountId) {
    const ctx = buildCtx(accountId);
    httpCount = 0;
    const result = { values: {}, approx: {}, failed: {}, diag: [], ts: Date.now(), requests: 0 };
    let throttleErr = null;

    const markGroupFailed = (group, message) => {
      for (const job of group.members) {
        const alreadyDone = job.keys.every((k) => k in result.values || k in result.failed);
        if (!alreadyDone) markFailed(result, job, message);
      }
    };

    for (const group of GROUPS) {
      if (throttleErr) {
        // 已经判定被拦，剩余分组不再浪费请求
        markGroupFailed(group, throttleErr.message);
        continue;
      }

      let groupOk = false;
      let blocked = null;
      try {
        groupOk = await runGroup(group, ctx, result);
      } catch (e) {
        if (e.authError || e.throttled) blocked = e;
      }

      if (!groupOk) {
        if (blocked) {
          // 网络层就被拒（403 且重试仍失败）：逐项重试没有意义
          throttleErr = blocked;
          markGroupFailed(group, blocked.message);
          continue;
        }
        // 合并文档校验失败等：逐项兜底，串行 + 间隔，避免再触发风控
        for (const job of group.members) {
          if (throttleErr) {
            markGroupFailed(group, throttleErr.message);
            break;
          }
          const alreadyDone = job.keys.every((k) => k in result.values || k in result.failed);
          if (alreadyDone) continue;
          const st = await runJob(job, ctx, result);
          if (st === 'throttled') throttleErr = new GQLError('控制台接口 403（风控/限流）', { status: 403 });
          await sleep(180);
        }
      }
    }

    result.requests = httpCount;

    const gotAny = Object.keys(result.values).length > 0;
    if (!gotAny && throttleErr) {
      result.fatal = throttleErr.message;
      result.fatalStatus = throttleErr.status || 0;
      result.authError = throttleErr.authError ? throttleErr.message : '';
    } else if (!gotAny) {
      const first = Object.values(result.failed)[0] || '未取到任何数据';
      result.fatal = String(first);
    }
    return result;
  }

  /* =========================================================================
   * 6. UI
   * ========================================================================= */
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
    .launcher {
      position: fixed; right: 22px; bottom: 22px; z-index: 2147483000;
      width: 46px; height: 46px; border-radius: 50%; border: none; cursor: pointer;
      background: linear-gradient(135deg, #f6821f, #e8620a);
      color: #fff; font-size: 15px; font-weight: 700; letter-spacing: .5px;
      box-shadow: 0 6px 20px rgba(0,0,0,.35); transition: transform .15s ease, box-shadow .15s ease;
    }
    .launcher:hover { transform: translateY(-2px); box-shadow: 0 10px 26px rgba(246,130,31,.45); }
    .panel {
      position: fixed; right: 22px; bottom: 22px; z-index: 2147483000;
      width: 396px; max-height: min(78vh, 760px); display: flex; flex-direction: column;
      background: #16181d; color: #e7e9ee; border: 1px solid #2a2e37; border-radius: 14px;
      box-shadow: 0 18px 50px rgba(0,0,0,.55); overflow: hidden; font-size: 13px;
    }
    .panel[data-hidden="1"] { display: none; }
    header {
      display: flex; align-items: center; gap: 8px; padding: 12px 14px;
      background: #1b1e25; border-bottom: 1px solid #262a33;
    }
    header .t { font-size: 13.5px; font-weight: 650; letter-spacing: .2px; }
    header .dot { width: 7px; height: 7px; border-radius: 50%; background: #f6821f; box-shadow: 0 0 8px #f6821f; }
    header .sp { flex: 1; }
    .btn {
      border: 1px solid #333846; background: #23272f; color: #cfd4de; cursor: pointer;
      border-radius: 8px; padding: 4px 9px; font-size: 12px; line-height: 1.4; transition: .15s;
      font-family: inherit;
    }
    .btn:hover { background: #2c313b; color: #fff; border-color: #454b5b; }
    .btn:disabled { opacity: .55; cursor: default; }
    .btn.primary { background: #f6821f; border-color: #f6821f; color: #1a1207; font-weight: 650; }
    .btn.primary:hover { background: #ff9330; border-color: #ff9330; }
    .meta { padding: 8px 14px; font-size: 11.5px; color: #8b93a3; display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    .meta b { color: #b9c0cd; font-weight: 600; }
    .meta .stale { color: #f0c08a; }
    .body { padding: 4px 14px 14px; overflow-y: auto; }
    .body::-webkit-scrollbar, .cfg::-webkit-scrollbar, .diag::-webkit-scrollbar { width: 8px; }
    .body::-webkit-scrollbar-thumb, .cfg::-webkit-scrollbar-thumb, .diag::-webkit-scrollbar-thumb { background: #333846; border-radius: 8px; }
    .banner { margin: 8px 0 4px; padding: 10px 11px; border-radius: 10px; font-size: 11.5px; line-height: 1.7;
      background: #2a1f14; border: 1px solid #5a3d18; color: #f0c08a; }
    .banner b { color: #ffb260; }
    .banner .acts { display: flex; gap: 8px; margin-top: 8px; }
    .notice { margin: 8px 0 0; padding: 7px 10px; border-radius: 8px; font-size: 11px; line-height: 1.6;
      background: #1e2128; border: 1px solid #2c313b; color: #9aa2b1; }
    .sec { margin-top: 12px; }
    .sec-h { display: flex; align-items: baseline; gap: 8px; font-size: 11px; letter-spacing: .6px;
      color: #7f8798; text-transform: uppercase; margin-bottom: 8px; }
    .sec-h .n { color: #5d6473; text-transform: none; letter-spacing: 0; font-size: 10.5px; }
    .row { margin-bottom: 10px; }
    .row .l1 { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
    .row .name { font-size: 12.5px; color: #d6dae2; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .row .val { font-size: 11.5px; color: #8b93a3; font-variant-numeric: tabular-nums; }
    .row .pct { font-size: 12px; font-weight: 650; font-variant-numeric: tabular-nums; min-width: 46px; text-align: right; }
    .bar { height: 6px; border-radius: 99px; background: #242832; overflow: hidden; }
    .bar > i { display: block; height: 100%; border-radius: 99px; transition: width .45s cubic-bezier(.4,0,.2,1); }
    .row.warn .bar > i { box-shadow: 0 0 10px rgba(245,158,11,.7); }
    .row.over .bar > i { box-shadow: 0 0 12px rgba(239,68,68,.85); animation: pulse 1.6s infinite; }
    @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .6 } }
    .star { color: #f6821f; font-size: 10px; margin-left: 2px; }
    .row.dead .name { color: #6b7280; }
    .row.dead .bar { background: repeating-linear-gradient(90deg, #23262e, #23262e 4px, #1c1f26 4px, #1c1f26 8px); }
    .row.dead .pct { color: #6b7280; font-weight: 500; font-size: 11px; }
    .row.dead .val { color: #5b6270; }
    .foot { padding: 8px 0 2px; font-size: 10.5px; color: #5f6674; border-top: 1px solid #22252c; margin-top: 10px; }
    .empty { padding: 22px 6px; text-align: center; color: #8b93a3; font-size: 12px; line-height: 1.8; }
    .empty code, .cfg code, .banner code { background: #23272f; padding: 1px 5px; border-radius: 4px; color: #d3a06a; font-size: 11px; }
    .cfg { padding: 4px 14px 16px; overflow-y: auto; }
    .cfg h4 { margin: 14px 0 8px; font-size: 12px; color: #c8cdd8; font-weight: 600; }
    .cfg h4:first-child { margin-top: 8px; }
    .cfg input[type=text], .cfg input[type=password], .cfg select {
      width: 100%; background: #1d2027; border: 1px solid #333846; color: #e7e9ee;
      border-radius: 8px; padding: 7px 9px; font-size: 12px; outline: none; font-family: inherit;
    }
    .cfg input:focus, .cfg select:focus { border-color: #f6821f; }
    .cfg .hint { font-size: 10.5px; color: #6f7787; line-height: 1.65; margin: 6px 0 10px; }
    .cfg .ops { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
    .diag { margin-top: 10px; max-height: 150px; overflow: auto; background: #101216; border: 1px solid #262a33;
      border-radius: 8px; padding: 8px 10px; font-size: 10.5px; color: #97a0b0; line-height: 1.6; white-space: pre-wrap;
      word-break: break-all; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .toast { position: absolute; left: 14px; right: 14px; bottom: 12px; padding: 8px 10px; border-radius: 8px;
      background: #2a1d1d; border: 1px solid #54302f; color: #f0a9a2; font-size: 11.5px; display: none; }
    .toast.on { display: block; }
  `;

  const HOST_ID = 'cfu-panel-host';

  function pctColor(p) {
    if (p >= 90) return '#ef4444';
    if (p >= 70) return '#f59e0b';
    return '#22c55e';
  }

  function buildRow(key, snapshot) {
    const spec = SPECS[key];
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.key = key;

    const failed = snapshot && snapshot.failed ? snapshot.failed[key] : null;
    const value = snapshot && snapshot.values ? snapshot.values[key] : undefined;

    if (failed || value === undefined || value === null || Number.isNaN(value)) {
      row.classList.add('dead');
      row.title = failed ? `该数据集本次未取到：${failed}` : '暂无数据';
      row.innerHTML = `<div class="l1"><span class="name">${spec.label}</span>
        <span class="val">未取到</span><span class="pct">—</span></div>
        <div class="bar"><i style="width:0%"></i></div>`;
      return row;
    }

    const limit = spec.limit;
    const pct = limit > 0 ? (value / limit) * 100 : 0;
    const shown = Math.max(0, Math.min(pct, 100));
    const color = pctColor(pct);
    const approx = snapshot.approx && snapshot.approx[key] ? '<span class="star" title="近似口径">*</span>' : '';

    if (pct >= 100) row.classList.add('over');
    else if (pct >= 70) row.classList.add('warn');

    row.title = `已用 ${fmt(spec.kind, value)} / 额度 ${fmt(spec.kind, limit)} · 剩余 ${fmt(spec.kind, Math.max(0, limit - value))}`;
    row.innerHTML = `<div class="l1">
        <span class="name">${spec.label}${approx}</span>
        <span class="val">${fmt(spec.kind, value)} / ${fmt(spec.kind, limit)}</span>
        <span class="pct" style="color:${color}">${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%</span>
      </div>
      <div class="bar"><i style="width:${shown}%;background:linear-gradient(90deg,${color}b3,${color})"></i></div>`;
    return row;
  }

  function mount() {
    if (document.getElementById(HOST_ID)) return null;
    const host = document.createElement('div');
    host.id = HOST_ID;
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    const launcher = document.createElement('button');
    launcher.className = 'launcher';
    launcher.textContent = 'CF';
    launcher.title = '查看 Cloudflare 免费额度用量（Alt+U）';
    root.appendChild(launcher);

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `
      <header>
        <span class="dot"></span>
        <span class="t">免费额度用量</span>
        <span class="sp"></span>
        <button class="btn" data-act="refresh">刷新</button>
        <button class="btn" data-act="settings">设置</button>
        <button class="btn" data-act="close">×</button>
      </header>
      <div class="meta" data-el="meta"></div>
      <div class="body" data-el="body"><div class="empty">正在读取用量…</div></div>
      <div class="cfg" data-el="cfg" style="display:none"></div>
      <div class="toast" data-el="toast"></div>`;
    root.appendChild(panel);

    const ui = {
      host, root, panel, launcher,
      meta: panel.querySelector('[data-el=meta]'),
      body: panel.querySelector('[data-el=body]'),
      cfg: panel.querySelector('[data-el=cfg]'),
      toastEl: panel.querySelector('[data-el=toast]'),
      settingsOpen: false,
    };

    ui.toast = (msg) => {
      ui.toastEl.textContent = msg;
      ui.toastEl.classList.add('on');
      clearTimeout(ui.toastTimer);
      ui.toastTimer = setTimeout(() => ui.toastEl.classList.remove('on'), 6000);
    };
    return ui;
  }

  /* =========================================================================
   * 7. 控制器
   * ========================================================================= */
  const state = {
    accounts: [],
    accountId: null,
    snapshot: store.get(KEY.snapshot, null),
    loading: false,
    timer: null,
    lastRefreshAt: 0,
    staleNotice: '',
  };

  let ui = null;

  function setBusy(busy) {
    if (!ui) return;
    state.loading = busy;
    const btn = ui.panel.querySelector('[data-act=refresh]');
    if (btn) {
      btn.textContent = busy ? '读取中…' : '刷新';
      btn.disabled = busy;
    }
  }

  function renderMeta() {
    if (!ui) return;
    const acc = state.accounts.find((a) => a.id === state.accountId);
    const snap = state.snapshot;
    const when = snap && snap.ts ? hhmmss(new Date(snap.ts)) : '—';
    const mins = store.get(KEY.interval, 5);
    const mode = isTokenMode() ? 'Token 模式' : '会话模式';
    const stale = state.staleNotice ? ` · <span class="stale">${state.staleNotice}</span>` : '';
    ui.meta.innerHTML = `账户 <b>${(acc && acc.name) || '当前账号'}</b> · <b>${mode}</b> · 更新于 <b>${when}</b> · 每 ${mins} 分钟刷新${stale}`;
  }

  function renderBody() {
    if (!ui) return;
    const body = ui.body;
    body.innerHTML = '';

    if (!state.snapshot) {
      body.innerHTML = `<div class="empty">还没有数据。<br>点击右上角「刷新」开始读取。</div>`;
      return;
    }

    const snap = state.snapshot;
    if (snap.fatal) {
      const isToken = isTokenMode();
      const msg = isToken && snap.authError
        ? 'Token 鉴权失败：请确认令牌有效，并勾选了 <code>Account Analytics : Read</code>。'
        : `所有数据集都没取到：${clip(snap.fatal, 120)}<br>会话模式偶发 403 属控制台风控，可直接再点一次刷新；持续失败请改用 Token 模式。`;
      body.insertAdjacentHTML('beforeend', `<div class="banner"><b>数据采集失败</b><br>${msg}
        <div class="acts"><button class="btn primary" data-act="settings">${isToken ? '检查设置' : '切换 Token 模式'}</button>
        <button class="btn" data-act="diag">查看诊断</button></div></div>`);
    } else if (Object.keys(snap.failed || {}).length) {
      body.insertAdjacentHTML('beforeend', `<div class="notice">有 ${Object.keys(snap.failed).length} 项本次未取到（灰色行），其余正常。悬停灰色行可看原因。</div>`);
    }

    for (const sec of SECTIONS) {
      const wrap = document.createElement('div');
      wrap.className = 'sec';
      const h = document.createElement('div');
      h.className = 'sec-h';
      h.innerHTML = `<span>${sec.title}</span><span class="n">${sec.note}</span>`;
      wrap.appendChild(h);
      for (const key of sec.keys) wrap.appendChild(buildRow(key, snap));
      body.appendChild(wrap);
    }

    const foot = document.createElement('div');
    foot.className = 'foot';
    foot.innerHTML = `额度值来自 cloudflare.com/plans 免费套餐。<span class="star">*</span> 为近似口径。<br>v${VERSION} · 本次 ${snap.requests || 0} 个 GraphQL 请求 · 点进度条看剩余额度`;
    body.appendChild(foot);
  }

  function diagText() {
    const snap = state.snapshot;
    const lines = [
      `版本: v${VERSION}`,
      `模式: ${isTokenMode() ? 'token' : 'session'}`,
      `时间: ${snap && snap.ts ? new Date(snap.ts).toISOString() : '-'}`,
      `账户: ${(snap && snap.accountId) || '-'}`,
      `GraphQL 请求数: ${(snap && snap.requests) || 0}`,
      `成功指标: ${snap ? Object.keys(snap.values || {}).join(',') || '-' : '-'}`,
      snap && snap.fatal ? `致命错误: ${snap.fatal}` : null,
      '',
    ].filter((x) => x !== null);
    if (!snap || !snap.diag || !snap.diag.length) return lines.concat('暂无任务级错误记录。').join('\n');
    return lines.concat(snap.diag.map((d) => `[${d.job}] ${d.message}`)).join('\n');
  }

  function renderSettings() {
    if (!ui) return;
    const cfg = ui.cfg;
    const mode = isTokenMode() ? 'token' : 'session';
    const token = getToken();
    const interval = store.get(KEY.interval, 5);

    cfg.innerHTML = `
      <h4>数据来源</h4>
      <select data-f="mode">
        <option value="session"${mode === 'session' ? ' selected' : ''}>会话模式（零配置，复用控制台登录）</option>
        <option value="token"${mode === 'token' ? ' selected' : ''}>Token 模式（只读令牌，最稳）</option>
      </select>
      <div class="hint" data-el="modeHint"></div>

      <div data-el="tokenBox">
        <h4>API Token</h4>
        <input type="password" data-f="token" placeholder="粘贴令牌（只需 Account Analytics : Read）" value="${token.replace(/"/g, '&quot;')}">
        <div class="hint">
          生成路径：头像 → 我的资料 → API 令牌 → 创建令牌 → 自定义令牌，权限选
          <code>Account</code> / <code>Account Analytics</code> / <code>Read</code>。
          令牌仅存于本机油猴存储，只用于请求 <code>api.cloudflare.com</code>。
        </div>
      </div>

      <h4>自动刷新间隔</h4>
      <select data-f="interval">
        ${[1, 2, 5, 10, 15, 30].map((m) => `<option value="${m}"${Number(interval) === m ? ' selected' : ''}>${m} 分钟</option>`).join('')}
      </select>

      <div class="ops">
        <button class="btn primary" data-act="save">保存并刷新</button>
        <button class="btn" data-act="test">测试连接</button>
        <button class="btn" data-act="clearcache">清除缓存</button>
      </div>

      <h4>诊断信息</h4>
      <div class="diag" data-el="diag"></div>
      <div class="ops"><button class="btn" data-act="copy">复制诊断</button></div>`;

    const tokenBox = cfg.querySelector('[data-el=tokenBox]');
    const modeHint = cfg.querySelector('[data-el=modeHint]');
    const diagEl = cfg.querySelector('[data-el=diag]');

    const syncMode = () => {
      const m = cfg.querySelector('[data-f=mode]').value;
      tokenBox.style.display = m === 'token' ? 'block' : 'none';
      modeHint.innerHTML = m === 'token'
        ? '用只读令牌直连官方 GraphQL API，不受控制台 CSRF/风控影响。'
        : '复用 dash 登录 Cookie（每轮仅 2 个合并请求）。偶发 403 是控制台风控，重试即可；持续失败建议改用 Token 模式。';
    };
    syncMode();
    cfg.querySelector('[data-f=mode]').addEventListener('change', syncMode);

    diagEl.textContent = diagText();

    cfg.querySelector('[data-act=save]').addEventListener('click', async () => {
      const nextMode = cfg.querySelector('[data-f=mode]').value;
      const nextToken = cfg.querySelector('[data-f=token]').value.trim();
      const nextInterval = Number(cfg.querySelector('[data-f=interval]').value) || 5;
      if (nextMode === 'token' && !nextToken) {
        ui.toast('Token 模式需要填写 API Token');
        return;
      }
      store.set(KEY.mode, nextMode);
      store.set(KEY.token, nextToken);
      store.set(KEY.interval, nextInterval);
      store.set(KEY.accounts, []);
      state.accounts = [];
      state.staleNotice = '';
      ui.toast('设置已保存，正在刷新…');
      showSettings(false);
      scheduleAutoRefresh();
      await refresh(true);
    });

    cfg.querySelector('[data-act=test]').addEventListener('click', async () => {
      const m = cfg.querySelector('[data-f=mode]').value;
      const tk = cfg.querySelector('[data-f=token]').value.trim();
      store.set(KEY.mode, m);
      store.set(KEY.token, tk);
      if (m === 'token' && !tk) { ui.toast('请先填写 Token'); return; }
      diagEl.textContent = '正在测试…';
      try {
        const acc = await resolveAccount();
        const ctx = buildCtx(acc);
        const { data } = await gql(P(ctx, currentVariant(JOB_BY_ID.get('workers')).field(ctx)));
        const n = num(gq(account0(data), 'workersInvocationsAdaptive.0.sum.requests'));
        diagEl.textContent = `✓ 连接成功\n模式: ${m}\n账户: ${acc}\n今日 Workers 请求: ${fmtCount(n)}`;
        ui.toast('连接成功');
      } catch (e) {
        diagEl.textContent = `✗ 连接失败\n模式: ${m}\nHTTP: ${e.status || '-'}\n错误: ${e.message || e}${e.body ? `\nbody: ${clip(e.body, 300)}` : ''}`;
        ui.toast(`连接失败：${clip(e.message || e, 80)}`);
      }
    });

    cfg.querySelector('[data-act=clearcache]').addEventListener('click', () => {
      store.set(KEY.snapshot, null);
      state.snapshot = null;
      state.staleNotice = '';
      renderBody();
      renderMeta();
      diagEl.textContent = '暂无错误记录。';
      ui.toast('已清除本地缓存');
    });

    cfg.querySelector('[data-act=copy]').addEventListener('click', async () => {
      const text = diagText();
      try {
        if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('clipboard unavailable');
        await navigator.clipboard.writeText(text);
        ui.toast('诊断信息已复制');
      } catch (e) {
        ui.toast('复制失败，请手动选择文本');
      }
    });
  }

  function showSettings(open) {
    if (!ui) return;
    ui.settingsOpen = open;
    ui.cfg.style.display = open ? 'block' : 'none';
    ui.body.style.display = open ? 'none' : 'block';
    const btn = ui.panel.querySelector('[data-act=settings]');
    if (btn) btn.textContent = open ? '返回' : '设置';
    if (open) {
      renderSettings();
      ui.cfg.scrollTop = 0;
    }
  }

  function togglePanel(open) {
    if (!ui) return;
    const next = open === undefined ? ui.panel.dataset.hidden !== '1' ? false : true : open;
    ui.panel.dataset.hidden = next ? '0' : '1';
    ui.launcher.style.display = next ? 'none' : 'block';
    store.set(KEY.open, next);
    if (next) {
      showSettings(false);
      renderMeta();
      renderBody();
      const stale = !state.snapshot || Date.now() - (state.snapshot.ts || 0) > 60_000;
      if (stale && !state.loading) refresh();
    }
  }

  function accountFromUrl() {
    const hay = `${location.pathname}${location.hash}`;
    const m = hay.match(/\/([0-9a-f]{32})(?:\/|$)/i);
    return m ? m[1] : null;
  }

  async function ensureAccounts() {
    if (state.accounts.length) return state.accounts;
    let list = store.get(KEY.accounts, []);
    if (!Array.isArray(list) || !list.length) {
      const raw = await apiGet('/accounts?per_page=50');
      list = (raw || []).map((a) => ({ id: a.id, name: a.name }));
      store.set(KEY.accounts, list);
    }
    state.accounts = list;
    return list;
  }

  async function resolveAccount() {
    const fromUrl = accountFromUrl();
    if (fromUrl) {
      state.accountId = fromUrl;
      store.set(KEY.account, fromUrl);
      if (!state.accounts.length) ensureAccounts().then(() => renderMeta()).catch(() => {});
      return fromUrl;
    }
    await ensureAccounts().catch(() => {});
    const saved = state.accounts.length ? store.get(KEY.account, null) : null;
    if (saved && state.accounts.some((a) => a.id === saved)) {
      state.accountId = saved;
      return saved;
    }
    if (state.accounts.length) {
      state.accountId = state.accounts[0].id;
      store.set(KEY.account, state.accountId);
      return state.accountId;
    }
    throw new Error('未找到账户 ID：请先打开任意一个账户页面（URL 形如 /<账户ID>/…）');
  }

  async function refresh(force) {
    if (!ui) return;
    if (state.loading && !force) return;
    // 防抖：2 秒内重复触发（展开面板 + 点击刷新）直接忽略，避免自己把自己打到风控
    if (!force && Date.now() - state.lastRefreshAt < 2000) return;
    state.lastRefreshAt = Date.now();
    setBusy(true);
    try {
      const acc = await resolveAccount();
      const snapshot = await collect(acc);
      snapshot.accountId = acc;

      const gotAny = Object.keys(snapshot.values).length > 0;
      const hadGood = state.snapshot && Object.keys(state.snapshot.values || {}).length > 0;

      if (!gotAny && hadGood) {
        // 本轮全灭但上次有数据：保留旧快照，不要用空数据把面板清空
        state.staleNotice = `${hhmmss(new Date())} 刷新失败，展示上次数据`;
        if (snapshot.fatal && isTokenMode()) {
          state.snapshot.fatal = snapshot.fatal;
          state.snapshot.authError = snapshot.authError;
        }
        ui.toast(`刷新失败（${clip(snapshot.fatal || '未取到数据', 60)}），已保留上次数据`);
      } else {
        state.staleNotice = '';
        state.snapshot = snapshot;
        store.set(KEY.snapshot, snapshot);
        if (snapshot.fatal) {
          ui.toast(`采集失败：${clip(snapshot.fatal, 70)}`);
        } else {
          const dead = Object.keys(snapshot.failed || {}).length;
          if (dead) ui.toast(`${dead} 项未取到（灰色行），其余正常`);
        }
      }

      renderMeta();
      renderBody();
      if (ui.settingsOpen) renderSettings();
    } catch (e) {
      const msg = clip(e && e.message ? e.message : e, 160);
      ui.toast(`读取失败：${msg}`);
      if (!state.snapshot) {
        ui.body.innerHTML = `<div class="empty">读取失败：${msg}<br><br>
          · 建议在「设置」里用 <code>Token 模式</code>（只需 Account Analytics : Read）；<br>
          · 会话模式偶发 403 是控制台风控，重试即可。</div>`;
      }
    } finally {
      setBusy(false);
    }
  }

  function scheduleAutoRefresh() {
    clearInterval(state.timer);
    const mins = Number(store.get(KEY.interval, 5)) || 5;
    state.timer = setInterval(() => {
      if (ui && ui.panel.dataset.hidden === '0' && !state.loading) refresh();
    }, Math.max(1, mins) * 60_000);
  }

  function bind() {
    ui.launcher.addEventListener('click', () => togglePanel(true));
    ui.panel.addEventListener('click', (ev) => {
      const t = ev.target.closest('[data-act]');
      if (!t) {
        const row = ev.target.closest('.row');
        if (row && row.title) ui.toast(row.title);
        return;
      }
      const act = t.dataset.act;
      if (act === 'close') togglePanel(false);
      if (act === 'refresh') refresh(true);
      if (act === 'settings') showSettings(!ui.settingsOpen);
      if (act === 'diag') {
        showSettings(true);
        const el = ui.cfg.querySelector('[data-el=diag]');
        try { if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' }); } catch (e) { /* 忽略 */ }
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.altKey && (e.key === 'u' || e.key === 'U')) {
        e.preventDefault();
        togglePanel();
      }
    }, true);
  }

  function init() {
    ui = mount();
    if (!ui) return;
    bind();
    state.snapshot = state.snapshot || store.get(KEY.snapshot, null);
    if (state.snapshot && state.snapshot.accountId) state.accountId = state.snapshot.accountId;
    renderMeta();
    renderBody();
    scheduleAutoRefresh();

    const open = store.get(KEY.open, false);
    ui.panel.dataset.hidden = open ? '0' : '1';
    ui.launcher.style.display = open ? 'none' : 'block';
    if (open) refresh();
  }

  // 调试/测试接口（控制台输入 __CFU__ 即可查看内部能力）
  try {
    globalThis.__CFU__ = {
      VERSION, JOBS, GROUPS, LIMITS, SPECS, SECTIONS, buildCtx, collect, runJob, runGroup,
      gql, fmt, fmtCount, fmtBytes, r2Class, store, variantPick,
    };
  } catch (e) { /* 忽略 */ }

  // 非浏览器环境（单元测试）只导出接口，不挂载 UI
  if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;

  try {
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('打开免费额度面板', () => togglePanel(true));
      GM_registerMenuCommand('立即刷新用量', () => refresh(true));
    }
  } catch (e) { /* 忽略 */ }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
