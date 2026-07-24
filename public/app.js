const $ = id => document.getElementById(id);

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error || res.statusText);
    err.cookieExpired = data.cookieExpired === true;
    throw err;
  }
  return data;
}

function lines(value) {
  return String(value || '').split(/[,，\n]/).map(s => s.trim()).filter(Boolean);
}

let guildMap = {};
let currentReports = [];

function applyTheme(theme) {
  const dark = theme === 'dark';
  document.body.classList.toggle('dark', dark);
  const btn = $('themeBtn');
  if (btn) {
    btn.textContent = dark ? '☀' : '☾';
    btn.setAttribute('aria-label', dark ? '切换到浅色模式' : '切换到深色模式');
    btn.title = dark ? '切换到浅色模式' : '切换到深色模式';
  }
}

function toggleTheme() {
  const next = document.body.classList.contains('dark') ? 'light' : 'dark';
  localStorage.setItem('pd-theme', next);
  applyTheme(next);
}

function bodyGuildId(value = $('body')?.value || '') {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed.guild_id ? String(parsed.guild_id) : '';
  } catch {
    const match = String(value || '').match(/"guild_id"\s*:\s*"?(\d+)"?/);
    return match ? match[1] : '';
  }
}

function formatMessageTime(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let date;
  if (/^\d{10}$/.test(raw)) date = new Date(Number(raw) * 1000);
  else if (/^\d{13}$/.test(raw)) date = new Date(Number(raw));
  else if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    date = new Date(n > 10_000_000_000 ? n : n * 1000);
  } else {
    date = new Date(raw);
  }
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleString('zh-CN', { hour12: false });
}

function updateTargetInfo() {
  const box = $('targetInfo');
  if (!box) return;
  const guildId = bodyGuildId();
  if (!guildId) {
    box.textContent = '真实抓取目标：未配置 guild_id';
    box.className = 'target-info warn';
    return;
  }
  const mappedName = guildMap[guildId]?.name || '';
  const currentName = $('channel')?.value.trim() || '';
  const mismatch = mappedName && currentName && mappedName !== currentName;
  box.textContent = `真实抓取目标：${guildId}，映射名称：${mappedName || '未知'}${mismatch ? `，当前填写：${currentName}` : ''}`;
  box.className = mismatch ? 'target-info warn' : 'target-info okbox';
}

function setStatus(text, cls = '') {
  const el = $('status');
  el.textContent = text;
  el.className = cls;
}

function cookieImportScript() {
  return "fetch('http://localhost:8787/api/import-cookie',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({cookie:document.cookie})}).then(r=>r.json()).then(console.log).catch(console.error)";
}

function normalizeCookie(value) {
  return String(value || '')
    .trim()
    .replace(/^cookie:\s*/i, '')
    .replace(/\r?\n/g, ' ')
    .trim();
}

function headersFromForm() {
  try {
    const headers = JSON.parse($('headers').value || '{}');
    const cookie = normalizeCookie($('cookieInput')?.value || '');
    if (cookie) headers.cookie = cookie;
    return headers;
  } catch {
    throw new Error('请求头 JSON 格式不正确');
  }
}

function writeCookieToHeaders() {
  const cookie = normalizeCookie($('cookieInput').value);
  if (!cookie) throw new Error('请先粘贴 Cookie');
  const headers = headersFromForm();
  headers.cookie = cookie;
  $('headers').value = JSON.stringify(headers, null, 2);
  $('cookieInput').value = '';
  hideCookieStatus();
  setStatus('Cookie 已写入请求头。', 'ok');
}

function showCookieExpired(message = 'Cookie 可能已过期，请重新导入登录 Cookie。') {
  const detail = $('loginSettings');
  const box = $('cookieStatus');
  if (detail) detail.open = true;
  if (box) {
    box.textContent = message;
    box.classList.remove('is-hidden');
  }
  setStatus(message, 'fail');
  detail?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function hideCookieStatus() {
  $('cookieStatus')?.classList.add('is-hidden');
}

function configFromForm() {
  const headers = headersFromForm();
  return {
    channel: $('channel').value.trim(),
    keywords: lines($('keywords').value),
    scheduleTime: $('scheduleTime').value || '08:30',
    timezone: 'Asia/Shanghai',
    dateRange: {
      startDate: $('startDate').value || '',
      endDate: $('endDate').value || ''
    },
    search: {
      enabled: $('searchEnabled').checked,
      maxPagesPerKeyword: Number($('maxSearchPagesPerKeyword').value || 20)
    },
    report: {
      enabled: $('reportEnabled').checked,
      outputDir: $('reportOutputDir').value.trim() || 'reports'
    },
    notify: {
      enabled: $('notifyEnabled').checked,
      platform: $('notifyPlatform').value,
      webhookUrl: $('notifyWebhookUrl').value.trim(),
      feishuSecret: $('notifyFeishuSecret').value.trim(),
      onlyOnHit: $('notifyOnlyOnHit').checked,
      maxPreview: Number($('notifyMaxPreview').value || 3)
    },
    request: {
      curl: $('curl').value.trim(),
      url: $('requestUrl').value.trim(),
      method: $('method').value,
      headers,
      body: $('body').value,
      itemPath: $('itemPath').value.trim(),
      idField: $('idField').value.trim(),
      timeField: $('timeField').value.trim(),
      textFields: lines($('textFields').value)
    },
    limits: {
      maxItemsPerRun: Number($('maxItemsPerRun').value || 200),
      maxPagesPerRun: Number($('maxPagesPerRun').value || 20)
    }
  };
}

function fillForm(cfg) {
  guildMap = cfg.guildMap || guildMap;
  $('channel').value = cfg.channel || '';
  $('keywords').value = (cfg.keywords || []).join('\n');
  $('scheduleTime').value = cfg.scheduleTime || '08:30';
  $('startDate').value = cfg.dateRange?.startDate || '';
  $('endDate').value = cfg.dateRange?.endDate || '';
  $('searchEnabled').checked = cfg.search?.enabled !== false;
  $('maxSearchPagesPerKeyword').value = cfg.search?.maxPagesPerKeyword || 20;
  $('reportEnabled').checked = cfg.report?.enabled === true;
  $('reportOutputDir').value = cfg.report?.outputDir || 'reports';
  $('notifyEnabled').checked = cfg.notify?.enabled === true;
  $('notifyPlatform').value = cfg.notify?.platform || 'wecom';
  $('notifyWebhookUrl').value = cfg.notify?.webhookUrl || '';
  $('notifyFeishuSecret').value = cfg.notify?.feishuSecret || '';
  $('notifyOnlyOnHit').checked = cfg.notify?.onlyOnHit !== false;
  $('notifyMaxPreview').value = cfg.notify?.maxPreview ?? 3;
  $('requestUrl').value = cfg.request?.url || '';
  $('method').value = cfg.request?.method || 'GET';
  $('headers').value = JSON.stringify(cfg.request?.headers || {}, null, 2);
  $('cookieInput').value = '';
  $('body').value = cfg.request?.body || '';
  $('curl').value = cfg.request?.curl || '';
  $('itemPath').value = cfg.request?.itemPath || '';
  $('idField').value = cfg.request?.idField || '';
  $('timeField').value = cfg.request?.timeField || '';
  $('textFields').value = (cfg.request?.textFields || []).join('\n');
  $('maxPagesPerRun').value = cfg.limits?.maxPagesPerRun || 20;
  $('maxItemsPerRun').value = cfg.limits?.maxItemsPerRun || 200;
  updateTargetInfo();
}

async function saveConfig() {
  const cfg = configFromForm();
  const saved = await api('/api/config', { method: 'POST', body: JSON.stringify(cfg) });
  setStatus(`已保存。每天 ${saved.scheduleTime} 运行。${saved.report.enabled ? '会导出日报。' : '不会导出日报。'}`, 'ok');
  return saved;
}

async function browseReportDir() {
  const btn = $('browseReportDirBtn');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 50000);
  btn.disabled = true;
  try {
    setStatus('请选择日报输出文件夹...', '');
    const result = await api('/api/choose-folder', {
      method: 'POST',
      signal: controller.signal,
      body: JSON.stringify({ initialPath: $('reportOutputDir').value.trim() })
    });
    if (result.path) {
      $('reportOutputDir').value = result.path;
      $('reportEnabled').checked = true;
      setStatus('已选择日报输出文件夹。', 'ok');
    } else {
      setStatus('已取消选择文件夹。', '');
    }
  } catch (err) {
    const message = err.name === 'AbortError'
      ? '选择文件夹超时。可以重试，或直接在输入框填写输出目录。'
      : err.message;
    setStatus(message, 'fail');
  } finally {
    clearTimeout(timeout);
    btn.disabled = false;
  }
}

async function runNow() {
  $('runBtn').disabled = true;
  $('saveBtn').disabled = true;
  try {
    await saveConfig();
    setStatus('正在爬取...', '');
    const run = await api('/api/run', { method: 'POST', body: '{}' });
    const rangeNote = run.dateSkipped ? `；日期范围外 ${run.dateSkipped} 条` : '';
    const fetchNote = run.fetchedCount && run.fetchedCount !== run.itemCount ? `，接口返回 ${run.fetchedCount} 条` : '';
    const searchNote = run.searchCount ? `，搜索补全 ${run.searchCount} 条` : '';
    const searchErrorNote = run.searchErrors?.length ? `；搜索失败 ${run.searchErrors.length} 个关键词` : '';
    const reportNote = run.report ? '，已导出日报' : '，未导出日报';
    setStatus(`完成：扫描 ${run.itemCount} 条${fetchNote}${searchNote}，命中 ${run.matchCount} 条，新增命中 ${run.inserted} 条${reportNote}${rangeNote}${searchErrorNote}。`, run.searchErrors?.length ? 'fail' : 'ok');
    await refreshLists();
  } catch (err) {
    if (err.cookieExpired) showCookieExpired(err.message);
    else setStatus(err.message, 'fail');
    await refreshLists();
  } finally {
    $('runBtn').disabled = false;
    $('saveBtn').disabled = false;
  }
}

async function exportDailyReport() {
  const btn = $('exportReportBtn');
  if (btn) btn.disabled = true;
  try {
    await saveConfig();
    setStatus('正在导出日报...', '');
    const report = await api('/api/export-report', { method: 'POST', body: '{}' });
    setStatus(`日报已导出：${report.outputDir || ''}`, 'ok');
    await refreshLists();
  } catch (err) {
    setStatus(err.message, 'fail');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function clearHistory() {
  const ok = window.confirm('确定清空当前页面显示吗？底层数据文件不会删除，刷新页面会重新显示。');
  if (!ok) return;
  $('clearBtn').disabled = true;
  try {
    $('runs').innerHTML = '<div class="meta">当前页面显示已清空</div>';
    $('reports').innerHTML = '<div class="meta">当前页面显示已清空</div>';
    $('messages').innerHTML = '<div class="meta">当前页面显示已清空</div>';
    $('lastScan').innerHTML = '<div class="meta">当前页面显示已清空</div>';
    setStatus('已清空当前页面显示。底层数据未删除，刷新页面会恢复。', 'ok');
  } catch (err) {
    setStatus(err.message, 'fail');
  } finally {
    $('clearBtn').disabled = false;
  }
}

async function loadChromeGuilds() {
  $('chromeBtn').disabled = true;
  try {
    setStatus('正在读取 Chrome 本地频道信息...', '');
    const data = await api('/api/chrome-guilds');
    guildMap = data.guildMap || guildMap;
    updateTargetInfo();
    renderChromeGuilds(data.guilds || [], data.signals || []);
    setStatus(`已读取 ${data.guilds?.length || 0} 个频道名称，${data.signals?.length || 0} 条接口线索。`, 'ok');
  } catch (err) {
    setStatus(err.message, 'fail');
  } finally {
    $('chromeBtn').disabled = false;
  }
}

async function resolveGuildNames() {
  $('resolveGuildBtn').disabled = true;
  try {
    setStatus('正在从帖子页反查未知频道名称...', '');
    const data = await api('/api/resolve-guild-names', {
      method: 'POST',
      body: JSON.stringify({ limit: 30 })
    });
    guildMap = data.guildMap || guildMap;
    updateTargetInfo();
    setStatus(`已解析 ${data.resolved?.length || 0} 个频道名称，失败 ${data.failed?.length || 0} 个。`, 'ok');
    await loadChromeGuilds();
  } catch (err) {
    setStatus(err.message, 'fail');
  } finally {
    $('resolveGuildBtn').disabled = false;
  }
}

async function fillTencentPreset(guildId = '', guildName = '', options = {}) {
  try {
    const currentHeaders = headersFromForm();
    const query = guildId ? `?guildId=${encodeURIComponent(guildId)}` : '';
    const preset = await api(`/api/tencent-preset${query}`);
    const mappedName = guildName || guildMap[guildId]?.name || '';
    if (mappedName) {
      $('channel').value = mappedName;
    } else if (guildId) {
      const inputName = window.prompt(`这个 guild_id 暂时没有频道名，可以填一个：\n${guildId}`, $('channel').value.trim());
      if (inputName) $('channel').value = inputName.trim();
    }
    const presetHeaders = { ...(preset.headers || {}) };
    if (currentHeaders.cookie) presetHeaders.cookie = currentHeaders.cookie;
    $('requestUrl').value = preset.url || '';
    $('method').value = preset.method || 'POST';
    $('headers').value = JSON.stringify(presetHeaders, null, 2);
    $('body').value = preset.body || '';
    $('itemPath').value = preset.itemPath || '';
    $('idField').value = preset.idField || '';
    $('timeField').value = preset.timeField || '';
    $('textFields').value = (preset.textFields || []).join('\n');
    updateTargetInfo();
    if (options.autoSave) {
      const cfg = await saveConfig();
      setStatus(`已切换并保存：${cfg.channel || $('channel').value}。真实抓取目标 ${bodyGuildId()}。`, 'ok');
      await refreshLists();
    } else {
      setStatus('已填入腾讯频道 HTTP 接口模板。还需要补 Cookie 或粘贴完整 curl。', 'ok');
    }
  } catch (err) {
    setStatus(err.message, 'fail');
  }
}

async function switchGuild(guildId = '', guildName = '') {
  if (!guildId) {
    setStatus('缺少 guildId，无法切换频道。', 'fail');
    return;
  }
  const finalName = guildName || guildMap[guildId]?.name || window.prompt(`这个 guild_id 暂时没有频道名，可以填一个：\n${guildId}`, $('channel').value.trim()) || '';
  setStatus(`正在切换频道：${finalName || guildId}...`, '');
  const cfg = await api('/api/switch-guild', {
    method: 'POST',
    body: JSON.stringify({ guildId, guildName: finalName })
  });
  fillForm(cfg);
  setStatus(`已切换并保存：${cfg.channel}。真实抓取目标 ${bodyGuildId()}。`, 'ok');
  await refreshLists();
}

function renderRuns(runs) {
  const box = $('runs');
  if (!runs.length) {
    box.innerHTML = '<div class="meta">暂无运行记录</div>';
    return;
  }
  box.innerHTML = runs.slice(0, 6).map(run => `
    <div class="row">
      <strong class="${run.ok ? 'ok' : 'fail'}">${run.ok ? '成功' : '失败'}</strong>
      <div class="meta">${new Date(run.at).toLocaleString()} | ${run.trigger}</div>
      <div class="meta">${run.ok ? `扫描 ${run.itemCount}${run.fetchedCount && run.fetchedCount !== run.itemCount ? `，接口返回 ${run.fetchedCount}` : ''}${run.searchCount ? `，搜索补全 ${run.searchCount}` : ''}，命中 ${run.matchCount}，新增命中 ${run.inserted}${run.dateSkipped ? `，日期范围外 ${run.dateSkipped}` : ''}${run.searchErrors?.length ? `，搜索失败 ${run.searchErrors.length}` : ''}` : escapeHtml(run.error || '')}</div>
      ${run.cookieExpired ? '<div class="meta fail">Cookie 已失效，请重新导入登录 Cookie。</div>' : ''}
      ${run.notification ? `<div class="meta">通知：${run.notification.ok ? `已发送到 ${escapeHtml(run.notification.platform || '')}` : `失败，${escapeHtml(run.notification.error || '')}`}</div>` : ''}
    </div>
  `).join('');
}

function renderLastScan(scan) {
  const box = $('lastScan');
  if (!scan) {
    box.innerHTML = '<div class="meta">暂无抓取样本</div>';
    return;
  }
  const keywords = scan.keywords || [];
  const samples = scan.samples || [];
  const hitPreview = samples
    .filter(item => keywords.some(keyword => String(item.text || '').includes(keyword)))
    .slice(0, 5);
  const visibleSamples = hitPreview.length ? hitPreview : samples.slice(0, 8);
  const preview = visibleSamples.map(item => `
    <div class="sample">
      <div class="meta">
        ${escapeHtml(item.displayTime || formatMessageTime(item.time))} | ID: ${escapeHtml(item.id || '')}
      </div>
      ${item.postUrl ? `<a href="${escapeHtml(item.postUrl)}" target="_blank" rel="noopener noreferrer">打开帖子</a>` : ''}
      <pre>${escapeHtml(item.text || '')}</pre>
    </div>
  `).join('');
  box.innerHTML = `
    <div class="row">
      <strong>${escapeHtml(scan.channel || '')}</strong>
      <div class="meta">${new Date(scan.at).toLocaleString()} | 关键词：${escapeHtml(keywords.join(', ') || '无')}</div>
      <div class="meta">扫描 ${scan.itemCount || 0} 条${scan.fetchedCount && scan.fetchedCount !== scan.itemCount ? `，接口返回 ${scan.fetchedCount} 条` : ''}${scan.searchCount ? `，搜索补全 ${scan.searchCount} 条` : ''}，命中 ${scan.matchCount || 0} 条，样本 ${samples.length} 条${scan.dateSkipped ? `，日期范围外 ${scan.dateSkipped} 条` : ''}${scan.searchErrors?.length ? `，搜索失败 ${scan.searchErrors.length}` : ''}</div>
    </div>
    ${preview || '<div class="meta">本次扫描没有可展示文本，可能是字段提取没拿到正文。</div>'}
  `;
}

function renderReports(reports) {
  currentReports = reports || [];
  const box = $('reports');
  if (!$('reportEnabled')?.checked) {
    box.innerHTML = '<div class="meta">未启用日报导出</div>';
    return;
  }
  const outputDir = $('reportOutputDir')?.value.trim() || 'reports';
  const rows = currentReports.slice(0, 8).map(report => `
    <div class="row">
      <a href="${report.url}" target="_blank">${escapeHtml(report.name)}</a>
      ${report.outputDir ? `<div class="meta">${escapeHtml(report.outputDir)}</div>` : ''}
    </div>
  `).join('');
  box.innerHTML = `
    <div class="row">
      <strong>日报导出已启用</strong>
      <div class="meta">输出位置：${escapeHtml(outputDir)}</div>
      <button id="exportReportBtn" type="button" class="small">立即导出日报</button>
    </div>
    ${rows || '<div class="meta">暂无日报。爬取完成或点击上方按钮后会生成。</div>'}
  `;
  $('exportReportBtn')?.addEventListener('click', () => exportDailyReport());
}

function renderChromeGuilds(guilds, signals) {
  const box = $('chromeGuilds');
  if (!guilds.length && !signals.length) {
    box.innerHTML = '<div class="meta">没有读到 pd.qq.com 的频道缓存。请先在 Chrome 打开并登录频道页。</div>';
    return;
  }
  const byGuild = new Map();
  for (const signal of signals) {
    if (!byGuild.has(signal.guildId)) byGuild.set(signal.guildId, []);
    byGuild.get(signal.guildId).push(signal);
  }
  const rows = guilds.map(guild => {
    const related = byGuild.get(guild.guildId) || [];
    const first = related[0];
    return `
      <div class="row">
        <strong>${escapeHtml(guild.guildName || guild.guildId)}</strong>
        <div class="meta">guildId: ${escapeHtml(guild.guildId || '')}${guild.guildNum ? ` | guildNum: ${escapeHtml(guild.guildNum)}` : ''}${guild.sourceProfile ? ` | 来源: ${escapeHtml(guild.sourceProfile)}` : ''}</div>
        ${first ? `<div class="meta">最近线索: subChannelId=${escapeHtml(first.subChannelId)} | feedId=${escapeHtml(first.feedId)}</div>` : '<div class="meta">暂无 feed 埋点线索</div>'}
        <button type="button" class="small" data-channel="${escapeHtml(guild.guildName || '')}">填入频道名</button>
        <button type="button" class="small" data-guild-id="${escapeHtml(guild.guildId || '')}" data-channel-name="${escapeHtml(guild.guildName || '')}">切换并保存</button>
      </div>
    `;
  });
  const knownGuildIds = new Set(guilds.map(guild => String(guild.guildId || '')));
  const signalOnly = Array.from(byGuild.entries())
    .filter(([guildId]) => guildId && !knownGuildIds.has(String(guildId)))
    .slice(0, 20);
  for (const [guildId, related] of signalOnly) {
    const first = related[0] || {};
    rows.push(`
      <div class="row">
        <strong>${escapeHtml(guildMap[guildId]?.name || `未知频道 ${guildId}`)}</strong>
        <div class="meta">guildId: ${escapeHtml(guildId)}${first.sourceProfile ? ` | Chrome: ${escapeHtml(first.sourceProfile)}` : ''}</div>
        <div class="meta">最近线索: subChannelId=${escapeHtml(first.subChannelId || '')} | feedId=${escapeHtml(first.feedId || '')}</div>
        <button type="button" class="small" data-guild-id="${escapeHtml(guildId)}" data-channel-name="${escapeHtml(guildMap[guildId]?.name || '')}">切换并保存</button>
      </div>
    `);
  }
  box.innerHTML = rows.join('') || '<div class="meta">只读到空线索。请先在 Chrome 打开目标频道页面。</div>';
  box.querySelectorAll('button[data-channel]').forEach(button => {
    button.addEventListener('click', () => {
      $('channel').value = button.dataset.channel || '';
      setStatus('已填入频道名。真实抓取仍需要请求 URL 或 curl。', 'ok');
    });
  });
  box.querySelectorAll('button[data-guild-id]').forEach(button => {
    button.addEventListener('click', () => switchGuild(button.dataset.guildId || '', button.dataset.channelName || ''));
  });
}

function renderMessages(messages, latestRun) {
  const box = $('messages');
  const summary = $('messagesSummary');
  const currentChannel = $('channel').value.trim();
  const visible = currentChannel
    ? messages.filter(item => String(item.channel || '') === currentChannel)
    : messages;
  const hiddenCount = messages.length - visible.length;
  if (summary) {
    const latestCount = latestRun?.ok ? latestRun.matchCount : 0;
    const start = $('startDate')?.value || '';
    const end = $('endDate')?.value || '';
    const range = start || end ? `；日期范围 ${start || '不限'} 至 ${end || '不限'}` : '';
    summary.textContent = `当前频道历史累计 ${visible.length} 条；最近一次本次命中 ${latestCount} 条${range}`;
  }
  if (!visible.length) {
    box.innerHTML = '<div class="meta">暂无历史命中消息</div>';
    return;
  }
  box.innerHTML = visible.slice(0, 30).map(item => `
    <article class="message">
      <div class="message-main">
        <span class="hit-badge">↧</span>
        <div>
          <h3>${escapeHtml(item.displayTime || formatMessageTime(item.time))} | ${escapeHtml(item.channel || '')}</h3>
          <pre>${escapeHtml((item.text || '').slice(0, 1200))}</pre>
        </div>
      </div>
      ${item.postUrl ? `<a class="message-link" href="${escapeHtml(item.postUrl)}" target="_blank" rel="noopener noreferrer">打开帖子</a>` : ''}
    </article>
  `).join('');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

async function refreshLists() {
  const [runs, reports, messages, lastScan] = await Promise.all([
    api('/api/runs'),
    api('/api/reports'),
    api('/api/messages'),
    api('/api/last-scan')
  ]);
  renderRuns(runs);
  renderReports(reports);
  renderMessages(messages, runs[0]);
  renderLastScan(lastScan);
}

async function init() {
  try {
    const cfg = await api('/api/config');
    fillForm(cfg);
    $('importScript').value = cookieImportScript();
    setStatus(`已加载。默认频道：${cfg.channel}，关键词：${(cfg.keywords || []).join(', ')}`, '');
    await refreshLists();
  } catch (err) {
    setStatus(err.message, 'fail');
  }
}

$('saveBtn').addEventListener('click', () => saveConfig().catch(err => setStatus(err.message, 'fail')));
$('themeBtn').addEventListener('click', () => toggleTheme());
$('browseReportDirBtn').addEventListener('click', () => browseReportDir());
$('runBtn').addEventListener('click', () => runNow());
$('runMirrorBtn').addEventListener('click', () => runNow());
$('reportMirrorBtn').addEventListener('click', () => exportDailyReport());
$('clearBtn').addEventListener('click', () => clearHistory());
$('historyToggleBtn').addEventListener('click', () => {
  const hidden = $('messages').classList.toggle('is-hidden');
  $('historyToggleBtn').innerHTML = `<span class="btn-icon">▤</span>${hidden ? '显示日志' : '隐藏日志'}⌄`;
});
$('chromeBtn').addEventListener('click', () => loadChromeGuilds());
$('resolveGuildBtn').addEventListener('click', () => resolveGuildNames());
$('presetBtn').addEventListener('click', () => fillTencentPreset());
$('reportEnabled').addEventListener('change', () => renderReports(currentReports));
$('reportOutputDir').addEventListener('input', () => renderReports(currentReports));
$('body').addEventListener('input', () => updateTargetInfo());
$('channel').addEventListener('input', () => updateTargetInfo());
$('cookieBtn').addEventListener('click', () => {
  try {
    writeCookieToHeaders();
  } catch (err) {
    setStatus(err.message, 'fail');
  }
});
$('copyScriptBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('importScript').value);
    setStatus('已复制导入脚本。到 pd.qq.com 页面控制台粘贴执行。', 'ok');
  } catch {
    $('importScript').select();
    setStatus('无法自动复制，请手动复制导入脚本。', 'fail');
  }
});
applyTheme(localStorage.getItem('pd-theme') || 'light');
init();
