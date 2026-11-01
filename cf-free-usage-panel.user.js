// ==UserScript==
// @name         Cloudflare 免费额度用量面板
// @namespace    https://dash.cloudflare.com/cf-free-usage
// @version      1.1.0
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
 *   1) Token 模式（推荐 / 稳定）：粘贴一个只读 API Token（Account Analytics : Read），
 *      脚本用 GM_xmlhttpRequest 直连 https://api.cloudflare.com/client/v4/graphql。
 *      令牌只存在本机油猴存储，不经手任何第三方。
 *   2) 会话模式（零配置，视账号而定）：复用 dash.cloudflare.com 的登录 Cookie，
 *      POST /api/v4/graphql。控制台对脚本发起的写/查请求有 CSRF 与风控校验，
 *      部分账号会被 403 拒绝 —— 此时面板会直接提示切换 Token 模式，而不是静默变空。
 *
 * 免费额度数值来自 https://www.cloudflare.com/plans 的 Free Tier Summary，
 * 若官方调整额度，改下面 LIMITS 即可。
 */

(() => {
  'use strict';

  const GB = 1024 ** 3;
  const VERSION = '1.1.0';

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
    interval: 'cfu.interval',
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

  const gv = (o, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
  const num = (v) => (typeof v === 'number' ? v : Number(v) || 0);
  const sumOf = (rows, path) => (rows || []).reduce((a, r) => a + num(gv(r, path)), 0);
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
   * 3. GraphQL 传输层（Token / 会话 Cookie 双模式 + 详细错误信息）
   * ========================================================================= */
  class GQLError extends Error {
    constructor(message, info) {
      super(message);
      this.name = 'GQLError';
      this.status = info?.status || 0;
      this.body = info?.body || '';
      this.hint = info?.hint || '';
      this.authError = !!(this.status === 401 || this.status === 403)
        || /authentication error|unauthorized|not authorized|session has expired|invalid (api )?token|permission|权限|登录/i.test(message);
    }
  }

  const isTokenMode = () => store.get(KEY.mode, 'token') === 'token';
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

  function unwrapGraphQL(body, info) {
    if (!body) throw new GQLError(`响应不是 JSON（HTTP ${info.status}）：${clip(info.body)}`, info);
    // dash 的 REST 信封 { success, errors, result } 与标准 { data, errors } 都兼容
    const env = body.data && typeof body.data === 'object'
      ? body
      : (body.result && body.result.data ? body.result : null);
    if (!env) {
      const e = (body.errors && body.errors[0]) || null;
      const msg = (e && (e.message || e.code)) || body.message || '未知错误';
      throw new GQLError(String(msg), info);
    }
    if (env.errors && env.errors.length) {
      throw new GQLError(String(env.errors[0].message || '数据集不可用'), info);
    }
    if (!env.data) throw new GQLError('响应缺少 data 字段', info);
    return env.data;
  }

  // Token 模式：GM_xmlhttpRequest 直连官方 API，绕开页面 CSP
  async function gqlViaToken(query) {
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
    return unwrapGraphQL(res.json, info);
  }

  // 会话模式：同源 fetch 复用 Cookie；失败时再退一步用 GM 请求（不带页面 fetch 特征）
  async function gqlViaSession(query) {
    const csrf = csrfToken();
    const baseHeaders = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'X-XSRF-Token': csrf };
    let firstErr = null;

    try {
      const res = await fetch('/api/v4/graphql', {
        method: 'POST',
        credentials: 'same-origin',
        headers: baseHeaders,
        body: JSON.stringify({ query }),
      });
      let json = null;
      try { json = await res.json(); } catch (e) { /* 非 JSON */ }
      if (res.status === 200 || json) {
        const info = { status: res.status, body: json ? JSON.stringify(json) : '' };
        return unwrapGraphQL(json, info);
      }
      firstErr = new GQLError(`HTTP ${res.status}`, { status: res.status });
    } catch (e) {
      firstErr = e instanceof GQLError ? e : new GQLError(`请求失败：${e.message}`);
    }

    // 回退：用扩展发起的请求（Cookie 同样附带，但不是页面 fetch 指纹）
    try {
      const res = await gmRequest({
        method: 'POST',
        url: 'https://dash.cloudflare.com/api/v4/graphql',
        headers: baseHeaders,
        data: JSON.stringify({ query }),
        timeout: 20000,
      });
      const info = { status: res.status, body: res.text };
      if (res.status === 403) {
        throw new GQLError(
          csrf
            ? '控制台接口拒绝脚本请求（403），请改用 Token 模式'
            : '控制台接口拒绝脚本请求（403，且页面读不到 XSRF-TOKEN），请改用 Token 模式',
          { ...info, hint: 'use-token' },
        );
      }
      return unwrapGraphQL(res.json, info);
    } catch (e) {
      throw e instanceof GQLError ? e : firstErr;
    }
  }

  async function gql(query) {
    return isTokenMode() ? gqlViaToken(query) : gqlViaSession(query);
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
   * 4. 各产品的采集任务
   *    每个任务可有多个 query 变体：字段名/过滤类型在不同账号 schema 上
   *    略有差异，前一个失败则自动降级到下一个；成功的变体会被记住，
   *    下次刷新优先用它，避免每轮都重复踩坑。
   * ========================================================================= */
  const P = (c, body) => `{viewer{accounts(filter:{accountTag:"${c.acc}"}){${body}}}}`;
  const variantPick = new Map();

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
        build: (c) => P(c, `workersInvocationsAdaptive(limit:1000,filter:{datetime_geq:"${c.dayStart}",datetime_lt:"${c.dayEnd}"}){sum{requests}}`),
        extract: (d) => ({ workersReq: sumOf(account0(d).workersInvocationsAdaptive, 'sum.requests') }),
      }],
    },
    {
      id: 'kvOps', name: 'KV 操作', keys: ['kvRead', 'kvWrite'],
      variants: [{
        build: (c) => P(c, `kvOperationsAdaptiveGroups(limit:100,filter:{date_geq:"${c.today}",date_leq:"${c.today}"}){dimensions{actionType} sum{requests}}`),
        extract: (d) => {
          const rows = account0(d).kvOperationsAdaptiveGroups || [];
          let read = 0;
          let write = 0;
          for (const r of rows) {
            const n = num(gv(r, 'sum.requests'));
            if (String(gv(r, 'dimensions.actionType') || '').toLowerCase() === 'read') read += n;
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
          build: (c) => P(c, `d1AnalyticsAdaptiveGroups(limit:100,filter:{date_geq:"${c.today}",date_leq:"${c.today}"}){sum{rowsRead rowsWritten}}`),
          extract: (d) => {
            const rows = account0(d).d1AnalyticsAdaptiveGroups || [];
            return { d1RowsRead: sumOf(rows, 'sum.rowsRead'), d1RowsWritten: sumOf(rows, 'sum.rowsWritten') };
          },
        },
        {
          // 降级口径：只拿到查询条数，标记为近似值
          approx: true,
          build: (c) => P(c, `d1AnalyticsAdaptiveGroups(limit:100,filter:{date_geq:"${c.today}",date_leq:"${c.today}"}){sum{readQueries writeQueries}}`),
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
        build: (c) => P(c, `durableObjectsInvocationsAdaptiveGroups(limit:1000,filter:{date_geq:"${c.today}",date_leq:"${c.today}"}){sum{requests}}`),
        extract: (d) => ({ doRequests: sumOf(account0(d).durableObjectsInvocationsAdaptiveGroups, 'sum.requests') }),
      }],
    },
    {
      id: 'queues', name: 'Queues', keys: ['queueOps'],
      variants: [
        {
          build: (c) => P(c, `queueMessageOperationsAdaptiveGroups(limit:1000,filter:{datetime_geq:"${c.dayStart}",datetime_lt:"${c.dayEnd}"}){count}`),
          extract: (d) => ({ queueOps: sumOf(account0(d).queueMessageOperationsAdaptiveGroups, 'count') }),
        },
        {
          build: (c) => P(c, `queueMessageOperationsAdaptiveGroups(limit:1000,filter:{datetime_geq:"${c.today}",datetime_lt:"${c.tomorrow}"}){count}`),
          extract: (d) => ({ queueOps: sumOf(account0(d).queueMessageOperationsAdaptiveGroups, 'count') }),
        },
      ],
    },
    {
      id: 'ai', name: 'Workers AI', keys: ['aiNeurons'],
      variants: [
        {
          build: (c) => P(c, `aiInferenceAdaptiveGroups(limit:1000,filter:{datetime_geq:"${c.dayStart}",datetime_lt:"${c.dayEnd}"}){sum{totalNeurons}}`),
          extract: (d) => ({ aiNeurons: sumOf(account0(d).aiInferenceAdaptiveGroups, 'sum.totalNeurons') }),
        },
        {
          build: (c) => P(c, `aiInferenceAdaptiveGroups(limit:1000,filter:{datetime_geq:"${c.dayStart}",datetime_lt:"${c.dayEnd}"}){sum{neurons}}`),
          extract: (d) => ({ aiNeurons: sumOf(account0(d).aiInferenceAdaptiveGroups, 'sum.neurons') }),
        },
        {
          build: (c) => P(c, `aiInferenceAdaptiveGroups(limit:1000,filter:{datetime_geq:"${c.dayStart}",datetime_lt:"${c.dayEnd}"}){count}`),
          approx: true,
          extract: (d) => ({ aiNeurons: sumOf(account0(d).aiInferenceAdaptiveGroups, 'count') }),
        },
      ],
    },
    {
      id: 'r2Ops', name: 'R2 操作', keys: ['r2ClassA', 'r2ClassB'],
      variants: [{
        build: (c) => P(c, `r2OperationsAdaptiveGroups(limit:1000,filter:{datetime_geq:"${c.monthStart}",datetime_lt:"${c.monthEnd}"}){dimensions{actionType} sum{requests}}`),
        // Class A/B 的归类由本地规则推断
        approx: true,
        extract: (d) => {
          const rows = account0(d).r2OperationsAdaptiveGroups || [];
          let a = 0;
          let b = 0;
          for (const r of rows) {
            const n = num(gv(r, 'sum.requests'));
            if (r2Class(gv(r, 'dimensions.actionType')) === 'A') a += n; else b += n;
          }
          return { r2ClassA: a, r2ClassB: b };
        },
      }],
    },
    {
      id: 'kvStorage', name: 'KV 存储', keys: ['kvStorage'],
      variants: [{
        build: (c) => P(c, `kvStorageAdaptiveGroups(limit:100,filter:{date_geq:"${c.twoDaysAgo}",date_leq:"${c.today}"}){max{byteCount}}`),
        extract: (d) => {
          const rows = account0(d).kvStorageAdaptiveGroups || [];
          return { kvStorage: rows.reduce((m, r) => Math.max(m, num(gv(r, 'max.byteCount'))), 0) };
        },
      }],
    },
    {
      id: 'd1Storage', name: 'D1 存储', keys: ['d1Storage'],
      variants: [
        {
          build: (c) => P(c, `d1StorageAdaptiveGroups(limit:100,filter:{date_geq:"${c.twoDaysAgo}",date_leq:"${c.today}"}){max{databaseSizeBytes}}`),
          extract: (d) => {
            const rows = account0(d).d1StorageAdaptiveGroups || [];
            return { d1Storage: rows.reduce((m, r) => Math.max(m, num(gv(r, 'max.databaseSizeBytes'))), 0) };
          },
        },
        {
          build: (c) => P(c, `d1StorageAdaptiveGroups(limit:100,filter:{date_geq:"${c.twoDaysAgo}",date_leq:"${c.today}"}){max{databaseSize}}`),
          extract: (d) => {
            const rows = account0(d).d1StorageAdaptiveGroups || [];
            return { d1Storage: rows.reduce((m, r) => Math.max(m, num(gv(r, 'max.databaseSize'))), 0) };
          },
        },
      ],
    },
    {
      id: 'r2Storage', name: 'R2 存储', keys: ['r2Storage'],
      variants: [{
        build: (c) => P(c, `r2StorageAdaptiveGroups(limit:100,filter:{datetime_geq:"${c.storageStart}",datetime_lt:"${c.storageEnd}"}){max{payloadSize metadataSize}}`),
        extract: (d) => {
          const rows = account0(d).r2StorageAdaptiveGroups || [];
          return {
            r2Storage: rows.reduce((m, r) => Math.max(m, num(gv(r, 'max.payloadSize')) + num(gv(r, 'max.metadataSize'))), 0),
          };
        },
      }],
    },
  ];

  /* =========================================================================
   * 5. 采集主流程
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

  // 优先尝试上次成功的变体，失败再依次尝试其余变体
  async function runJob(job, ctx) {
    const preferred = variantPick.get(job.id) || 0;
    const order = [preferred, ...job.variants.keys()].filter((v, i, arr) => arr.indexOf(v) === i);
    let lastErr = null;
    for (const idx of order) {
      const variant = job.variants[idx];
      if (!variant) continue;
      try {
        const data = await gql(variant.build(ctx));
        variantPick.set(job.id, idx);
        return { values: variant.extract(data), approx: !!variant.approx };
      } catch (e) {
        lastErr = e;
        if (e.authError) break; // 鉴权类错误换变体也没用，直接上抛
      }
    }
    throw lastErr || new Error('采集失败');
  }

  async function collect(accountId) {
    const ctx = buildCtx(accountId);
    const result = { values: {}, approx: {}, failed: {}, diag: [], ts: Date.now() };
    const done = new Set();
    let authError = null;

    for (let i = 0; i < JOBS.length; i += 3) {
      const batch = JOBS.slice(i, i + 3);
      const settled = await Promise.allSettled(batch.map((job) => runJob(job, ctx)));
      settled.forEach((s, idx) => {
        const job = batch[idx];
        done.add(job.id);
        if (s.status === 'fulfilled') {
          Object.assign(result.values, s.value.values);
          if (s.value.approx) for (const k of job.keys) result.approx[k] = true;
        } else {
          const err = s.reason;
          for (const k of job.keys) result.failed[k] = clip(err?.message || err, 140);
          result.diag.push({
            job: job.id,
            status: err?.status || 0,
            message: clip(err?.message || err, 240),
            body: clip(err?.body, 240),
          });
          if (err?.authError && !authError) authError = err;
        }
      });
      if (authError) break; // 鉴权失败就不再打剩下的请求
    }

    if (authError) {
      result.authError = clip(authError.message, 200);
      result.authHint = authError.hint || (isTokenMode() ? 'token-invalid' : 'use-token');
      for (const job of JOBS) {
        if (done.has(job.id)) continue;
        for (const k of job.keys) result.failed[k] = '鉴权失败，已中止';
      }
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
    .body { padding: 4px 14px 14px; overflow-y: auto; }
    .body::-webkit-scrollbar, .cfg::-webkit-scrollbar, .diag::-webkit-scrollbar { width: 8px; }
    .body::-webkit-scrollbar-thumb, .cfg::-webkit-scrollbar-thumb, .diag::-webkit-scrollbar-thumb { background: #333846; border-radius: 8px; }
    .banner { margin: 8px 0 4px; padding: 10px 11px; border-radius: 10px; font-size: 11.5px; line-height: 1.7;
      background: #2a1f14; border: 1px solid #5a3d18; color: #f0c08a; }
    .banner b { color: #ffb260; }
    .banner .acts { display: flex; gap: 8px; margin-top: 8px; }
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
    .cfg label { display: flex; gap: 8px; align-items: flex-start; font-size: 12px; color: #a7aebc; margin-bottom: 8px; cursor: pointer; line-height: 1.55; }
    .cfg label b { color: #d6dae2; font-weight: 600; }
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
      row.title = failed ? `该数据集不可用：${failed}` : '暂无数据';
      row.innerHTML = `<div class="l1"><span class="name">${spec.label}</span>
        <span class="val">不可用</span><span class="pct">—</span></div>
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
    ui.meta.innerHTML = `账户 <b>${(acc && acc.name) || '当前账号'}</b> · <b>${mode}</b> · 更新于 <b>${when}</b> · 每 ${mins} 分钟刷新`;
  }

  function bannerHTML(snapshot) {
    if (!snapshot || !snapshot.authError) return '';
    const isToken = isTokenMode();
    const msg = isToken
      ? 'Token 鉴权失败：请确认令牌有效，且勾选了 <code>Account Analytics : Read</code>（Account 级别权限）。'
      : '控制台接口拒绝了脚本请求（HTTP 403）。Cloudflare 对 dash 的接口有 CSRF / 风控校验，脚本无法稳定复用 Cookie。<br>请切换到 <b>Token 模式</b>：只需一个只读令牌，1 分钟搞定。';
    return `<div class="banner"><b>数据采集失败</b><br>${msg}
      <div class="acts"><button class="btn primary" data-act="${isToken ? 'settings' : 'settings'}">${isToken ? '检查设置' : '去填 Token'}</button>
      <button class="btn" data-act="diag">查看诊断</button></div></div>`;
  }

  function renderBody() {
    if (!ui) return;
    const body = ui.body;
    body.innerHTML = '';

    if (!state.snapshot) {
      body.innerHTML = `<div class="empty">还没有数据。<br>点击右上角「刷新」开始读取。</div>`;
      return;
    }

    const banner = bannerHTML(state.snapshot);
    if (banner) body.insertAdjacentHTML('beforeend', banner);

    for (const sec of SECTIONS) {
      const wrap = document.createElement('div');
      wrap.className = 'sec';
      const h = document.createElement('div');
      h.className = 'sec-h';
      h.innerHTML = `<span>${sec.title}</span><span class="n">${sec.note}</span>`;
      wrap.appendChild(h);
      for (const key of sec.keys) wrap.appendChild(buildRow(key, state.snapshot));
      body.appendChild(wrap);
    }

    const foot = document.createElement('div');
    foot.className = 'foot';
    foot.innerHTML = `额度值来自 cloudflare.com/plans 免费套餐。<span class="star">*</span> 为近似口径。<br>v${VERSION} · <span class="star">*</span> 点进度条可查看剩余额度`;
    body.appendChild(foot);
  }

  function diagText() {
    const snap = state.snapshot;
    if (!snap || !snap.diag || !snap.diag.length) return '暂无错误记录。';
    const head = [
      `模式: ${isTokenMode() ? 'token' : 'session'}`,
      `时间: ${new Date(snap.ts).toISOString()}`,
      `账户: ${snap.accountId || '-'}`,
      snap.authError ? `鉴权错误: ${snap.authError}` : null,
      '',
    ].filter(Boolean).join('\n');
    return head + snap.diag.map((d) => `[${d.job}] HTTP ${d.status || '-'} ${d.message}${d.body ? `\n  body: ${d.body}` : ''}`).join('\n');
  }

  function renderSettings() {
    if (!ui) return;
    const cfg = ui.cfg;
    const mode = isTokenMode() ? 'token' : 'session';
    const token = getToken();
    const interval = store.get(KEY.interval, 5);
    const snap = state.snapshot;

    cfg.innerHTML = `
      <h4>数据来源</h4>
      <select data-f="mode">
        <option value="token"${mode === 'token' ? ' selected' : ''}>Token 模式（推荐，稳定）</option>
        <option value="session"${mode === 'session' ? ' selected' : ''}>会话模式（复用控制台登录，可能被 403）</option>
      </select>
      <div class="hint" data-el="modeHint"></div>

      <div data-el="tokenBox">
        <h4>API Token</h4>
        <input type="password" data-f="token" placeholder="粘贴令牌（只需 Account Analytics : Read）" value="${token.replace(/"/g, '&quot;')}">
        <div class="hint">
          生成地址：控制台 → 我的资料 → API 令牌 → 创建令牌 → 自定义令牌，权限选
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
        ? '用只读令牌直连官方 GraphQL API，不受控制台 CSRF/风控影响，最稳。'
        : '复用 dash.cloudflare.com 的登录 Cookie。部分账号会被 403 拒绝，届时请改回 Token 模式。';
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
      variantPick.clear();
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
        const data = await gql(JOBS[0].variants[0].build(ctx));
        const n = num(gv(account0(data), 'workersInvocationsAdaptive.0.sum.requests'));
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
    // URL 里的 32 位十六进制账户 ID 永远是最可靠来源，先取它
    const fromUrl = accountFromUrl();
    if (fromUrl) {
      state.accountId = fromUrl;
      store.set(KEY.account, fromUrl);
      ensureAccounts().then(() => renderMeta()).catch(() => {});
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
    setBusy(true);
    try {
      const acc = await resolveAccount();
      const snapshot = await collect(acc);
      snapshot.accountId = acc;
      state.snapshot = snapshot;
      store.set(KEY.snapshot, snapshot);
      renderMeta();
      renderBody();
      if (ui.settingsOpen) renderSettings();

      if (snapshot.authError) {
        ui.toast(isTokenMode() ? 'Token 鉴权失败，请检查设置' : '会话模式被拒绝（403），请改用 Token 模式');
      } else {
        const dead = Object.keys(snapshot.failed || {}).length;
        if (dead) ui.toast(`${dead} 项数据集不可用（悬停灰色项可见原因）`);
      }
    } catch (e) {
      const msg = clip(e && e.message ? e.message : e, 160);
      ui.toast(`读取失败：${msg}`);
      if (!state.snapshot) {
        ui.body.innerHTML = `<div class="empty">读取失败：${msg}<br><br>
          · 建议在「设置」里用 <code>Token 模式</code>（只需 Account Analytics : Read）；<br>
          · 会话模式如提示 403，是控制台的风控/CSRF 拦截，属预期。</div>`;
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
    globalThis.__CFU__ = { JOBS, LIMITS, SPECS, SECTIONS, buildCtx, collect, runJob, gql, fmt, fmtCount, fmtBytes, r2Class, store, variantPick };
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
