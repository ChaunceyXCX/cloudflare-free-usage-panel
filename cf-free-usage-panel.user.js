// ==UserScript==
// @name         Cloudflare 免费额度用量面板 / Free Tier Usage Panel
// @namespace    https://dash.cloudflare.com/cf-free-usage
// @version      1.4.0
// @description  在 Cloudflare 控制台用进度条查看 Workers / KV / D1 / R2 / Queues / DO / Workers AI 免费额度占用（中/英切换）
// @author       chauncey
// @homepageURL  https://github.com/ChaunceyXCX/cloudflare-free-usage-panel
// @supportURL   https://github.com/ChaunceyXCX/cloudflare-free-usage-panel/issues
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
 * 工作原理 / How it works
 * ----------------------
 * 数据来自 Cloudflare 官方 GraphQL Analytics API（账号级 dataset），即控制台图表背后的同一套接口。
 * Data comes from Cloudflare's official GraphQL Analytics API (account-level datasets) — the same
 * endpoints the dashboard charts use.
 *
 *   1) 会话模式（默认，零配置）/ Session mode (default, zero-config)
 *      复用 dash.cloudflare.com 登录 Cookie，同源 POST /api/v4/graphql。
 *      10 个 dataset 合并成 2 个 GraphQL 文档（alias），403 只做一次 700ms 退避重试；
 *      绝不用扩展请求兜底（GM 请求必被 WAF 挡，只会刷出成片 403）。
 *   2) Token 模式 / Token mode
 *      粘贴只读 API Token（Account Analytics : Read），用 GM_xmlhttpRequest 直连
 *      https://api.cloudflare.com/client/v4/graphql。令牌只存本机油猴存储。
 *
 * 免费额度数值来自 https://www.cloudflare.com/plans 的 Free Tier Summary，
 * 官方调整额度后改 LIMITS 即可。/ Quotas from the free tier summary; tweak LIMITS if they change.
 */

(() => {
  'use strict';

  const GB = 1024 ** 3;
  const VERSION = '1.4.0';
  const REPO_URL = 'https://github.com/ChaunceyXCX/cloudflare-free-usage-panel';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* =========================================================================
   * 1. 免费额度 / Free-tier quotas
   * ========================================================================= */
  const LIMITS = {
    workersReq: 100_000,          // Workers          100k requests/day
    kvRead: 100_000,              // KV               100k reads/day
    kvWrite: 1_000,               // KV               1k write+delete+list/day
    d1RowsRead: 5_000_000,        // D1               5M rows read/day
    d1RowsWritten: 100_000,       // D1               100k rows written/day
    doRequests: 100_000,          // Durable Objects  100k requests/day
    queueOps: 10_000,             // Queues           10k operations/day
    aiNeurons: 10_000,            // Workers AI       10k neurons/day
    r2ClassA: 1_000_000,          // R2               Class A 1M/month
    r2ClassB: 10_000_000,         // R2               Class B 10M/month
    kvStorage: 1 * GB,            // KV               1 GB
    d1Storage: 5 * GB,            // D1               5 GB (account total)
    r2Storage: 10 * GB,           // R2               10 GB-month
  };

  const SPECS = {
    workersReq:    { labelKey: 'metric.workersReq',    kind: 'count', limit: LIMITS.workersReq },
    kvRead:        { labelKey: 'metric.kvRead',        kind: 'count', limit: LIMITS.kvRead },
    kvWrite:       { labelKey: 'metric.kvWrite',       kind: 'count', limit: LIMITS.kvWrite },
    d1RowsRead:    { labelKey: 'metric.d1RowsRead',    kind: 'count', limit: LIMITS.d1RowsRead },
    d1RowsWritten: { labelKey: 'metric.d1RowsWritten', kind: 'count', limit: LIMITS.d1RowsWritten },
    doRequests:    { labelKey: 'metric.doRequests',    kind: 'count', limit: LIMITS.doRequests },
    queueOps:      { labelKey: 'metric.queueOps',      kind: 'count', limit: LIMITS.queueOps },
    aiNeurons:     { labelKey: 'metric.aiNeurons',     kind: 'count', limit: LIMITS.aiNeurons },
    r2ClassA:      { labelKey: 'metric.r2ClassA',      kind: 'count', limit: LIMITS.r2ClassA },
    r2ClassB:      { labelKey: 'metric.r2ClassB',      kind: 'count', limit: LIMITS.r2ClassB },
    kvStorage:     { labelKey: 'metric.kvStorage',     kind: 'bytes', limit: LIMITS.kvStorage },
    d1Storage:     { labelKey: 'metric.d1Storage',     kind: 'bytes', limit: LIMITS.d1Storage },
    r2Storage:     { labelKey: 'metric.r2Storage',     kind: 'bytes', limit: LIMITS.r2Storage },
  };

  const SECTIONS = [
    { titleKey: 'sec.daily', noteKey: 'sec.dailyNote', keys: ['workersReq', 'kvRead', 'kvWrite', 'd1RowsRead', 'd1RowsWritten', 'doRequests', 'queueOps', 'aiNeurons'] },
    { titleKey: 'sec.monthly', noteKey: 'sec.monthlyNote', keys: ['r2ClassA', 'r2ClassB'] },
    { titleKey: 'sec.storage', noteKey: 'sec.storageNote', keys: ['kvStorage', 'd1Storage', 'r2Storage'] },
  ];

  /* =========================================================================
   * 2. i18n
   * ========================================================================= */
  const I18N = {
    zh: {
      'app.title': '免费额度用量',
      'app.launcher': '查看 Cloudflare 免费额度用量（Alt+U）',
      'btn.refresh': '刷新',
      'btn.refreshing': '读取中…',
      'btn.settings': '设置',
      'btn.back': '返回',
      'meta.account': '账户',
      'meta.updated': '更新于',
      'meta.every': '每 {n} 分钟刷新',
      'mode.session': '会话模式',
      'mode.token': 'Token 模式',
      'meta.stale': '{time} 刷新失败，展示上次数据',

      'sec.daily': '每日额度',
      'sec.dailyNote': 'UTC 00:00 重置',
      'sec.monthly': '每月额度',
      'sec.monthlyNote': '每月 1 日 UTC 00:00 重置',
      'sec.storage': '存储占用',
      'sec.storageNote': '近期峰值占用',

      'metric.workersReq': 'Workers 请求',
      'metric.kvRead': 'KV 读取',
      'metric.kvWrite': 'KV 写入/删除/列表',
      'metric.d1RowsRead': 'D1 行读取',
      'metric.d1RowsWritten': 'D1 行写入',
      'metric.doRequests': 'Durable Objects 请求',
      'metric.queueOps': 'Queues 操作',
      'metric.aiNeurons': 'Workers AI Neurons',
      'metric.r2ClassA': 'R2 Class A 操作',
      'metric.r2ClassB': 'R2 Class B 操作',
      'metric.kvStorage': 'KV 存储',
      'metric.d1Storage': 'D1 存储',
      'metric.r2Storage': 'R2 存储',

      'row.notFetched': '未取到',
      'row.failedTip': '该数据集本次未取到：{msg}',
      'row.noData': '暂无数据',
      'row.detail': '已用 {used} / 额度 {limit} · 剩余 {left}',
      'row.approx': '近似口径',

      'status.fail': '数据采集失败',
      'status.tokenAuth': 'Token 鉴权失败：请确认令牌有效，并勾选了 <code>Account Analytics : Read</code>。',
      'status.allFailed': '所有数据集都没取到：{msg}<br>会话模式偶发 403 属控制台风控，可直接再点一次刷新；持续失败请改用 Token 模式。',
      'status.checkSettings': '检查设置',
      'status.switchToken': '切换 Token 模式',
      'status.diag': '查看诊断',
      'notice.partial': '有 {n} 项本次未取到（灰色行），其余正常。悬停灰色行可看原因。',

      'foot.source': '额度值来自 cloudflare.com/plans 免费套餐。* 为近似口径。',
      'foot.meta': 'v{ver} · 本次 {n} 个 GraphQL 请求 · 点进度条看剩余额度',
      'foot.star': '★ Star 支持',
      'star.title': '如果这个脚本帮到了你，点个 star 呗',
      'star.body': '开源、无后端、不改你的账号设置。',
      'star.cta': '★ 去 Star',
      'star.later': '以后再说',
      'star.thanks': '已记下，谢谢！',

      'empty.loading': '正在读取用量…',
      'empty.noData': '还没有数据。<br>点击右上角「刷新」开始读取。',
      'empty.fail': '读取失败：{msg}',
      'empty.hint': '· 建议在「设置」里用 <code>Token 模式</code>（只需 Account Analytics : Read）；<br>· 会话模式偶发 403 是控制台风控，重试即可。',

      'settings.source': '数据来源',
      'settings.modeSession': '会话模式（零配置，复用控制台登录）',
      'settings.modeToken': 'Token 模式（只读令牌，最稳）',
      'settings.modeHintSession': '复用 dash 登录 Cookie（每轮仅 2 个合并请求）。偶发 403 是控制台风控，重试即可；持续失败建议改用 Token 模式。',
      'settings.modeHintToken': '用只读令牌直连官方 GraphQL API，不受控制台 CSRF/风控影响。',
      'settings.token': 'API Token',
      'settings.tokenPlaceholder': '粘贴令牌（只需 Account Analytics : Read）',
      'settings.tokenHint': '生成路径：头像 → 我的资料 → API 令牌 → 创建令牌 → 自定义令牌，权限选 <code>Account</code> / <code>Account Analytics</code> / <code>Read</code>。令牌仅存于本机油猴存储，只用于请求 <code>api.cloudflare.com</code>。',
      'settings.interval': '自动刷新间隔',
      'settings.minutes': '{n} 分钟',
      'settings.language': '界面语言',
      'settings.langAuto': '跟随浏览器',
      'settings.langZh': '简体中文',
      'settings.langEn': 'English',
      'settings.save': '保存并刷新',
      'settings.test': '测试连接',
      'settings.clearcache': '清除缓存',
      'settings.resetpos': '重置位置',
      'settings.repo': 'GitHub 仓库',
      'settings.diag': '诊断信息',
      'settings.copy': '复制诊断',
      'settings.testing': '正在测试…',
      'settings.testOk': '✓ 连接成功\n模式: {mode}\n账户: {acc}\n今日 Workers 请求: {n}',
      'settings.testFail': '✗ 连接失败\n模式: {mode}\nHTTP: {status}\n错误: {msg}',
      'settings.diagNone': '暂无任务级错误记录。',

      'diag.version': '版本',
      'diag.mode': '模式',
      'diag.time': '时间',
      'diag.account': '账户',
      'diag.requests': 'GraphQL 请求数',
      'diag.success': '成功指标',
      'diag.fatal': '致命错误',

      'toast.saved': '设置已保存，正在刷新…',
      'toast.needToken': 'Token 模式需要填写 API Token',
      'toast.cacheCleared': '已清除本地缓存',
      'toast.copied': '诊断信息已复制',
      'toast.copyFail': '复制失败，请手动选择文本',
      'toast.posReset': '位置已重置',
      'toast.staleKept': '刷新失败（{msg}），已保留上次数据',
      'toast.partialDead': '{n} 项未取到（灰色行），其余正常',
      'toast.collectFail': '采集失败：{msg}',
      'toast.readFail': '读取失败：{msg}',
      'toast.connOk': '连接成功',
      'toast.connFail': '连接失败：{msg}',
      'toast.needTokenFirst': '请先填写 Token',

      'err.tokenEmpty': '未配置 API Token，请到「设置」填入',
      'err.tokenInvalid': 'Token 无效或权限不足（需要 Account Analytics : Read）',
      'err.forbidden': '控制台接口返回 403（风控/限流或登录态失效）',
      'err.throttled': '控制台接口 403（风控/限流）',
      'err.network': '网络错误：请求被阻断或无法连接',
      'err.timeout': '请求超时',
      'err.notJson': '响应不是 JSON（HTTP {status}）',
      'err.noData': '数据集不可用',
      'err.missingData': '响应缺少 data 字段',
      'err.noAccount': '未找到账户 ID：请先打开任意一个账户页面（URL 形如 /<账户ID>/…）',
      'err.combinedNoRows': '该数据集在合并查询中无返回',
      'err.collectFailed': '采集失败',
      'err.noTokenMode': '未配置 API Token',
    },
    en: {
      'app.title': 'Free tier usage',
      'app.launcher': 'Cloudflare free-tier usage (Alt+U)',
      'btn.refresh': 'Refresh',
      'btn.refreshing': 'Loading…',
      'btn.settings': 'Settings',
      'btn.back': 'Back',
      'meta.account': 'Account',
      'meta.updated': 'updated',
      'meta.every': 'auto-refresh {n} min',
      'mode.session': 'Session mode',
      'mode.token': 'Token mode',
      'meta.stale': '{time} refresh failed, showing last data',

      'sec.daily': 'Daily quota',
      'sec.dailyNote': 'resets 00:00 UTC',
      'sec.monthly': 'Monthly quota',
      'sec.monthlyNote': 'resets on the 1st, 00:00 UTC',
      'sec.storage': 'Storage',
      'sec.storageNote': 'recent peak',

      'metric.workersReq': 'Workers requests',
      'metric.kvRead': 'KV reads',
      'metric.kvWrite': 'KV writes/deletes/lists',
      'metric.d1RowsRead': 'D1 rows read',
      'metric.d1RowsWritten': 'D1 rows written',
      'metric.doRequests': 'Durable Objects requests',
      'metric.queueOps': 'Queues operations',
      'metric.aiNeurons': 'Workers AI neurons',
      'metric.r2ClassA': 'R2 Class A operations',
      'metric.r2ClassB': 'R2 Class B operations',
      'metric.kvStorage': 'KV storage',
      'metric.d1Storage': 'D1 storage',
      'metric.r2Storage': 'R2 storage',

      'row.notFetched': 'n/a',
      'row.failedTip': 'Not fetched this round: {msg}',
      'row.noData': 'No data',
      'row.detail': 'Used {used} / quota {limit} · {left} left',
      'row.approx': 'approximate',

      'status.fail': 'Collection failed',
      'status.tokenAuth': 'Token rejected: make sure it is valid and has <code>Account Analytics : Read</code>.',
      'status.allFailed': 'Nothing could be fetched: {msg}<br>A sporadic 403 in session mode is the dashboard\u2019s bot protection — just refresh again. If it persists, switch to Token mode.',
      'status.checkSettings': 'Check settings',
      'status.switchToken': 'Switch to Token mode',
      'status.diag': 'Diagnostics',
      'notice.partial': '{n} item(s) not fetched (grey rows). Hover a grey row for the reason.',

      'foot.source': 'Quotas from the cloudflare.com/plans free tier. * = approximate.',
      'foot.meta': 'v{ver} · {n} GraphQL requests this round · click a bar for the remainder',
      'foot.star': '★ Star',
      'star.title': 'If this panel helped, a star goes a long way',
      'star.body': 'Open source, no backend, never touches your account settings. ',
      'star.cta': '★ Star on GitHub',
      'star.later': 'Maybe later',
      'star.thanks': 'Noted — thanks!',

      'empty.loading': 'Loading usage…',
      'empty.noData': 'No data yet.<br>Hit “Refresh” in the top right.',
      'empty.fail': 'Failed: {msg}',
      'empty.hint': '· Recommended: switch to <code>Token mode</code> in Settings (needs Account Analytics : Read);<br>· A sporadic 403 in session mode is the dashboard’s bot protection — retry first.',

      'settings.source': 'Data source',
      'settings.modeSession': 'Session mode (zero-config, reuses dashboard login)',
      'settings.modeToken': 'Token mode (read-only token, most reliable)',
      'settings.modeHintSession': 'Reuses your dashboard cookies (2 merged requests per round). Sporadic 403s are bot protection — retry; if it keeps failing, switch to Token mode.',
      'settings.modeHintToken': 'Talks to the official GraphQL API with a read-only token, unaffected by dashboard CSRF/bot checks.',
      'settings.token': 'API Token',
      'settings.tokenPlaceholder': 'Paste a token (needs Account Analytics : Read)',
      'settings.tokenHint': 'Create it at avatar → My Profile → API Tokens → Create Token → Custom token, permission <code>Account</code> / <code>Account Analytics</code> / <code>Read</code>. The token stays in local userscript storage and is only sent to <code>api.cloudflare.com</code>.',
      'settings.interval': 'Auto-refresh interval',
      'settings.minutes': '{n} min',
      'settings.language': 'Language',
      'settings.langAuto': 'Follow browser',
      'settings.langZh': '简体中文',
      'settings.langEn': 'English',
      'settings.save': 'Save & refresh',
      'settings.test': 'Test connection',
      'settings.clearcache': 'Clear cache',
      'settings.resetpos': 'Reset position',
      'settings.repo': 'GitHub repo',
      'settings.diag': 'Diagnostics',
      'settings.copy': 'Copy diagnostics',
      'settings.testing': 'Testing…',
      'settings.testOk': '✓ Connected\nmode: {mode}\naccount: {acc}\nWorkers requests today: {n}',
      'settings.testFail': '✗ Connection failed\nmode: {mode}\nHTTP: {status}\nerror: {msg}',
      'settings.diagNone': 'No task-level errors.',

      'diag.version': 'Version',
      'diag.mode': 'Mode',
      'diag.time': 'Time',
      'diag.account': 'Account',
      'diag.requests': 'GraphQL requests',
      'diag.success': 'Metrics collected',
      'diag.fatal': 'Fatal',

      'toast.saved': 'Saved — refreshing…',
      'toast.needToken': 'Token mode needs an API token',
      'toast.cacheCleared': 'Local cache cleared',
      'toast.copied': 'Diagnostics copied',
      'toast.copyFail': 'Copy failed — select the text manually',
      'toast.posReset': 'Position reset',
      'toast.staleKept': 'Refresh failed ({msg}) — kept the previous data',
      'toast.partialDead': '{n} item(s) not fetched (grey rows)',
      'toast.collectFail': 'Collection failed: {msg}',
      'toast.readFail': 'Failed: {msg}',
      'toast.connOk': 'Connected',
      'toast.connFail': 'Connection failed: {msg}',
      'toast.needTokenFirst': 'Please paste a token first',

      'err.tokenEmpty': 'No API token configured — open Settings',
      'err.tokenInvalid': 'Invalid token or missing permission (needs Account Analytics : Read)',
      'err.forbidden': 'Dashboard API returned 403 (bot protection, rate limit or expired session)',
      'err.throttled': 'Dashboard API 403 (bot protection / rate limit)',
      'err.network': 'Network error: request blocked or unreachable',
      'err.timeout': 'Request timed out',
      'err.notJson': 'Response was not JSON (HTTP {status})',
      'err.noData': 'Dataset unavailable',
      'err.missingData': 'Response has no data field',
      'err.noAccount': 'No account id found — open any account page first (URL like /<account-id>/…)',
      'err.combinedNoRows': 'no rows returned in the merged query',
      'err.collectFailed': 'Collection failed',
      'err.noTokenMode': 'No API token configured',
    },
  };

  let LANG = 'zh';

  function t(key, vars) {
    const dict = I18N[LANG] || I18N.zh;
    const s = dict[key] != null ? dict[key] : (I18N.zh[key] != null ? I18N.zh[key] : key);
    if (!vars) return s;
    return s.replace(/\{(\w+)\}/g, (m, name) => (vars[name] != null ? String(vars[name]) : ''));
  }

  /* =========================================================================
   * 3. 存储与小工具 / Storage & helpers
   * ========================================================================= */
  const KEY = {
    mode: 'cfu.mode', token: 'cfu.token', account: 'cfu.account',
    accounts: 'cfu.accounts', snapshot: 'cfu.snapshot', open: 'cfu.open',
    interval: 'cfu.interval', variants: 'cfu.variants',
    launcherPos: 'cfu.launcherPos', panelPos: 'cfu.panelPos',
    lang: 'cfu.lang', starPrompt: 'cfu.starPromptDone',
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
      } catch (e) { /* ignore */ }
    },
  };

  function resolveLang() {
    const pref = store.get(KEY.lang, 'auto');
    if (pref === 'zh' || pref === 'en') return pref;
    const nav = (typeof navigator !== 'undefined' && (navigator.language || navigator.userLanguage)) || 'zh';
    return /^zh/i.test(nav) ? 'zh' : 'en';
  }

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
   * 4. GraphQL 传输层 / Transport
   * ========================================================================= */
  let httpCount = 0; // 真正发出的 HTTP 请求数（含重试）

  class GQLError extends Error {
    constructor(message, info) {
      super(message);
      this.name = 'GQLError';
      this.status = info?.status || 0;
      this.body = info?.body || '';
      this.hint = info?.hint || '';
      this.authError = this.status === 401
        || /invalid (api )?token|unauthorized|authentication error|permission|权限/i.test(message);
      this.throttled = this.status === 403;
    }
  }

  const isTokenMode = () => store.get(KEY.mode, 'session') === 'token';
  const getToken = () => String(store.get(KEY.token, '') || '').trim();

  function csrfToken() {
    const m = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]*)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function gmRequest({ method = 'GET', url, headers = {}, data, timeout = 20000 }) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new GQLError(t('err.network')));
        return;
      }
      GM_xmlhttpRequest({
        method, url, headers, data, timeout, anonymous: false,
        onload: (r) => {
          let json = null;
          try { json = JSON.parse(r.responseText); } catch (e) { /* not JSON */ }
          resolve({ status: r.status, json, text: r.responseText });
        },
        onerror: () => reject(new GQLError(t('err.network'))),
        ontimeout: () => reject(new GQLError(t('err.timeout'))),
      });
    });
  }

  function parseGraphQL(body, info) {
    if (!body) throw new GQLError(t('err.notJson', { status: info.status }), info);
    const env = body.data !== undefined ? body : (body.result && body.result.data !== undefined ? body.result : null);
    if (!env) {
      const e = (body.errors && body.errors[0]) || null;
      const msg = (e && (e.message || e.code)) || body.message || `HTTP ${info.status}`;
      throw new GQLError(String(msg), info);
    }
    if (env.data == null) {
      const msg = (env.errors && env.errors[0] && env.errors[0].message) || t('err.noData');
      throw new GQLError(String(msg), info);
    }
    return { data: env.data, errors: env.errors || [] };
  }

  async function requestToken(query) {
    httpCount += 1;
    const token = getToken();
    if (!token) throw new GQLError(t('err.tokenEmpty'), { hint: 'token-empty' });
    const res = await gmRequest({
      method: 'POST',
      url: 'https://api.cloudflare.com/client/v4/graphql',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      data: JSON.stringify({ query }),
      timeout: 20000,
    });
    const info = { status: res.status, body: res.text };
    if (res.status === 401 || res.status === 403) throw new GQLError(t('err.tokenInvalid'), info);
    return parseGraphQL(res.json, info);
  }

  /*
   * 会话模式只走同源 fetch：扩展发起的请求（GM_xhr）会被控制台 WAF 一律判 403，
   * 重试只是徒增一片控制台报错，所以只在 fetch 抛网络异常时才退到 GM。
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
    try { json = await res.json(); } catch (e) { /* may be an HTML block page */ }
    if (res.status === 403) {
      throw new GQLError(t('err.forbidden'), { status: 403, body: json ? clip(JSON.stringify(json), 200) : '' });
    }
    return parseGraphQL(json, { status: res.status, body: '' });
  }

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
      if (!token) throw new GQLError(t('err.noTokenMode'));
      const res = await gmRequest({
        url: `https://api.cloudflare.com/client/v4${pathAndQuery}`,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      if (!res.json) throw new GQLError(`HTTP ${res.status}`);
      if (!res.json.success) throw new GQLError(res.json.errors?.[0]?.message || `HTTP ${res.status}`);
      return res.json.result;
    }
    const res = await fetch(`/api/v4${pathAndQuery}`, { credentials: 'same-origin' });
    const json = await res.json().catch(() => null);
    if (!json || !json.success) throw new GQLError(json?.errors?.[0]?.message || `HTTP ${res.status}`);
    return json.result;
  }

  /* =========================================================================
   * 5. 采集任务 / Jobs
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
      id: 'kvOps', name: 'KV operations', keys: ['kvRead', 'kvWrite'],
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
          approx: true, // 降级口径：只有查询条数 / fallback: query counts only
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
      id: 'r2Ops', name: 'R2 operations', keys: ['r2ClassA', 'r2ClassB'],
      variants: [{
        dataset: 'r2OperationsAdaptiveGroups',
        approx: true, // Class A/B 归类由本地规则推断 / class mapping is inferred locally
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
      id: 'kvStorage', name: 'KV storage', keys: ['kvStorage'],
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
      id: 'd1Storage', name: 'D1 storage', keys: ['d1Storage'],
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
      id: 'r2Storage', name: 'R2 storage', keys: ['r2Storage'],
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

  // 按过滤器类型分组，同组 dataset 合并进一个 GraphQL 文档（alias）
  const GROUPS = [
    { id: 'date', jobs: ['kvOps', 'd1', 'do', 'kvStorage', 'd1Storage'] },
    { id: 'datetime', jobs: ['workers', 'queues', 'ai', 'r2Ops', 'r2Storage'] },
  ].map((g) => ({ ...g, members: g.jobs.map((id) => JOB_BY_ID.get(id)) }));

  /* =========================================================================
   * 6. 采集流程 / Collection
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
    const msg = clip(message || t('err.noData'), 140);
    for (const k of job.keys) result.failed[k] = msg;
    result.diag.push({ job: job.id, message: clip(message, 240) });
  }

  async function runGroup(group, ctx, result) {
    const parts = [];
    const map = [];
    group.members.forEach((job, i) => {
      const vi = variantPick.get(job.id) || 0;
      const variant = job.variants[vi] || job.variants[0];
      parts.push(`a${i}: ${variant.field(ctx)}`);
      map.push({ job, alias: `a${i}`, vi });
    });
    result.requests += 1;
    const { data, errors } = await gql(P(ctx, parts.join(' ')));

    let anyOk = false;
    for (const { job, alias, vi } of map) {
      const variant = job.variants[vi] || job.variants[0];
      const rows = gq(data, `viewer.accounts.0.${alias}`);
      if (rows == null) {
        const err = errors.find((e) => Array.isArray(e.path) && e.path.includes(alias));
        markFailed(result, job, err ? err.message : t('err.combinedNoRows'));
        continue;
      }
      anyOk = true;
      applyValues(result, job, variant.extract(wrapDataset(variant.dataset, rows)), variant.approx);
    }
    return anyOk;
  }

  async function runJob(job, ctx, result) {
    const order = [variantPick.get(job.id) || 0, ...job.variants.keys()].filter((v, i, a) => a.indexOf(v) === i);
    let lastErr = null;
    for (const idx of order) {
      const variant = job.variants[idx];
      if (!variant) continue;
      try {
        result.requests += 1;
        const { data, errors } = await gql(P(ctx, variant.field(ctx)));
        if (errors && errors.length) throw new GQLError(errors[0].message || t('err.noData'));
        rememberVariant(job.id, idx);
        applyValues(result, job, variant.extract(data), variant.approx);
        return 'ok';
      } catch (e) {
        lastErr = e;
        if (e.authError) break;
        if (e.throttled) {
          markFailed(result, job, e.message);
          return 'throttled';
        }
      }
    }
    markFailed(result, job, lastErr ? lastErr.message : t('err.collectFailed'));
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
          throttleErr = blocked;
          markGroupFailed(group, blocked.message);
          continue;
        }
        for (const job of group.members) {
          if (throttleErr) {
            markGroupFailed(group, throttleErr.message);
            break;
          }
          const alreadyDone = job.keys.every((k) => k in result.values || k in result.failed);
          if (alreadyDone) continue;
          const st = await runJob(job, ctx, result);
          if (st === 'throttled') throttleErr = new GQLError(t('err.throttled'), { status: 403 });
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
      result.fatal = String(Object.values(result.failed)[0] || t('err.noData'));
    }
    return result;
  }

  /* =========================================================================
   * 7. UI
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
    .launcher { touch-action: none; }
    .launcher.dragging { cursor: grabbing; transform: none; box-shadow: 0 4px 14px rgba(0,0,0,.4); }
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
      cursor: grab; touch-action: none; user-select: none;
    }
    .panel.dragging { transition: none; }
    .panel.dragging header { cursor: grabbing; }
    .panel.dragging * { user-select: none; }
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
    .banner .acts { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
    .notice { margin: 8px 0 0; padding: 7px 10px; border-radius: 8px; font-size: 11px; line-height: 1.6;
      background: #1e2128; border: 1px solid #2c313b; color: #9aa2b1; }
    .star { margin: 8px 0 0; padding: 10px 11px; border-radius: 10px; font-size: 11.5px; line-height: 1.65;
      background: linear-gradient(135deg, #1f2430, #1a1e27); border: 1px solid #2f3646; color: #b6bdcb; }
    .star b { color: #ffd8a8; display: block; margin-bottom: 3px; font-size: 12px; }
    .star .acts { display: flex; gap: 8px; margin-top: 8px; }
    .star a { color: inherit; text-decoration: none; }
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
    .star-mark { color: #f6821f; font-size: 10px; margin-left: 2px; }
    .row.dead .name { color: #6b7280; }
    .row.dead .bar { background: repeating-linear-gradient(90deg, #23262e, #23262e 4px, #1c1f26 4px, #1c1f26 8px); }
    .row.dead .pct { color: #6b7280; font-weight: 500; font-size: 11px; }
    .row.dead .val { color: #5b6270; }
    .foot { padding: 8px 0 2px; font-size: 10.5px; color: #5f6674; border-top: 1px solid #22252c; margin-top: 10px; line-height: 1.7; }
    .foot a { color: #8b93a3; text-decoration: none; border-bottom: 1px dotted #444b59; }
    .foot a:hover { color: #f6821f; border-color: #f6821f; }
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

  /* ---------- 拖拽定位 / Dragging ---------- */
  const clampNum = (v, min, max) => Math.min(Math.max(v, min), Math.max(min, max));

  function pinToLeftTop(el, x, y) {
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  }

  function keepInView(el) {
    const rect = el.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    const x = clampNum(rect.left, 8, window.innerWidth - rect.width - 8);
    const y = clampNum(rect.top, 8, window.innerHeight - rect.height - 8);
    if (x !== rect.left || y !== rect.top) pinToLeftTop(el, x, y);
  }

  function applyStoredPos(el, key) {
    const pos = store.get(key, null);
    if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') return false;
    pinToLeftTop(el, pos.x, pos.y);
    return true;
  }

  function resetPos(el, key) {
    for (const prop of ['left', 'top', 'right', 'bottom']) el.style.removeProperty(prop);
    store.set(key, null);
  }

  function draggable(el, handle, opts = {}) {
    const api = { suppressClick: false, dragging: false };
    let pid = null;
    let startX = 0;
    let startY = 0;
    let baseX = 0;
    let baseY = 0;
    let moved = false;

    const onDown = (ev) => {
      if (ev.button != null && ev.button !== 0) return;
      if (opts.ignore && ev.target.closest && ev.target.closest(opts.ignore)) return;
      const rect = el.getBoundingClientRect();
      pinToLeftTop(el, rect.left, rect.top);
      startX = ev.clientX;
      startY = ev.clientY;
      baseX = rect.left;
      baseY = rect.top;
      moved = false;
      api.dragging = true;
      pid = ev.pointerId;
      el.classList.add('dragging');
      try { handle.setPointerCapture?.(ev.pointerId); } catch (e) { /* ignore */ }
      ev.preventDefault();
    };

    const onMove = (ev) => {
      if (!api.dragging) return;
      if (pid != null && ev.pointerId != null && ev.pointerId !== pid) return;
      const dx = (ev.clientX || 0) - startX;
      const dy = (ev.clientY || 0) - startY;
      if (!moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      moved = true;
      const rect = el.getBoundingClientRect();
      pinToLeftTop(
        el,
        clampNum(baseX + dx, 8, window.innerWidth - rect.width - 8),
        clampNum(baseY + dy, 8, window.innerHeight - rect.height - 8),
      );
      ev.preventDefault();
    };

    const onUp = () => {
      if (!api.dragging) return;
      api.dragging = false;
      pid = null;
      el.classList.remove('dragging');
      if (!moved) return;
      api.suppressClick = true;
      if (opts.key) {
        const rect = el.getBoundingClientRect();
        store.set(opts.key, { x: Math.round(rect.left), y: Math.round(rect.top) });
      }
      if (opts.onDrop) opts.onDrop();
    };

    handle.addEventListener('pointerdown', onDown);
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
    return api;
  }

  function openRepo() {
    try { window.open(REPO_URL, '_blank', 'noopener,noreferrer'); } catch (e) { /* ignore */ }
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
      row.title = failed ? t('row.failedTip', { msg: failed }) : t('row.noData');
      row.innerHTML = `<div class="l1"><span class="name">${t(spec.labelKey)}</span>
        <span class="val">${t('row.notFetched')}</span><span class="pct">—</span></div>
        <div class="bar"><i style="width:0%"></i></div>`;
      return row;
    }

    const limit = spec.limit;
    const pct = limit > 0 ? (value / limit) * 100 : 0;
    const shown = Math.max(0, Math.min(pct, 100));
    const color = pctColor(pct);
    const approx = snapshot.approx && snapshot.approx[key]
      ? `<span class="star-mark" title="${t('row.approx')}">*</span>`
      : '';

    if (pct >= 100) row.classList.add('over');
    else if (pct >= 70) row.classList.add('warn');

    row.title = t('row.detail', {
      used: fmt(spec.kind, value),
      limit: fmt(spec.kind, limit),
      left: fmt(spec.kind, Math.max(0, limit - value)),
    });
    row.innerHTML = `<div class="l1">
        <span class="name">${t(spec.labelKey)}${approx}</span>
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
    root.appendChild(launcher);

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `
      <header>
        <span class="dot"></span>
        <span class="t" data-el="title"></span>
        <span class="sp"></span>
        <button class="btn" data-act="refresh"></button>
        <button class="btn" data-act="settings"></button>
        <button class="btn" data-act="close">×</button>
      </header>
      <div class="meta" data-el="meta"></div>
      <div class="body" data-el="body"></div>
      <div class="cfg" data-el="cfg" style="display:none"></div>
      <div class="toast" data-el="toast"></div>`;
    root.appendChild(panel);

    const ui = {
      host, root, panel, launcher,
      titleEl: panel.querySelector('[data-el=title]'),
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

    ui.launcherDrag = draggable(launcher, launcher, { key: KEY.launcherPos });
    ui.panelDrag = draggable(panel, panel.querySelector('header'), { ignore: '[data-act]', key: KEY.panelPos });

    applyStoredPos(launcher, KEY.launcherPos);
    applyStoredPos(panel, KEY.panelPos);
    requestAnimationFrame(() => keepInView(launcher));
    return ui;
  }

  /* 与语言相关但位置固定的文案 / static labels bound to language */
  function applyStaticText() {
    if (!ui) return;
    ui.titleEl.textContent = t('app.title');
    ui.launcher.title = t('app.launcher');
    const btnRefresh = ui.panel.querySelector('[data-act=refresh]');
    const btnSettings = ui.panel.querySelector('[data-act=settings]');
    if (btnRefresh) btnRefresh.textContent = state.loading ? t('btn.refreshing') : t('btn.refresh');
    if (btnSettings) btnSettings.textContent = ui.settingsOpen ? t('btn.back') : t('btn.settings');
  }

  /* =========================================================================
   * 8. 控制器 / Controller
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
      btn.textContent = busy ? t('btn.refreshing') : t('btn.refresh');
      btn.disabled = busy;
    }
  }

  function renderMeta() {
    if (!ui) return;
    const acc = state.accounts.find((a) => a.id === state.accountId);
    const snap = state.snapshot;
    const when = snap && snap.ts ? hhmmss(new Date(snap.ts)) : '—';
    const mins = store.get(KEY.interval, 5);
    const mode = isTokenMode() ? t('mode.token') : t('mode.session');
    const stale = state.staleNotice
      ? ` · <span class="stale">${t('meta.stale', { time: state.staleNotice })}</span>`
      : '';
    ui.meta.innerHTML = `${t('meta.account')} <b>${(acc && acc.name) || '—'}</b> · <b>${mode}</b> · `
      + `${t('meta.updated')} <b>${when}</b> · ${t('meta.every', { n: mins })}${stale}`;
  }

  function renderBody() {
    if (!ui) return;
    const body = ui.body;
    body.innerHTML = '';

    if (!state.snapshot) {
      body.innerHTML = `<div class="empty">${t('empty.noData')}</div>`;
      return;
    }

    const snap = state.snapshot;
    if (snap.fatal) {
      const isToken = isTokenMode();
      const msg = isToken && snap.authError
        ? t('status.tokenAuth')
        : t('status.allFailed', { msg: clip(snap.fatal, 120) });
      body.insertAdjacentHTML('beforeend', `<div class="banner"><b>${t('status.fail')}</b><br>${msg}
        <div class="acts"><button class="btn primary" data-act="settings">${isToken ? t('status.checkSettings') : t('status.switchToken')}</button>
        <button class="btn" data-act="diag">${t('status.diag')}</button></div></div>`);
    } else if (Object.keys(snap.failed || {}).length) {
      body.insertAdjacentHTML('beforeend', `<div class="notice">${t('notice.partial', { n: Object.keys(snap.failed).length })}</div>`);
    }

    // 一次性 star 引导（方案 A：不拦人，只提示）
    if (!snap.fatal && !store.get(KEY.starPrompt, false)) {
      body.insertAdjacentHTML('beforeend', `<div class="star">
        <b>${t('star.title')}</b>${t('star.body')}
        <div class="acts">
          <button class="btn primary" data-act="star">${t('star.cta')}</button>
          <button class="btn" data-act="star-later">${t('star.later')}</button>
        </div></div>`);
    }

    for (const sec of SECTIONS) {
      const wrap = document.createElement('div');
      wrap.className = 'sec';
      const h = document.createElement('div');
      h.className = 'sec-h';
      h.innerHTML = `<span>${t(sec.titleKey)}</span><span class="n">${t(sec.noteKey)}</span>`;
      wrap.appendChild(h);
      for (const key of sec.keys) wrap.appendChild(buildRow(key, snap));
      body.appendChild(wrap);
    }

    const foot = document.createElement('div');
    foot.className = 'foot';
    foot.innerHTML = `${t('foot.source')}<br>${t('foot.meta', { ver: VERSION, n: snap.requests || 0 })}
      · <a href="${REPO_URL}" target="_blank" rel="noopener noreferrer">${t('foot.star')}</a>`;
    body.appendChild(foot);
  }

  function diagText() {
    const snap = state.snapshot;
    const lines = [
      `${t('diag.version')}: v${VERSION}`,
      `${t('diag.mode')}: ${isTokenMode() ? 'token' : 'session'}`,
      `${t('diag.time')}: ${snap && snap.ts ? new Date(snap.ts).toISOString() : '-'}`,
      `${t('diag.account')}: ${(snap && snap.accountId) || '-'}`,
      `${t('diag.requests')}: ${(snap && snap.requests) || 0}`,
      `${t('diag.success')}: ${snap ? Object.keys(snap.values || {}).join(',') || '-' : '-'}`,
      snap && snap.fatal ? `${t('diag.fatal')}: ${snap.fatal}` : null,
      '',
    ].filter((x) => x !== null);
    if (!snap || !snap.diag || !snap.diag.length) return lines.concat(t('settings.diagNone')).join('\n');
    return lines.concat(snap.diag.map((d) => `[${d.job}] ${d.message}`)).join('\n');
  }

  function renderSettings() {
    if (!ui) return;
    const cfg = ui.cfg;
    const mode = isTokenMode() ? 'token' : 'session';
    const token = getToken();
    const interval = store.get(KEY.interval, 5);
    const lang = store.get(KEY.lang, 'auto');
    const langOpt = (val, label) => `<option value="${val}"${lang === val ? ' selected' : ''}>${label}</option>`;

    cfg.innerHTML = `
      <h4>${t('settings.language')}</h4>
      <select data-f="lang">
        ${langOpt('auto', t('settings.langAuto'))}
        ${langOpt('zh', t('settings.langZh'))}
        ${langOpt('en', t('settings.langEn'))}
      </select>

      <h4>${t('settings.source')}</h4>
      <select data-f="mode">
        <option value="session"${mode === 'session' ? ' selected' : ''}>${t('settings.modeSession')}</option>
        <option value="token"${mode === 'token' ? ' selected' : ''}>${t('settings.modeToken')}</option>
      </select>
      <div class="hint" data-el="modeHint"></div>

      <div data-el="tokenBox">
        <h4>${t('settings.token')}</h4>
        <input type="password" data-f="token" placeholder="${t('settings.tokenPlaceholder')}" value="${token.replace(/"/g, '&quot;')}">
        <div class="hint">${t('settings.tokenHint')}</div>
      </div>

      <h4>${t('settings.interval')}</h4>
      <select data-f="interval">
        ${[1, 2, 5, 10, 15, 30].map((m) => `<option value="${m}"${Number(interval) === m ? ' selected' : ''}>${t('settings.minutes', { n: m })}</option>`).join('')}
      </select>

      <div class="ops">
        <button class="btn primary" data-act="save">${t('settings.save')}</button>
        <button class="btn" data-act="test">${t('settings.test')}</button>
        <button class="btn" data-act="clearcache">${t('settings.clearcache')}</button>
        <button class="btn" data-act="resetpos">${t('settings.resetpos')}</button>
        <button class="btn" data-act="repo">${t('settings.repo')}</button>
      </div>

      <h4>${t('settings.diag')}</h4>
      <div class="diag" data-el="diag"></div>
      <div class="ops"><button class="btn" data-act="copy">${t('settings.copy')}</button></div>`;

    const tokenBox = cfg.querySelector('[data-el=tokenBox]');
    const modeHint = cfg.querySelector('[data-el=modeHint]');
    const diagEl = cfg.querySelector('[data-el=diag]');

    const syncMode = () => {
      const m = cfg.querySelector('[data-f=mode]').value;
      tokenBox.style.display = m === 'token' ? 'block' : 'none';
      modeHint.innerHTML = m === 'token' ? t('settings.modeHintToken') : t('settings.modeHintSession');
    };
    syncMode();
    cfg.querySelector('[data-f=mode]').addEventListener('change', syncMode);

    // 语言切换即时生效
    cfg.querySelector('[data-f=lang]').addEventListener('change', (ev) => {
      store.set(KEY.lang, ev.target.value);
      LANG = resolveLang();
      applyStaticText();
      renderMeta();
      renderBody();
      renderSettings();
      ui.toast(ev.target.value === 'zh' ? '界面语言：简体中文' : ev.target.value === 'en' ? 'UI language: English' : 'Auto');
    });

    diagEl.textContent = diagText();

    cfg.querySelector('[data-act=save]').addEventListener('click', async () => {
      const nextMode = cfg.querySelector('[data-f=mode]').value;
      const nextToken = cfg.querySelector('[data-f=token]').value.trim();
      const nextInterval = Number(cfg.querySelector('[data-f=interval]').value) || 5;
      if (nextMode === 'token' && !nextToken) {
        ui.toast(t('toast.needToken'));
        return;
      }
      store.set(KEY.mode, nextMode);
      store.set(KEY.token, nextToken);
      store.set(KEY.interval, nextInterval);
      store.set(KEY.accounts, []);
      state.accounts = [];
      state.staleNotice = '';
      ui.toast(t('toast.saved'));
      showSettings(false);
      scheduleAutoRefresh();
      await refresh(true);
    });

    cfg.querySelector('[data-act=test]').addEventListener('click', async () => {
      const m = cfg.querySelector('[data-f=mode]').value;
      const tk = cfg.querySelector('[data-f=token]').value.trim();
      store.set(KEY.mode, m);
      store.set(KEY.token, tk);
      if (m === 'token' && !tk) { ui.toast(t('toast.needTokenFirst')); return; }
      diagEl.textContent = t('settings.testing');
      try {
        const acc = await resolveAccount();
        const ctx = buildCtx(acc);
        const { data } = await gql(P(ctx, currentVariant(JOB_BY_ID.get('workers')).field(ctx)));
        const n = num(gq(account0(data), 'workersInvocationsAdaptive.0.sum.requests'));
        diagEl.textContent = t('settings.testOk', { mode: m, acc, n: fmtCount(n) });
        ui.toast(t('toast.connOk'));
      } catch (e) {
        diagEl.textContent = t('settings.testFail', { mode: m, status: e.status || '-', msg: e.message || e })
          + (e.body ? `\nbody: ${clip(e.body, 300)}` : '');
        ui.toast(t('toast.connFail', { msg: clip(e.message || e, 80) }));
      }
    });

    cfg.querySelector('[data-act=clearcache]').addEventListener('click', () => {
      store.set(KEY.snapshot, null);
      state.snapshot = null;
      state.staleNotice = '';
      renderBody();
      renderMeta();
      diagEl.textContent = t('settings.diagNone');
      ui.toast(t('toast.cacheCleared'));
    });

    cfg.querySelector('[data-act=resetpos]').addEventListener('click', () => {
      resetPos(ui.panel, KEY.panelPos);
      resetPos(ui.launcher, KEY.launcherPos);
      ui.toast(t('toast.posReset'));
    });

    cfg.querySelector('[data-act=repo]').addEventListener('click', openRepo);

    cfg.querySelector('[data-act=copy]').addEventListener('click', async () => {
      const text = diagText();
      try {
        if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('clipboard unavailable');
        await navigator.clipboard.writeText(text);
        ui.toast(t('toast.copied'));
      } catch (e) {
        ui.toast(t('toast.copyFail'));
      }
    });
  }

  function showSettings(open) {
    if (!ui) return;
    ui.settingsOpen = open;
    ui.cfg.style.display = open ? 'block' : 'none';
    ui.body.style.display = open ? 'none' : 'block';
    const btn = ui.panel.querySelector('[data-act=settings]');
    if (btn) btn.textContent = open ? t('btn.back') : t('btn.settings');
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
      keepInView(ui.panel);
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
    throw new Error(t('err.noAccount'));
  }

  async function refresh(force) {
    if (!ui) return;
    if (state.loading && !force) return;
    if (!force && Date.now() - state.lastRefreshAt < 2000) return; // debounce
    state.lastRefreshAt = Date.now();
    setBusy(true);
    try {
      const acc = await resolveAccount();
      const snapshot = await collect(acc);
      snapshot.accountId = acc;

      const gotAny = Object.keys(snapshot.values).length > 0;
      const hadGood = state.snapshot && Object.keys(state.snapshot.values || {}).length > 0;

      if (!gotAny && hadGood) {
        state.staleNotice = hhmmss(new Date());
        if (snapshot.fatal && isTokenMode()) {
          state.snapshot.fatal = snapshot.fatal;
          state.snapshot.authError = snapshot.authError;
        }
        ui.toast(t('toast.staleKept', { msg: clip(snapshot.fatal || t('err.noData'), 60) }));
      } else {
        state.staleNotice = '';
        state.snapshot = snapshot;
        store.set(KEY.snapshot, snapshot);
        if (snapshot.fatal) {
          ui.toast(t('toast.collectFail', { msg: clip(snapshot.fatal, 70) }));
        } else {
          const dead = Object.keys(snapshot.failed || {}).length;
          if (dead) ui.toast(t('toast.partialDead', { n: dead }));
        }
      }

      renderMeta();
      renderBody();
      if (ui.settingsOpen) renderSettings();
    } catch (e) {
      const msg = clip(e && e.message ? e.message : e, 160);
      ui.toast(t('toast.readFail', { msg }));
      if (!state.snapshot) {
        ui.body.innerHTML = `<div class="empty">${t('empty.fail', { msg })}<br><br>${t('empty.hint')}</div>`;
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
    ui.launcher.addEventListener('click', () => {
      if (ui.launcherDrag && ui.launcherDrag.suppressClick) {
        ui.launcherDrag.suppressClick = false;
        return;
      }
      togglePanel(true);
    });

    window.addEventListener('resize', () => {
      keepInView(ui.launcher);
      keepInView(ui.panel);
    });

    ui.panel.addEventListener('click', (ev) => {
      const t0 = ev.target.closest('[data-act]');
      if (!t0) {
        const row = ev.target.closest('.row');
        if (row && row.title) ui.toast(row.title);
        return;
      }
      const act = t0.dataset.act;
      if (act === 'close') togglePanel(false);
      if (act === 'refresh') refresh(true);
      if (act === 'settings') showSettings(!ui.settingsOpen);
      if (act === 'repo') openRepo();
      if (act === 'star') {
        store.set(KEY.starPrompt, true);
        openRepo();
        renderBody();
        ui.toast(t('star.thanks'));
      }
      if (act === 'star-later') {
        store.set(KEY.starPrompt, true);
        renderBody();
      }
      if (act === 'diag') {
        showSettings(true);
        const el = ui.cfg.querySelector('[data-el=diag]');
        try { if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ }
      }
    });

    // 页脚 <a> 用 window.open，避免 dash 的 SPA 路由接管
    ui.panel.addEventListener('click', (ev) => {
      const a = ev.target.closest('a[data-act=repo], a[href]');
      if (!a) return;
      ev.preventDefault();
      openRepo();
    });

    document.addEventListener('keydown', (e) => {
      if (e.altKey && (e.key === 'u' || e.key === 'U')) {
        e.preventDefault();
        togglePanel();
      }
    }, true);
  }

  function init() {
    LANG = resolveLang();
    ui = mount();
    if (!ui) return;
    bind();
    applyStaticText();
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

  // 调试/测试接口（控制台输入 __CFU__）/ debug & test hooks
  try {
    globalThis.__CFU__ = {
      VERSION, REPO_URL, JOBS, GROUPS, LIMITS, SPECS, SECTIONS, buildCtx, collect, runJob, runGroup,
      gql, fmt, fmtCount, fmtBytes, r2Class, store, variantPick, I18N,
      setLang: (l) => { LANG = l; },
      getLang: () => LANG,
      t,
    };
  } catch (e) { /* ignore */ }

  if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;

  try {
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('打开免费额度面板 / Open panel', () => togglePanel(true));
      GM_registerMenuCommand('立即刷新用量 / Refresh now', () => refresh(true));
    }
  } catch (e) { /* ignore */ }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
