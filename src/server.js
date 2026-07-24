import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, 'data');
const reportsDir = path.join(root, 'reports');
const publicDir = path.join(root, 'public');
const configPath = path.join(dataDir, 'config.json');
const messagesPath = path.join(dataDir, 'messages.json');
const runsPath = path.join(dataDir, 'runs.json');
const lastScanPath = path.join(dataDir, 'last-scan.json');
const guildMapPath = path.join(dataDir, 'guild-map.json');
const port = Number(process.env.PORT || 8787);
const chromeUserData = path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
const pdGuildFeedUrl = 'https://pd.qq.com/qunng/guild/gotrpc/auth/trpc.qchannel.commreader.ComReader/GetGuildFeeds?bkn={bkn}';
const pdInGuildSearchUrl = 'https://pd.qq.com/qunng/guild/gotrpc/auth/trpc.group_pro.in_guild_search_svr.InGuildSearch/NewSearch?bkn={bkn}';
const execFileAsync = promisify(execFile);

let state = {
  lastSchedulerKey: '',
  running: false,
  lastRun: null
};

const mime = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8']
]);

async function ensureFiles() {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(reportsDir, { recursive: true });
  try { await fs.access(configPath); } catch { await fs.writeFile(configPath, JSON.stringify(defaultConfig(), null, 2), 'utf8'); }
  try { await fs.access(messagesPath); } catch { await fs.writeFile(messagesPath, '[]', 'utf8'); }
  try { await fs.access(runsPath); } catch { await fs.writeFile(runsPath, '[]', 'utf8'); }
  const existingGuildMap = await readJson(guildMapPath, null);
  if (!existingGuildMap) {
    await writeJson(guildMapPath, defaultGuildMap());
  } else {
    await writeJson(guildMapPath, { ...defaultGuildMap(), ...existingGuildMap });
  }
}

function defaultConfig() {
  return {
    channel: '今日青理（临沂）',
    keywords: ['代做'],
    scheduleTime: '08:30',
    timezone: 'Asia/Shanghai',
    dateRange: { startDate: '', endDate: '' },
    search: { enabled: true, maxPagesPerKeyword: 20 },
    report: { enabled: false, outputDir: 'reports' },
    notify: {
      enabled: false,
      platform: 'wecom',
      webhookUrl: '',
      feishuSecret: '',
      onlyOnHit: true,
      includeReport: true,
      maxPreview: 3
    },
    request: {
      curl: '',
      url: '',
      method: 'GET',
      headers: {
        accept: 'application/json, text/plain, */*',
        origin: 'https://pd.qq.com',
        referer: 'https://pd.qq.com/',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
      },
      body: '',
      itemPath: '',
      timeField: '',
      idField: '',
      textFields: []
    },
    limits: { maxItemsPerRun: 200, maxPagesPerRun: 20 }
  };
}

function tencentGuildPreset(guildId = '51420691637566494') {
  return {
    url: pdGuildFeedUrl,
    method: 'POST',
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      origin: 'https://pd.qq.com',
      referer: 'https://pd.qq.com/',
      'x-oidb': JSON.stringify({ uint32_service_type: 13 }),
      'X-QQ-Client-AppId': '537246381',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
    },
    body: JSON.stringify({
      count: 50,
      from: 7,
      guild_id: String(guildId),
      get_type: 1,
      feedAttchInfo: '',
      sortOption: 0,
      need_channel_list: false,
      need_top_info: false
    }, null, 2),
    itemPath: 'data.vecFeed',
    timeField: '',
    idField: '',
    textFields: []
  };
}

function defaultGuildMap() {
  return {
    '51420691637566494': { name: '今日青理（临沂）', guildNum: '5ky797nb16', source: 'builtin' },
    '52389591637934243': { name: '山东第二医科大学频道', guildNum: 'sddeykdx321', source: 'builtin' },
    '673185703982272109': { name: '青岛理工大学临沂校区', guildNum: 'z841e15chf', source: 'builtin' }
  };
}

async function readGuildMap() {
  return { ...defaultGuildMap(), ...(await readJson(guildMapPath, {})) };
}

async function writeGuildMap(map) {
  await writeJson(guildMapPath, map);
}

function requestGuildId(cfg) {
  const body = String(cfg.request?.body || '');
  try {
    const parsed = JSON.parse(body || '{}');
    if (parsed.guild_id) return String(parsed.guild_id);
  } catch {}
  const match = body.match(/"guild_id"\s*:\s*"?(\d+)"?/);
  return match ? match[1] : '';
}

async function rememberGuild(guildId, name, extra = {}) {
  const id = String(guildId || '').trim();
  const cleanName = String(name || '').trim();
  if (!id || !cleanName || /^未知频道/.test(cleanName)) return;
  const map = await readGuildMap();
  map[id] = { ...(map[id] || {}), ...extra, name: cleanName, updatedAt: new Date().toISOString() };
  await writeGuildMap(map);
}

function postUrlForMessage(item, guildMap = {}) {
  const feedId = String(item?.id || '').trim();
  const guildId = String(item?.guildId || '').trim();
  if (!feedId) return '';
  const guildKey = String(guildMap[guildId]?.guildNum || guildId || '').trim();
  if (!guildKey) return '';
  return `https://pd.qq.com/g/${encodeURIComponent(guildKey)}/post/${encodeURIComponent(feedId)}`;
}

function decodeHtmlAttr(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function channelNameFromPostHtml(html) {
  const metaTags = String(html || '').match(/<meta\b[^>]*>/gi) || [];
  const titleTag = metaTags.find(tag => /\bproperty=["']og:title["']/i.test(tag));
  if (!titleTag) return '';
  const title = titleTag.match(/\bcontent=["']([^"']+)["']/i);
  if (!title) return '';
  const parts = decodeHtmlAttr(title[1]).split('｜').map(s => s.trim()).filter(Boolean);
  const idx = parts.lastIndexOf('腾讯频道');
  return idx > 0 ? parts[idx - 1] : '';
}

async function resolveGuildNameFromFeed(guildId, feedId) {
  if (!guildId || !feedId) return '';
  const url = `https://pd.qq.com/g/${encodeURIComponent(guildId)}/post/${encodeURIComponent(feedId)}`;
  const res = await fetch(url, {
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
    }
  });
  if (!res.ok) return '';
  return channelNameFromPostHtml(await res.text());
}

async function readJson(file, fallback) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const clean = raw.replace(/^\uFEFF/, '');
    return clean.trim() ? JSON.parse(clean) : fallback;
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
}

function json(res, status, value) {
  const payload = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': 'https://pd.qq.com',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type'
  });
  res.end(payload);
}

async function bodyJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function normalizeConfig(input) {
  const base = defaultConfig();
  const cfg = { ...base, ...(input || {}) };
  cfg.keywords = Array.isArray(cfg.keywords)
    ? cfg.keywords.map(String).map(s => s.trim()).filter(Boolean)
    : String(cfg.keywords || '').split(/[,，\n]/).map(s => s.trim()).filter(Boolean);
  cfg.request = { ...base.request, ...(cfg.request || {}) };
  cfg.request.headers = { ...base.request.headers, ...(cfg.request.headers || {}) };
  cfg.request.textFields = Array.isArray(cfg.request.textFields)
    ? cfg.request.textFields.map(String).map(s => s.trim()).filter(Boolean)
    : String(cfg.request.textFields || '').split(/[,，\n]/).map(s => s.trim()).filter(Boolean);
  cfg.dateRange = {
    startDate: String(cfg.dateRange?.startDate || '').trim(),
    endDate: String(cfg.dateRange?.endDate || '').trim()
  };
  cfg.search = {
    ...base.search,
    ...(cfg.search || {}),
    enabled: cfg.search?.enabled !== false,
    maxPagesPerKeyword: Math.max(1, Number(cfg.search?.maxPagesPerKeyword || base.search.maxPagesPerKeyword || 20))
  };
  cfg.report = {
    ...base.report,
    ...(cfg.report || {}),
    enabled: cfg.report?.enabled === true,
    outputDir: String(cfg.report?.outputDir || base.report.outputDir).trim() || base.report.outputDir
  };
  cfg.notify = {
    ...base.notify,
    ...(cfg.notify || {}),
    enabled: cfg.notify?.enabled === true,
    platform: ['wecom', 'feishu'].includes(String(cfg.notify?.platform || '').trim()) ? String(cfg.notify.platform).trim() : base.notify.platform,
    webhookUrl: String(cfg.notify?.webhookUrl || '').trim(),
    feishuSecret: String(cfg.notify?.feishuSecret || '').trim(),
    onlyOnHit: cfg.notify?.onlyOnHit !== false,
    includeReport: cfg.notify?.includeReport !== false,
    maxPreview: Math.max(0, Math.min(10, Number(cfg.notify?.maxPreview ?? base.notify.maxPreview)))
  };
  cfg.limits = { ...base.limits, ...(cfg.limits || {}) };
  return cfg;
}

function shellTokens(command) {
  const tokens = [];
  let current = '';
  let quote = '';
  let escaping = false;
  for (const ch of command) {
    if (escaping) { current += ch; escaping = false; continue; }
    if (ch === '\\') { escaping = true; continue; }
    if (quote) {
      if (ch === quote) quote = '';
      else current += ch;
      continue;
    }
    if (ch === '\'' || ch === '"') { quote = ch; continue; }
    if (/\s/.test(ch)) {
      if (current) { tokens.push(current); current = ''; }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function parseCurl(curl) {
  const result = { url: '', method: '', headers: {}, body: '' };
  if (!curl || !curl.trim()) return result;
  const tokens = shellTokens(curl.replace(/\^\r?\n/g, ' ').replace(/\\\r?\n/g, ' '));
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === 'curl') continue;
    if (!result.url && /^https?:\/\//i.test(token)) { result.url = token; continue; }
    if (token === '-X' || token === '--request') { result.method = tokens[++i] || ''; continue; }
    if (token === '-H' || token === '--header') {
      const header = tokens[++i] || '';
      const idx = header.indexOf(':');
      if (idx > 0) result.headers[header.slice(0, idx).trim().toLowerCase()] = header.slice(idx + 1).trim();
      continue;
    }
    if (token === '-b' || token === '--cookie') {
      result.headers.cookie = tokens[++i] || '';
      continue;
    }
    if (['--data', '--data-raw', '--data-binary', '--data-urlencode', '-d'].includes(token)) {
      result.body = tokens[++i] || '';
      if (!result.method) result.method = 'POST';
    }
  }
  return result;
}

function parseCookie(cookie) {
  return String(cookie || '').split(';').reduce((acc, part) => {
    const idx = part.indexOf('=');
    if (idx > 0) acc[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    return acc;
  }, {});
}

function normalizeCookieHeader(cookie) {
  return String(cookie || '')
    .trim()
    .replace(/^cookie\s*:\s*/i, '')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

function cookieState(cookie) {
  const parsed = parseCookie(cookie);
  return {
    hasCookie: Boolean(String(cookie || '').trim()),
    hasPSkey: Boolean(parsed.p_skey),
    hasSkey: Boolean(parsed.skey),
    hasUin: Boolean(parsed.uin || parsed.luin),
    usable: Boolean((parsed.p_skey || parsed.skey) && (parsed.uin || parsed.luin))
  };
}

async function importCookie(cookie) {
  const clean = normalizeCookieHeader(cookie);
  if (!clean) throw new Error('缺少 Cookie');
  const cfg = normalizeConfig(await readJson(configPath, defaultConfig()));
  cfg.request = { ...cfg.request, ...(cfg.request || {}) };
  cfg.request.headers = { ...(cfg.request.headers || {}), cookie: clean };
  if (!cfg.request.url) Object.assign(cfg.request, tencentGuildPreset());
  await writeJson(configPath, cfg);
  const state = cookieState(clean);
  return {
    ok: state.usable,
    warning: state.usable ? '' : 'Cookie 缺少 p_skey/skey 或 uin/luin，请确认在 pd.qq.com 已登录后重新导入。',
    hasPSkey: state.hasPSkey,
    hasSkey: state.hasSkey,
    hasUin: state.hasUin
  };
}

async function saveConfig(input) {
  const cfg = normalizeConfig(input);
  const existing = normalizeConfig(await readJson(configPath, defaultConfig()));
  const incomingHeaders = cfg.request?.headers || {};
  const incomingCookie = incomingHeaders.cookie || incomingHeaders.Cookie || '';
  const existingCookie = existing.request?.headers?.cookie || existing.request?.headers?.Cookie || '';
  const incomingState = cookieState(incomingCookie);
  const existingState = cookieState(existingCookie);
  if ((!incomingCookie && existingCookie) || (existingState.usable && !incomingState.usable)) {
    cfg.request.headers.cookie = existingCookie;
    delete cfg.request.headers.Cookie;
  }
  const guildId = requestGuildId(cfg);
  const guildMap = await readGuildMap();
  if (!cfg.channel && guildMap[guildId]?.name) cfg.channel = guildMap[guildId].name;
  await rememberGuild(guildId, cfg.channel, { source: 'config' });
  await writeJson(configPath, cfg);
  return cfg;
}

async function switchGuild(input) {
  const guildId = String(input?.guildId || '').trim();
  if (!/^\d+$/.test(guildId)) throw new Error('缺少有效 guildId');
  const guildMap = await readGuildMap();
  const name = String(input?.guildName || guildMap[guildId]?.name || '').trim();
  const existing = normalizeConfig(await readJson(configPath, defaultConfig()));
  const cookie = existing.request?.headers?.cookie;
  const preset = tencentGuildPreset(guildId);
  const cfg = {
    ...existing,
    channel: name || `未知频道 ${guildId}`,
    request: {
      ...existing.request,
      ...preset,
      headers: {
        ...(preset.headers || {}),
        ...(cookie ? { cookie } : {})
      }
    }
  };
  await rememberGuild(guildId, cfg.channel, { guildNum: guildMap[guildId]?.guildNum || '', source: 'manual-switch' });
  await writeJson(configPath, cfg);
  return { ...cfg, guildMap: await readGuildMap() };
}

function qqBkn(skey) {
  let hash = 5381;
  for (const ch of String(skey || '')) hash += (hash << 5) + ch.charCodeAt(0);
  return String(hash & 0x7fffffff);
}

function requestVars(headers) {
  const cookies = parseCookie(headers.cookie || headers.Cookie || '');
  return {
    bkn: qqBkn(cookies.p_skey || cookies.skey || cookies.access_token || ''),
    p_skey: cookies.p_skey || '',
    skey: cookies.skey || ''
  };
}

function applyVars(value, vars) {
  return String(value || '').replace(/\{(bkn|p_skey|skey)\}/g, (_, key) => vars[key] || '');
}

function requestFromConfig(cfg) {
  const fromCurl = parseCurl(cfg.request.curl || '');
  const headers = { ...(cfg.request.headers || {}), ...(fromCurl.headers || {}) };
  const vars = requestVars(headers);
  const url = applyVars(fromCurl.url || cfg.request.url, vars);
  const method = (fromCurl.method || cfg.request.method || (fromCurl.body || cfg.request.body ? 'POST' : 'GET')).toUpperCase();
  const body = applyVars(fromCurl.body || cfg.request.body || '', vars);
  const renderedHeaders = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, applyVars(value, vars)]));
  return { url, method, headers: renderedHeaders, body };
}

function getPath(obj, dotted) {
  if (!dotted) return undefined;
  return dotted.split('.').filter(Boolean).reduce((acc, key) => {
    if (acc == null) return undefined;
    if (/^\d+$/.test(key)) return acc[Number(key)];
    return acc[key];
  }, obj);
}

function findArrays(value, arrays = []) {
  if (Array.isArray(value)) {
    arrays.push(value);
    for (const item of value.slice(0, 20)) findArrays(item, arrays);
  } else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) findArrays(child, arrays);
  }
  return arrays;
}

function scoreArray(arr) {
  if (!Array.isArray(arr) || !arr.length) return 0;
  const sample = arr.slice(0, 10);
  let score = arr.length;
  for (const item of sample) {
    if (item && typeof item === 'object' && !Array.isArray(item)) score += 5;
    const text = collectText(item).join(' ');
    if (/代做|今日青理|甲醛|报名|通知|\p{Script=Han}/u.test(text)) score += 3;
  }
  return score;
}

function autoItems(payload) {
  if (Array.isArray(payload)) return payload;
  const arrays = findArrays(payload).sort((a, b) => scoreArray(b) - scoreArray(a));
  return arrays[0] || [];
}

function collectText(value, out = []) {
  if (value == null) return out;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const text = String(value).trim();
    if (text) out.push(text);
  } else if (Array.isArray(value)) {
    for (const item of value) collectText(item, out);
  } else if (typeof value === 'object') {
    for (const child of Object.values(value)) collectText(child, out);
  }
  return out;
}

function itemText(item, textFields) {
  const decoded = decodedSearchFeed(item);
  if (textFields && textFields.length) {
    return mergeTextParts(textFields.flatMap(field => [getPath(item, field), getPath(decoded, field)]).flatMap(value => collectText(value))).join('\n').trim();
  }
  const primary = primaryFeedText(item).concat(primaryFeedText(decoded));
  return (primary.length ? primary : collectText(item)).join('\n').trim();
}

function compactTextForCompare(value) {
  return String(value || '').replace(/\s+/g, '').trim();
}

function mergeTextParts(parts) {
  const merged = [];
  for (const raw of parts) {
    const text = String(raw || '').trim();
    const compact = compactTextForCompare(text);
    if (!compact) continue;
    const sameIndex = merged.findIndex(item => compactTextForCompare(item) === compact);
    if (sameIndex >= 0) continue;
    const prefixIndex = merged.findIndex(item => compactTextForCompare(text).startsWith(compactTextForCompare(item)));
    if (prefixIndex >= 0) {
      merged[prefixIndex] = text;
      continue;
    }
    const covered = merged.some(item => compactTextForCompare(item).startsWith(compact));
    if (!covered) merged.push(text);
  }
  return merged;
}

function primaryFeedText(item) {
  const out = [];
  if (!item) return out;
  collectTextContents(getPath(item, 'title.contents'), out);
  collectTextContents(getPath(item, 'contents.contents'), out);
  collectStyleText(getPath(item, 'content_with_style.paragraphs'), out);
  const card = getPath(item, 'share.shareCardInfo');
  if (card) {
    try {
      const parsed = JSON.parse(card);
      collectTextContents(getPath(parsed, 'meta.detail.feed.title.contents'), out);
      collectTextContents(getPath(parsed, 'meta.detail.feed.contents.contents'), out);
      const prompt = getPath(parsed, 'prompt');
      if (prompt) out.push(String(prompt).replace(/^\[频道帖子\]/, ''));
    } catch {}
  }
  return mergeTextParts(out);
}

function decodedSearchFeed(item) {
  if (!item || typeof item !== 'object' || !item.st_feed_json) return null;
  if (item.__decodedSearchFeed !== undefined) return item.__decodedSearchFeed;
  let decoded = null;
  try {
    decoded = JSON.parse(Buffer.from(String(item.st_feed_json), 'base64').toString('utf8'));
  } catch {}
  Object.defineProperty(item, '__decodedSearchFeed', { value: decoded, enumerable: false, configurable: true });
  return decoded;
}

function collectTextContents(contents, out) {
  if (!Array.isArray(contents)) return;
  for (const item of contents) {
    const text = getPath(item, 'text_content.text') ?? getPath(item, 'text');
    if (text) out.push(String(text));
  }
}

function collectStyleText(paragraphs, out) {
  if (!Array.isArray(paragraphs)) return;
  for (const paragraph of paragraphs) {
    const elems = paragraph?.elems || [];
    for (const elem of elems) {
      const text = getPath(elem, 'text.text_content.text');
      if (text) out.push(String(text));
    }
  }
}

function pickTime(item, timeField) {
  const configured = getPath(item, timeField);
  if (hasRealValue(configured)) return String(configured);
  const decoded = decodedSearchFeed(item);
  const decodedConfigured = getPath(decoded, timeField);
  if (hasRealValue(decodedConfigured)) return String(decodedConfigured);
  const candidates = ['created_at', 'create_time', 'createTime', 'publish_time', 'time', 'timestamp', 'post_time', 'date'];
  for (const key of candidates) {
    const value = getPath(item, key);
    if (hasRealValue(value)) return String(value);
    const decodedValue = getPath(decoded, key);
    if (hasRealValue(decodedValue)) return String(decodedValue);
  }
  return new Date().toISOString();
}

function hasRealValue(value) {
  if (value === undefined || value === null || value === '') return false;
  if (value === 0 || value === '0') return false;
  return true;
}

function formatMessageTime(value, timezone = 'Asia/Shanghai') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const date = parseMessageDate(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date);
}

function parseMessageDate(value) {
  const raw = String(value || '').trim();
  if (/^\d{10}$/.test(raw)) return new Date(Number(raw) * 1000);
  if (/^\d{13}$/.test(raw)) return new Date(Number(raw));
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return new Date(n > 10_000_000_000 ? n : n * 1000);
  }
  return new Date(raw);
}

function dateRangeBounds(range = {}) {
  const start = String(range.startDate || '').trim();
  const end = String(range.endDate || '').trim();
  if (!start && !end) return null;
  const startMs = start ? Date.parse(`${start}T00:00:00+08:00`) : -Infinity;
  const endMs = end ? Date.parse(`${end}T23:59:59.999+08:00`) : Infinity;
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) throw new Error('日期范围格式不正确');
  if (startMs > endMs) throw new Error('开始日期不能晚于结束日期');
  return { start, end, startMs, endMs };
}

function inDateRange(value, bounds) {
  if (!bounds) return true;
  const date = parseMessageDate(value);
  const ms = date.getTime();
  if (Number.isNaN(ms)) return false;
  return ms >= bounds.startMs && ms <= bounds.endMs;
}

function pickId(item, idField, channel, text, time) {
  const configured = getPath(item, idField);
  if (configured) return String(configured);
  const candidates = ['id', 'msg_id', 'message_id', 'post_id', 'feed_id', 'article_id', 'tid'];
  for (const key of candidates) {
    const value = getPath(item, key);
    if (value) return String(value);
  }
  return crypto.createHash('sha1').update(`${channel}\n${time}\n${text}`).digest('hex');
}

function keywordMatches(text, keywords) {
  const lower = text.toLowerCase();
  const compact = lower.replace(/\s+/g, '');
  return keywords.filter(keyword => {
    const needle = keyword.toLowerCase().replace(/\s+/g, '');
    if (!needle) return false;
    if (compact.includes(needle)) return true;
    return looseChineseMatch(compact, needle);
  });
}

function looseChineseMatch(text, keyword) {
  if (!/^[\p{Script=Han}]{2,6}$/u.test(keyword)) return false;
  const pattern = [...keyword].map(ch => escapeRegExp(ch)).join('[\\p{Script=Han}\\w]{0,2}');
  return new RegExp(pattern, 'u').test(text);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function businessError(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const code = payload.retcode ?? payload.code;
  if (code === undefined || code === 0 || code === '0') return null;
  const message = payload.tipMsg || payload.message || payload.msg || payload.error?.message || '接口业务返回失败';
  return `接口业务返回 ${code}: ${message}`;
}

function isCookieExpiredMessage(message) {
  return /4002|4003|uin\s*not\s*found|缺少\s*uin|invalid\s*pskey|pskey|p_skey|登录态|登录状态|未登录|cookie/i.test(String(message || ''));
}

function cookieExpiredError(message) {
  const err = new Error(`${message}。Cookie 可能已过期，请重新导入登录 Cookie。`);
  err.cookieExpired = true;
  return err;
}

function sanitizeSourceUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (parsed.searchParams.has('bkn')) parsed.searchParams.set('bkn', '[hidden]');
    return parsed.toString();
  } catch {
    return String(value || '').replace(/([?&]bkn=)[^&]+/i, '$1[hidden]');
  }
}

function markItemSource(item, sourceUrl) {
  if (item && typeof item === 'object') {
    Object.defineProperty(item, '__sourceUrl', { value: sourceUrl, enumerable: false, configurable: true });
  }
  return item;
}

async function fetchTrpcJson(url, options) {
  const response = await fetch(url, options);
  const raw = await response.text();
  let payload = raw;
  try { payload = JSON.parse(raw); } catch {}
  if (!response.ok) {
    const sample = raw.slice(0, 500).replace(/\s+/g, ' ');
    if (response.status === 401 || response.status === 403 || isCookieExpiredMessage(sample)) {
      throw cookieExpiredError(`接口返回 ${response.status} ${response.statusText}: ${sample}`);
    }
    throw new Error(`接口返回 ${response.status} ${response.statusText}: ${sample}`);
  }
  const bizErr = businessError(payload);
  if (bizErr) {
    if (isCookieExpiredMessage(bizErr)) throw cookieExpiredError(bizErr);
    throw new Error(bizErr);
  }
  return { status: response.status, payload };
}

function searchRequestFromFeedRequest(reqSpec) {
  const vars = requestVars(reqSpec.headers || {});
  return {
    url: applyVars(pdInGuildSearchUrl, vars),
    method: 'POST',
    headers: {
      ...reqSpec.headers,
      'content-type': 'application/json',
      'x-oidb': JSON.stringify({ uint32_command: '0x9287', uint32_service_type: '2' }),
      'X-QQ-Client-AppId': '537246381'
    }
  };
}

function inGuildSearchBody(guildId, keyword, feedCookie = '') {
  return JSON.stringify({
    guild_id: String(guildId),
    query: String(keyword),
    cookie: feedCookie || '',
    member_cookie: '',
    search_type: { type: 0, feed_type: 1 },
    cond: { channel_ids: [], feed_rank_type: 2, type_list: [2, 3] },
    guild_feed_data_type: 1
  });
}

async function crawlSearchItems(cfg, reqSpec, guildId, maxItems) {
  if (cfg.search?.enabled === false || !guildId || !cfg.keywords.length) {
    return { items: [], count: 0, totalHints: {}, errors: [] };
  }
  const searchReq = searchRequestFromFeedRequest(reqSpec);
  const maxPages = Math.max(1, Number(cfg.search?.maxPagesPerKeyword || 20));
  const items = [];
  const totalHints = {};
  const errors = [];

  for (const keyword of cfg.keywords) {
    let feedCookie = '';
    for (let page = 0; page < maxPages && items.length < maxItems; page += 1) {
      try {
        const { payload } = await fetchTrpcJson(searchReq.url, {
          method: searchReq.method,
          headers: searchReq.headers,
          body: inGuildSearchBody(guildId, keyword, feedCookie)
        });
        const result = getPath(payload, 'data.union_result') || {};
        const pageItems = Array.isArray(result.guild_feeds) ? result.guild_feeds : [];
        totalHints[keyword] = result.feed_total || totalHints[keyword] || '';
        for (const item of pageItems) {
          if (items.length >= maxItems) break;
          items.push(markItemSource(item, searchReq.url));
        }
        feedCookie = result.feed_cookie || '';
        if (result.feed_is_end === true || !feedCookie || pageItems.length === 0) break;
      } catch (err) {
        errors.push({ keyword, message: err.message, ...(err.cookieExpired ? { cookieExpired: true } : {}) });
        break;
      }
    }
  }

  return { items, count: items.length, totalHints, errors };
}

async function crawl(cfg) {
  const reqSpec = requestFromConfig(cfg);
  if (!reqSpec.url) {
    throw new Error('缺少 HTTP 接口。请在请求配置里填写 URL，或粘贴 DevTools 复制出来的 curl。');
  }
  const startedAt = new Date().toISOString();
  const guildId = requestGuildId(cfg);
  const guildMap = await readGuildMap();
  const maxItems = Number(cfg.limits.maxItemsPerRun || 200);
  const maxPages = Math.max(1, Number(cfg.limits.maxPagesPerRun || 1));
  const bounds = dateRangeBounds(cfg.dateRange);
  const items = [];
  let status = 0;
  let nextAttach = '';

  for (let page = 0; page < maxPages && items.length < maxItems; page += 1) {
    const pageBody = pageBodyWithAttach(reqSpec.body, nextAttach);
    const options = { method: reqSpec.method, headers: reqSpec.headers };
    if (pageBody && reqSpec.method !== 'GET' && reqSpec.method !== 'HEAD') options.body = pageBody;
    const { status: pageStatus, payload } = await fetchTrpcJson(reqSpec.url, options);
    status = pageStatus;
    const explicit = getPath(payload, cfg.request.itemPath);
    const pageItems = (Array.isArray(explicit) ? explicit : autoItems(payload));
    items.push(...pageItems.slice(0, maxItems - items.length).map(item => markItemSource(item, reqSpec.url)));
    nextAttach = nextPageAttach(payload);
    if (!nextAttach || getPath(payload, 'data.isFinish') === true || pageItems.length === 0) break;
  }

  const feedCount = items.length;
  const searchResult = await crawlSearchItems(cfg, reqSpec, guildId, maxItems);
  items.push(...searchResult.items);
  const uniqueItems = uniqueBy(items, item => pickId(item, cfg.request.idField, cfg.channel, itemText(item, cfg.request.textFields), pickTime(item, cfg.request.timeField)));

  const rangedItems = [];
  let dateSkipped = 0;
  for (const item of uniqueItems) {
    const time = pickTime(item, cfg.request.timeField);
    if (inDateRange(time, bounds)) rangedItems.push(item);
    else dateSkipped += 1;
  }

  const matches = [];
  const samples = [];
  for (const item of rangedItems) {
    const text = itemText(item, cfg.request.textFields);
    if (!text) continue;
    if (samples.length < 80) {
      const sampleTime = pickTime(item, cfg.request.timeField);
      const sampleId = pickId(item, cfg.request.idField, cfg.channel, text, '');
      samples.push({
        id: sampleId,
        guildId,
        time: sampleTime,
        displayTime: formatMessageTime(sampleTime, cfg.timezone || 'Asia/Shanghai'),
        postUrl: postUrlForMessage({ id: sampleId, guildId }, guildMap),
        text: text.replace(/\s+/g, ' ').slice(0, 500)
      });
    }
    const matchedKeywords = keywordMatches(text, cfg.keywords);
    if (!matchedKeywords.length) continue;
    const time = pickTime(item, cfg.request.timeField);
    const id = pickId(item, cfg.request.idField, cfg.channel, text, time);
    matches.push({
      id,
      guildId,
      channel: cfg.channel,
      time,
      displayTime: formatMessageTime(time, cfg.timezone || 'Asia/Shanghai'),
      postUrl: postUrlForMessage({ id, guildId }, guildMap),
      text,
      matchedKeywords,
      source: sanitizeSourceUrl(item.__sourceUrl || reqSpec.url),
      capturedAt: startedAt
    });
  }
  return {
    startedAt,
    status,
    guildId,
    fetchedCount: uniqueItems.length,
    feedCount,
    searchCount: searchResult.count,
    searchErrors: searchResult.errors,
    searchTotalHints: searchResult.totalHints,
    itemCount: rangedItems.length,
    dateSkipped,
    dateRange: cfg.dateRange || {},
    matchCount: matches.length,
    matches,
    samples
  };
}

function pageBodyWithAttach(body, attach) {
  if (!attach) return body;
  try {
    const parsed = JSON.parse(body || '{}');
    if (Object.prototype.hasOwnProperty.call(parsed, 'feedAttchInfo')) parsed.feedAttchInfo = attach;
    else if (Object.prototype.hasOwnProperty.call(parsed, 'attach_info')) parsed.attach_info = attach;
    else return body;
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

function nextPageAttach(payload) {
  return getPath(payload, 'data.feedAttchInfo') || getPath(payload, 'data.attach_info') || getPath(payload, 'feedAttchInfo') || getPath(payload, 'attach_info') || '';
}

async function saveMatches(matches) {
  const existing = await readJson(messagesPath, []);
  const itemKey = item => `${item.guildId || item.channel || ''}:${item.id}`;
  const sameTarget = (a, b) => {
    if (a.guildId && b.guildId) return String(a.guildId) === String(b.guildId);
    return a.channel && b.channel && String(a.channel) === String(b.channel);
  };
  const byId = new Map(existing.map(item => [itemKey(item), item]));
  let inserted = 0;
  for (const item of matches) {
    const key = itemKey(item);
    const previous = Array.from(byId.entries()).find(([, old]) => String(old.id) === String(item.id) && sameTarget(old, item));
    if (previous && previous[0] !== key) byId.delete(previous[0]);
    if (!previous) inserted += 1;
    byId.set(key, item);
  }
  const sorted = Array.from(byId.values()).sort((a, b) => String(b.time).localeCompare(String(a.time)));
  await writeJson(messagesPath, sorted);
  return { inserted, total: sorted.length, messages: sorted };
}

function sameTargetMessage(item, cfg) {
  const guildId = requestGuildId(cfg);
  if (guildId && item.guildId) return String(item.guildId) === guildId;
  return String(item.channel || '') === String(cfg.channel || '');
}

function retagMessagesForConfig(messages, cfg, guildMap = {}) {
  const bounds = dateRangeBounds(cfg.dateRange);
  return messages
    .filter(item => sameTargetMessage(item, cfg))
    .filter(item => inDateRange(item.time, bounds))
    .map(item => ({
      ...item,
      text: cleanupDisplayText(item.text || ''),
      displayTime: item.displayTime || formatMessageTime(item.time, cfg.timezone || 'Asia/Shanghai'),
      postUrl: item.postUrl || postUrlForMessage(item, guildMap),
      matchedKeywords: keywordMatches(item.text || '', cfg.keywords)
    }))
    .filter(item => item.matchedKeywords.length);
}

function cleanupDisplayText(value) {
  const lines = String(value || '').split(/\n+/).map(s => s.trim()).filter(Boolean);
  if (lines.length < 2) return String(value || '').trim();
  const firstCompact = compactTextForCompare(lines[0]);
  const rest = lines.slice(1).join('\n');
  const restCompact = compactTextForCompare(rest);
  if (firstCompact && restCompact.startsWith(firstCompact)) return rest.trim();
  return mergeTextParts(lines).join('\n').trim();
}

function todayKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const obj = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${obj.year}-${obj.month}-${obj.day}`;
}

function nowHm(timezone = 'Asia/Shanghai') {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const obj = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${obj.hour}:${obj.minute}`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[ch]));
}

function reportOutputDir(cfg) {
  const configured = String(cfg.report?.outputDir || 'reports').trim() || 'reports';
  return path.isAbsolute(configured) ? path.resolve(configured) : path.resolve(root, configured);
}

async function chooseFolder(initialPath = '') {
  const start = path.resolve(String(initialPath || '').trim() || root);
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择日报输出文件夹'
$dialog.ShowNewFolderButton = $true
$initial = ${JSON.stringify(start)}
if (Test-Path -LiteralPath $initial -PathType Container) { $dialog.SelectedPath = $initial }
$owner = New-Object System.Windows.Forms.Form
$owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.ShowInTaskbar = $false
$owner.TopMost = $true
$owner.Load.Add({ $owner.Activate() })
$owner.Show()
$owner.Activate()
$result = $dialog.ShowDialog($owner)
$owner.Close()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [Text.Encoding]::UTF8; Write-Output $dialog.SelectedPath }
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: false, timeout: 45000 });
  return String(stdout || '').trim();
}

async function generateReport(cfg, allMessages, runResult) {
  if (cfg.report?.enabled !== true) return null;
  const date = todayKey();
  const guildId = requestGuildId(cfg);
  const guildMap = await readGuildMap();
  const outDir = reportOutputDir(cfg);
  await fs.mkdir(outDir, { recursive: true });
  const dayMessages = retagMessagesForConfig(allMessages, cfg, guildMap).filter(item => {
    const sameDay = String(item.capturedAt || '').startsWith(date) || String(item.time || '').startsWith(date);
    return sameDay;
  });
  const mdLines = [
    `# ${date} 关键词日报`,
    '',
    `频道: ${cfg.channel}`,
    guildId ? `频道 ID: ${guildId}` : '',
    `关键词: ${cfg.keywords.join(', ') || '无'}`,
    `本次抓取: ${runResult.itemCount} 条，命中 ${runResult.matchCount} 条，新增 ${runResult.inserted} 条${runResult.searchCount ? `，搜索补全 ${runResult.searchCount} 条` : ''}`,
    `生成时间: ${new Date().toLocaleString('zh-CN', { timeZone: cfg.timezone || 'Asia/Shanghai' })}`,
    ''
  ];
  if (!dayMessages.length) {
    mdLines.push('今日暂无命中消息。');
  } else {
    dayMessages.forEach((item, idx) => {
      mdLines.push(`## ${idx + 1}. ${item.matchedKeywords.join(', ')}`);
      mdLines.push('');
      mdLines.push(`- 时间: ${item.displayTime || formatMessageTime(item.time, cfg.timezone || 'Asia/Shanghai')}`);
      mdLines.push(`- 频道: ${item.channel}`);
      if (item.postUrl) mdLines.push(`- 帖子: ${item.postUrl}`);
      mdLines.push(`- 来源: ${item.source}`);
      mdLines.push('');
      mdLines.push('```text');
      mdLines.push(item.text.slice(0, 4000));
      mdLines.push('```');
      mdLines.push('');
    });
  }
  const md = mdLines.join('\n');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${date} 关键词日报</title><link rel="stylesheet" href="/style.css"></head><body><main class="report"><h1>${date} 关键词日报</h1><div class="meta">频道: ${escapeHtml(cfg.channel)} | 关键词: ${escapeHtml(cfg.keywords.join(', '))} | 新增: ${runResult.inserted}</div>${dayMessages.length ? dayMessages.map((item, idx) => `<article><h2>${idx + 1}. ${escapeHtml(item.matchedKeywords.join(', '))}</h2><p class="meta">${escapeHtml(item.displayTime || formatMessageTime(item.time, cfg.timezone || 'Asia/Shanghai'))} | ${escapeHtml(item.channel)}${item.postUrl ? ` | <a href="${escapeHtml(item.postUrl)}" target="_blank" rel="noopener noreferrer">打开帖子</a>` : ''}</p><pre>${escapeHtml(item.text.slice(0, 4000))}</pre></article>`).join('') : '<p>今日暂无命中消息。</p>'}</main></body></html>`;
  const mdName = `${date}.md`;
  const htmlName = `${date}.html`;
  await fs.writeFile(path.join(outDir, mdName), md, 'utf8');
  await fs.writeFile(path.join(outDir, htmlName), html, 'utf8');
  return { date, outputDir: outDir, markdown: `/report-files/${encodeURIComponent(mdName)}`, html: `/report-files/${encodeURIComponent(htmlName)}` };
}

async function runOnce(trigger = 'manual') {
  if (state.running) throw new Error('已有抓取任务正在运行。');
  state.running = true;
  const cfg = normalizeConfig(await readJson(configPath, defaultConfig()));
  const runs = await readJson(runsPath, []);
  try {
    const crawlResult = await crawl(cfg);
    await writeJson(lastScanPath, {
      at: new Date().toISOString(),
      channel: cfg.channel,
      guildId: crawlResult.guildId,
      keywords: cfg.keywords,
      fetchedCount: crawlResult.fetchedCount,
      feedCount: crawlResult.feedCount,
      searchCount: crawlResult.searchCount,
      searchErrors: crawlResult.searchErrors,
      searchTotalHints: crawlResult.searchTotalHints,
      dateSkipped: crawlResult.dateSkipped,
      dateRange: crawlResult.dateRange,
      itemCount: crawlResult.itemCount,
      matchCount: crawlResult.matchCount,
      samples: crawlResult.samples
    });
    const { samples, ...crawlSummary } = crawlResult;
    const saved = await saveMatches(crawlResult.matches);
    const report = await generateReport(cfg, saved.messages, { ...crawlSummary, inserted: saved.inserted });
    const previewLimit = Math.max(0, Math.min(10, Number(cfg.notify?.maxPreview || 0)));
    const matchesPreview = previewLimit ? crawlResult.matches.slice(0, previewLimit).map(item => ({
      matchedKeywords: item.matchedKeywords || [],
      text: item.text || '',
      postUrl: item.postUrl || '',
      displayTime: item.displayTime || ''
    })) : [];
    const run = { trigger, ok: true, at: new Date().toISOString(), ...crawlSummary, inserted: saved.inserted, totalStored: saved.total, ...(report ? { report } : {}), ...(matchesPreview.length ? { matchesPreview } : {}) };
    try {
      const notification = await sendNotification(cfg, run, report);
      if (notification) run.notification = notification;
    } catch (err) {
      run.notification = { ok: false, error: err.message };
    }
    runs.unshift(run);
    await writeJson(runsPath, runs.slice(0, 200));
    state.lastRun = run;
    return run;
  } catch (err) {
    const cookieExpired = err.cookieExpired || isCookieExpiredMessage(err.message);
    const run = { trigger, ok: false, at: new Date().toISOString(), error: err.message, ...(cookieExpired ? { cookieExpired: true } : {}) };
    runs.unshift(run);
    await writeJson(runsPath, runs.slice(0, 200));
    state.lastRun = run;
    throw err;
  } finally {
    state.running = false;
  }
}

async function exportReportNow() {
  const cfg = normalizeConfig(await readJson(configPath, defaultConfig()));
  if (cfg.report?.enabled !== true) throw new Error('请先勾选并保存“导出日报”。');
  const messages = await readJson(messagesPath, []);
  const guildMap = await readGuildMap();
  const visible = retagMessagesForConfig(messages, cfg, guildMap).filter(item => {
    return !cfg.channel || String(item.channel || '') === String(cfg.channel || '');
  });
  const report = await generateReport(cfg, messages, {
    itemCount: visible.length,
    matchCount: visible.length,
    inserted: 0,
    searchCount: 0
  });
  if (!report) throw new Error('日报没有生成。');
  return report;
}

function notificationText(cfg, run) {
  const lines = [
    '# 频道关键词日报',
    '',
    `**${cfg.channel || '未命名频道'}**`,
    '',
    `> ${new Date(run.at || Date.now()).toLocaleString('zh-CN', { timeZone: cfg.timezone || 'Asia/Shanghai' })}`,
    `> 扫描 ${run.itemCount || 0} 条，命中 ${run.matchCount || 0} 条，新增 ${run.inserted || 0} 条`
  ];
  const previewCount = Math.max(0, Number(cfg.notify?.maxPreview || 0));
  const matches = Array.isArray(run.matchesPreview) ? run.matchesPreview.slice(0, previewCount) : [];
  for (const [idx, item] of matches.entries()) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push(`**命中关键词：${Array.isArray(item.matchedKeywords) ? item.matchedKeywords.join('、') : '未识别'}**`);
    lines.push('');
    lines.push(`帖${idx + 1}：${String(item.text || '').replace(/\s+/g, ' ').slice(0, 300)}`);
    if (item.postUrl) {
      lines.push('');
      lines.push(`[打开原帖子](${item.postUrl})`);
    }
  }
  return lines.join('\n');
}

async function postJson(url, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`通知接口 HTTP ${res.status}`);
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

async function sendNotification(cfg, run, report) {
  const notify = cfg.notify || {};
  if (notify.enabled !== true) return null;
  if (!notify.webhookUrl) throw new Error('通知 Webhook URL 为空');
  if (notify.onlyOnHit !== false && !(run.matchCount > 0 || run.inserted > 0)) return null;
  const text = notificationText(cfg, run);
  if (notify.platform === 'feishu') {
    const payload = { msg_type: 'text', content: { text } };
    if (notify.feishuSecret) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      payload.timestamp = timestamp;
      payload.sign = crypto.createHmac('sha256', `${timestamp}\n${notify.feishuSecret}`).update('').digest('base64');
    }
    const result = await postJson(notify.webhookUrl, payload);
    if (result.code && result.code !== 0) throw new Error(`飞书通知失败：${result.msg || result.code}`);
    return { ok: true, platform: 'feishu' };
  }
  const result = await postJson(notify.webhookUrl, { msgtype: 'markdown', markdown: { content: text } });
  if (result.errcode && result.errcode !== 0) throw new Error(`企业微信通知失败：${result.errmsg || result.errcode}`);
  return { ok: true, platform: 'wecom' };
}

async function listReports() {
  const cfg = normalizeConfig(await readJson(configPath, defaultConfig()));
  if (cfg.report?.enabled !== true) return [];
  const outDir = reportOutputDir(cfg);
  let files = [];
  try { files = await fs.readdir(outDir); } catch { return []; }
  return files.filter(file => /\.(md|html)$/i.test(file)).sort().reverse().map(file => ({ name: file, outputDir: outDir, url: `/report-files/${encodeURIComponent(file)}` }));
}

async function clearCrawlData() {
  return { ok: true, displayOnly: true };
}

async function listFilesSafe(dir) {
  try {
    const names = await fs.readdir(dir);
    return names.map(name => path.join(dir, name));
  } catch {
    return [];
  }
}

async function chromeProfiles() {
  const names = await fs.readdir(chromeUserData, { withFileTypes: true }).catch(() => []);
  return names
    .filter(item => item.isDirectory() && (item.name === 'Default' || /^Profile \d+$/i.test(item.name)))
    .map(item => path.join(chromeUserData, item.name));
}

function decodeUtf16JsonArray(buffer, start) {
  const open = buffer.indexOf(Buffer.from('[\x00{\x00', 'binary'), start);
  if (open < 0) return null;
  const close = buffer.indexOf(Buffer.from('}\x00]\x00', 'binary'), open);
  if (close < 0) return null;
  try {
    return JSON.parse(buffer.slice(open, close + 4).toString('utf16le'));
  } catch {
    return null;
  }
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

async function knownGuilds() {
  const map = await readGuildMap();
  return Object.entries(map).map(([guildId, info]) => ({
    guildId,
    guildName: info.name || guildId,
    guildNum: info.guildNum || '',
    sourceProfile: info.source || 'saved'
  }));
}

async function chromeGuilds() {
  const profiles = await chromeProfiles();
  const guilds = [];
  for (const profile of profiles) {
    const dir = path.join(profile, 'Local Storage', 'leveldb');
    const files = await listFilesSafe(dir);
    for (const file of files.filter(file => /\.(log|ldb)$/i.test(file))) {
      let data;
      try { data = await fs.readFile(file); } catch { continue; }
      let offset = 0;
      while ((offset = data.indexOf('myGuild_', offset, 'utf8')) >= 0) {
        const parsed = decodeUtf16JsonArray(data, offset);
        if (Array.isArray(parsed)) {
          for (const guild of parsed) guilds.push({ ...guild, sourceProfile: path.basename(profile), sourceFile: file });
        }
        offset += 8;
      }
    }
  }
  const known = await knownGuilds();
  return uniqueBy([...guilds, ...known], item => item.guildId).sort((a, b) => String(a.guildName || '').localeCompare(String(b.guildName || ''), 'zh-CN'));
}

async function chromeSignals() {
  const profiles = await chromeProfiles();
  const signals = [];
  const pattern = /"sgrp_channel_id":"(\d+)"(?:[^{}]{0,180})"sgrp_sub_channel_id":"(\d+)"(?:[^{}]{0,220})"sgrp_feed_id":"([^"]+)"/g;
  for (const profile of profiles) {
    const dir = path.join(profile, 'IndexedDB', 'https_pd.qq.com_0.indexeddb.leveldb');
    const files = await listFilesSafe(dir);
    for (const file of files.filter(file => /\.(log|ldb)$/i.test(file))) {
      let text;
      try { text = (await fs.readFile(file)).toString('utf8'); } catch { continue; }
      for (const match of text.matchAll(pattern)) {
        signals.push({ guildId: match[1], subChannelId: match[2], feedId: match[3], sourceProfile: path.basename(profile), sourceFile: file });
      }
    }
  }
  return uniqueBy(signals, item => `${item.guildId}:${item.subChannelId}:${item.feedId}`);
}

async function resolveUnknownGuildNames(limit = 30) {
  const map = await readGuildMap();
  const signals = await chromeSignals();
  const byGuild = new Map();
  for (const signal of signals) {
    if (!signal.guildId || !signal.feedId || map[signal.guildId]?.name) continue;
    if (!byGuild.has(signal.guildId)) byGuild.set(signal.guildId, signal.feedId);
  }
  const targets = Array.from(byGuild.entries()).slice(0, Math.max(1, Number(limit) || 30));
  const resolved = [];
  const failed = [];
  for (const [guildId, feedId] of targets) {
    try {
      const name = await resolveGuildNameFromFeed(guildId, feedId);
      if (name) {
        map[guildId] = { ...(map[guildId] || {}), name, source: 'post-page', updatedAt: new Date().toISOString() };
        resolved.push({ guildId, guildName: name, feedId });
      } else {
        failed.push({ guildId, feedId });
      }
    } catch {
      failed.push({ guildId, feedId });
    }
  }
  await writeGuildMap(map);
  return { ok: true, resolved, failed, guildMap: map };
}

async function staticFile(res, base, requestPath) {
  const clean = decodeURIComponent(requestPath.split('?')[0]).replace(/^\/+/, '');
  const file = path.resolve(base, clean || 'index.html');
  if (!file.startsWith(path.resolve(base))) return json(res, 403, { error: 'Forbidden' });
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error('not file');
    res.writeHead(200, {
      'content-type': mime.get(path.extname(file)) || 'application/octet-stream',
      'cache-control': 'no-store'
    });
    res.end(await fs.readFile(file));
  } catch {
    json(res, 404, { error: 'Not found' });
  }
}


function sampleFeed() {
  return {
    code: 0,
    data: {
      list: [
        { id: 'sample-1', created_at: new Date().toISOString(), title: '今日青理（临沂）', content: '代做相关关键词测试消息，用于验证日报生成链路。' },
        { id: 'sample-2', created_at: new Date().toISOString(), title: '普通通知', content: '这条消息不会命中默认关键词。' }
      ]
    }
  };
}
async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'OPTIONS') return json(res, 204, {});
    if (req.method === 'GET' && url.pathname === '/api/config') {
      const cfg = normalizeConfig(await readJson(configPath, defaultConfig()));
      return json(res, 200, { ...cfg, guildMap: await readGuildMap() });
    }
    if (req.method === 'POST' && url.pathname === '/api/config') {
      const cfg = await saveConfig(await bodyJson(req));
      return json(res, 200, cfg);
    }
    if (req.method === 'POST' && url.pathname === '/api/switch-guild') return json(res, 200, await switchGuild(await bodyJson(req)));
    if (req.method === 'POST' && url.pathname === '/api/import-cookie') {
      const body = await bodyJson(req);
      return json(res, 200, await importCookie(body.cookie));
    }
    if (req.method === 'POST' && url.pathname === '/api/choose-folder') {
      const body = await bodyJson(req).catch(() => ({}));
      const selected = await chooseFolder(body.initialPath || '');
      return json(res, 200, { ok: true, path: selected, cancelled: !selected });
    }
    if (req.method === 'POST' && url.pathname === '/api/run') return json(res, 200, await runOnce('manual'));
    if (req.method === 'POST' && url.pathname === '/api/export-report') return json(res, 200, await exportReportNow());
    if (req.method === 'POST' && url.pathname === '/api/clear-data') return json(res, 200, await clearCrawlData());
    if (req.method === 'GET' && url.pathname === '/api/reports') return json(res, 200, await listReports());
    if (req.method === 'GET' && url.pathname === '/api/runs') return json(res, 200, await readJson(runsPath, []));
    if (req.method === 'GET' && url.pathname === '/api/messages') {
      const cfg = normalizeConfig(await readJson(configPath, defaultConfig()));
      return json(res, 200, retagMessagesForConfig(await readJson(messagesPath, []), cfg, await readGuildMap()));
    }
    if (req.method === 'GET' && url.pathname === '/api/last-scan') return json(res, 200, await readJson(lastScanPath, null));
    if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, { running: state.running, lastRun: state.lastRun });
    if (req.method === 'GET' && url.pathname === '/api/chrome-guilds') {
      const guilds = await chromeGuilds();
      for (const guild of guilds) {
        await rememberGuild(guild.guildId, guild.guildName, { guildNum: guild.guildNum || '', source: guild.sourceProfile || 'chrome' });
      }
      return json(res, 200, { guilds, signals: await chromeSignals(), guildMap: await readGuildMap() });
    }
    if (req.method === 'POST' && url.pathname === '/api/resolve-guild-names') {
      const body = await bodyJson(req).catch(() => ({}));
      return json(res, 200, await resolveUnknownGuildNames(body.limit || 30));
    }
    if (req.method === 'GET' && url.pathname === '/api/tencent-preset') return json(res, 200, tencentGuildPreset(url.searchParams.get('guildId') || undefined));
    if (req.method === 'GET' && url.pathname === '/sample/feed') return json(res, 200, sampleFeed());
    if (req.method === 'GET' && url.pathname.startsWith('/reports/')) return staticFile(res, reportsDir, url.pathname.slice('/reports/'.length));
    if (req.method === 'GET' && url.pathname.startsWith('/report-files/')) {
      const cfg = normalizeConfig(await readJson(configPath, defaultConfig()));
      return staticFile(res, reportOutputDir(cfg), url.pathname.slice('/report-files/'.length));
    }
    if (req.method === 'GET') return staticFile(res, publicDir, url.pathname.slice(1));
    json(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    json(res, 500, { error: err.message, ...(err.cookieExpired || isCookieExpiredMessage(err.message) ? { cookieExpired: true } : {}) });
  }
}

async function schedulerTick() {
  if (state.running) return;
  const cfg = normalizeConfig(await readJson(configPath, defaultConfig()));
  const hm = nowHm(cfg.timezone || 'Asia/Shanghai');
  const key = `${todayKey()} ${cfg.scheduleTime}`;
  if (hm === cfg.scheduleTime && state.lastSchedulerKey !== key) {
    state.lastSchedulerKey = key;
    runOnce('schedule').catch(err => console.error('[schedule]', err.message));
  }
}

await ensureFiles();

if (process.argv.includes('--once')) {
  try {
    const result = await runOnce('cli');
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
} else {
  setInterval(() => schedulerTick().catch(err => console.error('[scheduler]', err.message)), 30_000);
  const server = http.createServer((req, res) => handle(req, res));
  server.listen(port, '127.0.0.1', () => {
    console.log(`pd keyword reporter running at http://localhost:${port}`);
  });
}



