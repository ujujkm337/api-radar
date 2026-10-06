/* ══════════════════════════════════════════════════════════
   API Radar — ядро: каталог, проверка, скоринг, рендер
   Источник: APIs.guru (открытый каталог OpenAPI, CORS *)
   ══════════════════════════════════════════════════════════ */
'use strict';

const CATALOG = 'https://api.apis.guru/v2/list.json';
const CONC = 8;          // параллельных проверок
const SPEC_TIMEOUT = 20000;
const PAGE = 60;         // сколько строк рендерить за раз

const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ── Состояние ────────────────────────────────────── */
const S = {
  catalog: [],
  target: 100,
  scanning: false,
  stop: false,
  q: '',
  cat: 'all',
  sort: 'score',
  limit: PAGE,
  open: new Set(),
  done: 0, ok: 0, lat: [],
  batch: 0,
  prevRank: new Map(),
  W: { fresh: 15, docs: 20, modern: 15, surface: 15, quality: 15, live: 10, open: 10 }
};
const DEF_W = { ...S.W };

/* ── Логи ─────────────────────────────────────────── */
let logN = 0;
function log(msg, kind) {
  const el = $('#log');
  if (!el) return;
  const d = document.createElement('div');
  if (kind) d.className = kind;
  const t = new Date().toLocaleTimeString('ru-RU', { hour12: false });
  d.innerHTML = `<span class="t">${t}</span><span class="m">${esc(msg)}</span>`;
  el.appendChild(d);
  while (el.children.length > 400) el.removeChild(el.firstChild);
  if (logN < 400) logN++;
  $('#logCnt').textContent = logN;
  el.scrollTop = el.scrollHeight;
}

let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.hidden = true; }, 2600);
}

/* ── Хранилище (кеш результатов между запусками) ──── */
const DB = (() => {
  let p = null;
  const open = () => (p ||= new Promise(r => {
    try {
      const q = indexedDB.open('apiradar', 1);
      q.onupgradeneeded = () => q.result.createObjectStore('kv');
      q.onsuccess = () => r(q.result);
      q.onerror = () => r(null);
    } catch { r(null); }
  }));
  const set = async (k, v) => {
    const d = await open(); if (!d) return;
    try { await new Promise(r => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = t.onerror = () => r(); }); } catch {}
  };
  const get = async k => {
    const d = await open(); if (!d) return null;
    try { return await new Promise(r => { const t = d.transaction('kv', 'readonly'); const q = t.objectStore('kv').get(k); q.onsuccess = () => r(q.result); q.onerror = () => r(null); }); } catch { return null; }
  };
  return { get, set };
})();

async function save() {
  const rows = S.catalog.filter(c => c.verified).map(c => ({
    id: c.id, ok: c.ok, latency: c.latency, bytes: c.bytes, ops: c.ops,
    paths: c.paths, servers: c.servers, security: c.security, schemas: c.schemas,
    hasExamples: c.hasExamples, respCodes: c.respCodes, params: c.describedParams,
    sampleOps: c.sampleOps, err: c.err
  }));
  await DB.set('last', { rows, ts: Date.now() });
}

async function restore() {
  const d = await DB.get('last');
  if (!d || !d.rows || !S.catalog.length) return 0;
  const m = new Map(d.rows.map(r => [r.id, r]));
  let n = 0;
  for (const c of S.catalog) {
    const r = m.get(c.id); if (!r) continue;
    Object.assign(c, r, { verified: true });
    c.score = total(c); n++;
  }
  S.done = n; S.ok = S.catalog.filter(c => c.ok).length;
  S.lat = S.catalog.filter(c => c.ok && c.latency).map(c => c.latency);
  return n;
}

/* ── Загрузка каталога ────────────────────────────── */
async function loadCatalog() {
  log('загружаю каталог APIs.guru…', 'hi');
  const t0 = performance.now();
  let res;
  try {
    res = await fetch(CATALOG, { cache: 'no-cache' });
  } catch (e) {
    throw new Error('нет сети: ' + (e.message || e));
  }
  if (!res.ok) throw new Error('каталог недоступен: HTTP ' + res.status);
  const raw = await res.json();
  const dt = Math.round(performance.now() - t0);

  const out = [];
  for (const [prov, entry] of Object.entries(raw)) {
    const pv = entry.preferred;
    const v = (pv && entry.versions[pv]) || Object.values(entry.versions)[0];
    if (!v) continue;
    const i = v.info || {};
    const l = i.license || {};
    out.push({
      id: prov,
      provider: i['x-providerName'] || prov,
      service: i['x-serviceName'] || '',
      title: i.title || prov,
      desc: (i.description || '').replace(/\s+/g, ' ').trim(),
      cats: i['x-apisguru-categories'] || [],
      logo: (i['x-logo'] || {}).url || '',
      specUrl: v.swaggerUrl,
      docsUrl: (v.externalDocs || i.externalDocs || {}).url || (i.contact || {}).url || '',
      contact: i.contact || null,
      tos: i.termsOfService || '',
      license: l.name || (l.url ? 'лицензия' : ''),
      ver: v.openapiVer || '',
      added: entry.added || v.added,
      updated: v.updated || entry.added,
      unofficial: !!i['x-unofficialSpec'],
      score: 0
    });
  }
  out.forEach(c => { c.score = total(c); });
  S.catalog = out;
  log(`каталог получен: ${out.length} API за ${dt} мс`, 'ok');
  return out.length;
}

/* ── Скоринг ──────────────────────────────────────── */
const MODERN = { '3.1.1': 100, '3.1.0': 100, '3.0.3': 92, '3.0.2': 88, '3.0.1': 88, '3.0.0': 82, '2.0': 46, '1.2': 25 };

function subs(c) {
  // свежесть
  const upd = Date.parse(c.updated) || Date.parse(c.added) || 0;
  const d = (Date.now() - upd) / 864e5;
  const fresh = d < 90 ? 100 : d < 270 ? 88 : d < 540 ? 72 : d < 900 ? 55 : d < 1460 ? 35 : d < 2190 ? 20 : 10;

  // документация
  const dl = (c.desc || '').length;
  let docs = dl > 600 ? 40 : dl > 250 ? 32 : dl > 120 ? 24 : dl > 50 ? 15 : dl > 10 ? 8 : 0;
  if (c.docsUrl) docs += 22;
  if (c.contact && (c.contact.email || c.contact.url)) docs += 16;
  if (c.tos) docs += 12;
  if (c.license) docs += 10;
  docs = Math.min(100, docs);

  // современность спеки
  const modern = MODERN[c.ver] ?? 50;

  // охват
  const o = c.ops;
  const surface = o == null ? 45 : o >= 200 ? 100 : o >= 80 ? 88 : o >= 40 ? 76 : o >= 20 ? 64 : o >= 10 ? 52 : o >= 5 ? 40 : o >= 2 ? 28 : 15;

  // качество спеки
  let quality = 40;
  if (c.verified) {
    quality = 0;
    if (c.servers && c.servers.length) quality += 25;
    if (c.security && c.security.length) quality += 20;
    if (c.hasExamples) quality += 20;
    if (c.schemas > 0) quality += 15;
    if ((c.respCodes || []).some(x => x >= 400)) quality += 10;
    if (c.params > 0.4) quality += 10;
    quality = Math.min(100, quality);
  }

  // живость + отклик
  let live = 45;
  if (c.verified) {
    if (!c.ok) live = 0;
    else { const t = c.latency; live = t < 250 ? 100 : t < 600 ? 88 : t < 1200 ? 72 : t < 2500 ? 55 : t < 5000 ? 35 : 18; }
  }

  // доступность (насколько просто начать)
  let open = 60;
  if (c.verified) {
    const k = (c.security || []).join(' ').toLowerCase();
    if (!k) open = 95;
    else if (/oauth2|openidconnect/.test(k)) open = 45;
    else if (/apikey|http/.test(k)) open = 78;
  }
  if (c.cats.includes('open_data')) open = Math.min(100, open + 8);
  if (c.unofficial) open = Math.max(0, open - 25);

  return { fresh, docs, modern, surface, quality, live, open };
}

function total(c) {
  const s = subs(c), W = S.W;
  let sum = 0, wsum = 0;
  for (const k in W) { sum += s[k] * W[k]; wsum += W[k]; }
  let t = wsum ? sum / wsum : 0;
  if (c.unofficial) t *= 0.85;
  return Math.round(t * 10) / 10;
}

/* ── Разбор спеки ─────────────────────────────────── */
const METH = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

function analyze(spec) {
  const paths = spec.paths || {};
  const pKeys = Object.keys(paths);
  let ops = 0, hasEx = false, params = 0, pDesc = 0;
  const codes = new Set();
  const sample = [];
  const v3 = typeof spec.openapi === 'string';

  for (const p of pKeys) {
    const item = paths[p] || {};
    for (const m of METH) {
      const op = item[m];
      if (!op) continue;
      ops++;
      const rs = op.responses || {};
      for (const code in rs) {
        const n = parseInt(code, 10);
        if (!isNaN(n)) codes.add(n);
        const rc = rs[code] || {};
        if (rc.examples) hasEx = true;
        const cont = v3 ? rc.content : (rc.schema ? { x: { schema: rc.schema } } : null);
        if (cont && !hasEx) {
          for (const ct in cont) if (cont[ct].example || cont[ct].examples) { hasEx = true; break; }
        }
      }
      for (const pr of (op.parameters || (item.parameters || []))) {
        params++; if (pr.description) pDesc++;
      }
      if (sample.length < 40) sample.push({ m: m.toUpperCase(), p, s: (op.summary || op.operationId || '').slice(0, 90) });
    }
  }

  let servers = [];
  if (Array.isArray(spec.servers) && spec.servers.length) servers = spec.servers.map(s => s.url);
  else if (spec.host) servers = [(spec.schemes && spec.schemes[0] || 'https') + '://' + spec.host + (spec.basePath || '')];

  const sd = spec.securityDefinitions || (spec.components && spec.components.securitySchemes) || {};
  const sec = [...new Set(Object.values(sd).map(s => s && s.type).filter(Boolean))];
  const schemas = Object.keys(spec.definitions || (spec.components && spec.components.schemas) || {}).length;

  return {
    ops, paths: pKeys.length, servers, security: sec, schemas,
    hasExamples: hasEx, respCodes: [...codes],
    params: params ? pDesc / params : 0,
    sampleOps: sample
  };
}

/* ── Проверка одного кандидата ────────────────────── */
async function verify(c) {
  const t0 = performance.now();
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), SPEC_TIMEOUT);
    const r = await fetch(c.specUrl, { signal: ctl.signal });
    clearTimeout(to);
    const txt = await r.text();
    const lat = Math.round(performance.now() - t0);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const spec = JSON.parse(txt);
    Object.assign(c, analyze(spec), { verified: true, ok: true, latency: lat, bytes: txt.length, err: null });
    log(`✓ ${c.title} — ${c.ops} оп., ${c.paths} путей, ${lat} мс, ${(txt.length / 1024).toFixed(0)} КБ`, 'ok');
  } catch (e) {
    const lat = Math.round(performance.now() - t0);
    Object.assign(c, { verified: true, ok: false, latency: lat, err: String((e && e.message) || e).slice(0, 120) });
    log(`✕ ${c.title} — ${c.err}`, 'er');
  }
  c.score = total(c);
  S.done++;
  if (c.ok) { S.ok++; S.lat.push(c.latency); }
  bumpStats();
  schedRender();
}

function pool(items, n, fn) {
  let i = 0;
  const rs = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      if (S.stop) return;
      await fn(items[i++]);
    }
  });
  return Promise.all(rs);
}

/* ── Сканирование ─────────────────────────────────── */
async function scan() {
  if (S.scanning) { S.stop = true; log('останавливаю…', 'wn'); return; }

  S.scanning = true; S.stop = false; S.batch++;
  const b = S.batch;
  syncBtn();

  try {
    if (!S.catalog.length) {
      await loadCatalog();
      const n = await restore();
      if (n) log(`восстановлено ${n} прошлых проверок из кеша`, 'ok');
      buildCats();
    }
    if (S.stop) throw 0;

    const pool0 = filtered();
    const n = S.target === 0 ? pool0.length : Math.min(S.target, pool0.length);
    const targets = pool0.slice().sort((a, x) => x.score - a.score).slice(0, n);
    log(`к проверке: ${targets.length} из ${pool0.length}${S.q || S.cat !== 'all' ? ' (с фильтром)' : ''}`, 'hi');
    if (S.target === 0 && targets.length > 400) log(`внимание: полная проверка — это ≈${(targets.length * 56 / 1024).toFixed(0)} МБ трафика`, 'wn');

    const t0 = performance.now();
    const iv = setInterval(() => {
      const pct = targets.length ? Math.round(S.done / targets.length * 100) : 0;
      $('#progBar').style.width = Math.min(100, pct) + '%';
      $('#progPct').textContent = pct + '%';
      $('#progTxt').textContent = S.stop ? 'остановлено' : `проверено ${S.done} из ${targets.length}`;
    }, 200);

    await pool(targets, CONC, verify);
    clearInterval(iv);

    if (S.stop) { log(`остановлено на ${S.done}`, 'wn'); }
    else {
      const sec = ((performance.now() - t0) / 1000).toFixed(1);
      log(`готово: ${S.done} проверено, ${S.ok} живых за ${sec} с`, 'ok');
      const best = S.catalog.filter(x => x.ok).sort((a, x) => x.score - a.score)[0];
      if (best) log(`лучший результат: ${best.title} — ${best.score}`, 'hi');
    }
    $('#progBar').style.width = '100%';
    save();
  } catch (e) {
    if (e !== 0) { log('ошибка: ' + ((e && e.message) || e), 'er'); toast('Не получилось: ' + ((e && e.message) || e)); }
  }

  S.scanning = false; S.stop = false;
  syncBtn();
  render();
}

function syncBtn() {
  const b = $('#scanBtn');
  b.classList.toggle('busy', S.scanning);
  $('#scanLabel').textContent = S.scanning ? 'Остановить' : (S.catalog.length ? 'Проверить ещё' : 'Найти и проверить');
}

/* ── Фильтры ──────────────────────────────────────── */
function filtered() {
  const q = S.q.trim().toLowerCase();
  return S.catalog.filter(c => {
    if (S.cat !== 'all' && !c.cats.includes(S.cat)) return false;
    if (!q) return true;
    return (c.title + ' ' + c.provider + ' ' + c.service + ' ' + c.desc).toLowerCase().includes(q);
  });
}

const SORTS = {
  score: (a, b) => (b.score - a.score) || a.title.localeCompare(b.title),
  fresh: (a, b) => (Date.parse(b.updated) || 0) - (Date.parse(a.updated) || 0),
  ops: (a, b) => (b.ops || 0) - (a.ops || 0),
  lat: (a, b) => {
    const x = a.ok ? a.latency : 1e9, y = b.ok ? b.latency : 1e9;
    return (a.verified ? 0 : 1) - (b.verified ? 0 : 1) || x - y;
  },
  name: (a, b) => a.title.localeCompare(b.title)
};

/* ── Рендер ───────────────────────────────────────── */
let rAF = null, lastR = 0;
function schedRender() {
  if (rAF) return;
  rAF = requestAnimationFrame(() => {
    rAF = null;
    if (performance.now() - lastR > 220) { lastR = performance.now(); render(); }
  });
}

const col = v => v >= 72 ? '#7fae8b' : v >= 56 ? '#c6a662' : '#c08585';
const fmtD = s => { const d = new Date(s); return isNaN(d) ? '—' : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: '2-digit' }); };

function render() {
  const all = filtered().sort(SORTS[S.sort]);
  const slice = all.slice(0, S.limit);

  $('#empty').hidden = all.length > 0;
  $('#toolbar').hidden = S.catalog.length === 0;
  const mb = $('#moreBtn');
  mb.hidden = all.length <= S.limit;
  mb.textContent = `Показать ещё (${all.length - S.limit})`;

  const html = slice.map((c, i) => {
    const v = c.score;
    const open = S.open.has(c.id);
    return `<article class="row${c.verified ? ' verified' : ''}${open ? ' open' : ''}" data-id="${esc(c.id)}">
      <button class="row-h" data-act="toggle">
        <span class="rank">${i + 1}</span>
        <span class="rmain">
          <span class="rtitle">${esc(c.title)}</span>
          <span class="rsub">
            <span>${esc(c.provider)}</span>
            ${c.cats[0] ? `<span class="dot"></span><span>${esc(c.cats[0])}</span>` : ''}
            ${c.verified ? `<span class="dot"></span><span>${c.ok ? '✓ живой' : '✕ недоступен'}</span>` : '<span class="dot"></span><span>в очереди</span>'}
          </span>
        </span>
        <span class="rside">
          <span class="score" style="color:${col(v)}">${c.verified ? '' : '~'}${v.toFixed(0)}</span>
          <span class="sbar"><i style="width:${v}%;background:${col(v)}"></i></span>
        </span>
        <span class="chevB">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
        </span>
      </button>
      ${open ? detail(c) : ''}
    </article>`;
  }).join('');

  $('#list').innerHTML = html;
}

function detail(c) {
  const s = subs(c);
  const LBL = { fresh: 'Свежесть', docs: 'Документация', modern: 'Версия спеки', surface: 'Охват', quality: 'Качество', live: 'Отклик', open: 'Доступность' };
  const WHY = {
    fresh: 'как давно обновлялась спецификация',
    docs: 'описание, ссылки, контакты, лицензия',
    modern: 'OpenAPI 3.x против устаревшего 2.0',
    surface: 'сколько операций покрывает API',
    quality: 'примеры, схемы, коды ошибок, серверы',
    live: 'спека отдаётся и как быстро',
    open: 'нужен ли ключ и насколько сложна авторизация'
  };
  const brk = Object.keys(S.W).map(k => `
    <div class="brk-i">
      <span title="${esc(WHY[k])}">${LBL[k]}</span>
      <span class="brk-bar"><i style="width:${s[k]}%;background:${col(s[k])}"></i></span>
      <b>${Math.round(s[k])}</b>
    </div>`).join('');

  const meta = [
    ['провайдер', c.provider], ['спека', c.ver || '—'],
    ['обновлено', fmtD(c.updated)], ['добавлено', fmtD(c.added)],
    ['операций', c.verified ? (c.ops ?? 0) : '—'], ['путей', c.verified ? (c.paths ?? 0) : '—'],
    ['отклик', c.verified && c.ok ? c.latency + ' мс' : (c.verified ? '—' : '—')],
    ['размер', c.bytes ? (c.bytes / 1024).toFixed(0) + ' КБ' : '—'],
    ['авторизация', c.verified ? ((c.security || []).join(', ') || 'не требуется') : '—'],
    ['лицензия', c.license || '—']
  ].map(([k, v]) => `<div class="mi"><em>${esc(k)}</em><b>${esc(v)}</b></div>`).join('');

  const eps = (c.sampleOps || []).slice(0, 12).map(o =>
    `<div class="ep"><span class="mth ${o.m === 'DELETE' ? 'del' : o.m === 'GET' ? 'get' : o.m === 'POST' ? 'post' : ''}">${o.m}</span><span>${esc(o.p)}</span></div>`).join('');

  const long = (c.desc || '').length > 190;

  return `<div class="det">
    ${c.desc ? `<p class="desc${long ? ' short' : ''}" id="d_${esc(c.id)}">${esc(c.desc)}</p>
      ${long ? `<button class="more" data-act="more">показать полностью</button>` : ''}` : '<p class="desc">Описание отсутствует в каталоге.</p>'}

    <div class="brk">${brk}</div>
    <div class="meta">${meta}</div>

    ${(c.servers && c.servers.length) ? `<div class="eps"><h4>Сервер</h4>
      ${c.servers.slice(0, 3).map(u => `<div class="ep"><span>${esc(u)}</span></div>`).join('')}</div>` : ''}

    ${eps ? `<div class="eps"><h4>Эндпоинты${(c.sampleOps || []).length > 12 ? ` <span style="color:var(--faint);text-transform:none;letter-spacing:0">· первые 12 из ${(c.sampleOps || []).length}</span>` : ''}</h4>${eps}</div>` : ''}

    ${c.err ? `<p class="err">${esc(c.err)}</p>` : ''}

    <div class="acts">
      <button class="btn-main" data-act="chat">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-8 8H8l-5 3 1.5-4.5A8 8 0 1 1 21 12z"/></svg>
        Чат
      </button>
      ${c.docsUrl ? `<a class="ico2" href="${esc(c.docsUrl)}" target="_blank" rel="noopener" aria-label="Документация">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg></a>` : ''}
      <button class="ico2" data-act="spec" aria-label="Открыть спеку">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
      </button>
    </div>
  </div>`;
}

/* ── Сводка ───────────────────────────────────────── */
function bumpStats() {
  $('#sTotal').textContent = S.catalog.length;
  $('#sDone').textContent = S.done;
  $('#sOk').textContent = S.ok;
  $('#sLat').textContent = S.lat.length ? Math.round(S.lat.reduce((a, b) => a + b, 0) / S.lat.length) + ' мс' : '—';
}

/* ── Категории ────────────────────────────────────── */
function buildCats() {
  const cnt = new Map();
  for (const c of S.catalog) for (const k of c.cats) cnt.set(k, (cnt.get(k) || 0) + 1);
  const top = [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 22);
  $('#catChips').innerHTML = `<button class="chip${S.cat === 'all' ? ' on' : ''}" data-c="all">все ${S.catalog.length}</button>` +
    top.map(([k, n]) => `<button class="chip${S.cat === k ? ' on' : ''}" data-c="${esc(k)}">${esc(k)} ${n}</button>`).join('');
}

/* ── События ──────────────────────────────────────── */
function bind() {
  $('#scanBtn').onclick = scan;

  $('#countChips').onclick = e => {
    const b = e.target.closest('.chip'); if (!b) return;
    [...$('#countChips').children].forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    S.target = +b.dataset.n;
  };

  $('#catChips').onclick = e => {
    const b = e.target.closest('.chip'); if (!b) return;
    S.cat = b.dataset.c;
    [...$('#catChips').children].forEach(x => x.classList.toggle('on', x === b));
    S.limit = PAGE; render();
  };

  let qt;
  $('#q').oninput = e => {
    $('#qClear').hidden = !e.target.value;
    clearTimeout(qt);
    qt = setTimeout(() => { S.q = e.target.value; S.limit = PAGE; render(); }, 160);
  };
  $('#qClear').onclick = () => { $('#q').value = ''; $('#qClear').hidden = true; S.q = ''; S.limit = PAGE; render(); };
  $('#sort').onchange = e => { S.sort = e.target.value; render(); };
  $('#moreBtn').onclick = () => { S.limit += PAGE; render(); };

  $('#list').addEventListener('click', e => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const row = e.target.closest('.row'); if (!row) return;
    const id = row.dataset.id;
    const c = S.catalog.find(x => x.id === id);
    const act = btn.dataset.act;

    if (act === 'toggle') {
      if (S.open.has(id)) S.open.delete(id); else S.open.add(id);
      row.classList.toggle('open');
      const det = row.querySelector('.det');
      if (det) det.remove();
      else row.insertAdjacentHTML('beforeend', detail(c));
      return;
    }
    if (act === 'more') {
      const p = row.querySelector('.desc');
      p.classList.remove('short'); btn.remove(); return;
    }
    if (act === 'chat') { openChat(c); return; }
    if (act === 'spec') { window.open(c.specUrl, '_blank', 'noopener'); return; }
  });

  const lw = $('#logHead');
  lw.onclick = () => {
    const on = lw.getAttribute('aria-expanded') === 'true';
    lw.setAttribute('aria-expanded', String(!on));
    $('.logwrap').classList.toggle('collapsed', on);
  };

  $('#wBtn').onclick = () => { $('#bdW').hidden = false; buildWeights(); };
  $('#wClose').onclick = () => { $('#bdW').hidden = true; };
  $('#bdW').addEventListener('click', e => { if (e.target.id === 'bdW') $('#bdW').hidden = true; });
  $('#wReset').onclick = () => { S.W = { ...DEF_W }; buildWeights(); recompute(); };
  $('#wApply').onclick = () => { $('#bdW').hidden = true; recompute(); save(); toast('Веса применены'); };

  $('#expBtn').onclick = exportTSV;
  $('#statBtn').onclick = summary;
  $('#resetBtn').onclick = resetAll;

  document.addEventListener('keydown', e => { if (e.key === 'Escape') { $('#bdW').hidden = true; $('#bdChat').hidden = true; } });
}

/* ── Экспорт ──────────────────────────────────────── */
function copy(txt) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt); return true;
    }
  } catch (e) { /* нет доступа к буферу */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = txt;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select(); ta.setSelectionRange(0, txt.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) { return false; }
}

function exportTSV() {
  const rows = filtered().sort(SORTS[S.sort]).slice(0, 300);
  if (!rows.length) { toast('Нечего экспортировать'); return; }
  const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const head = ['#', 'Название', 'Провайдер', 'Категория', 'Скор', 'Проверен', 'Операций', 'Путей', 'Отклик мс', 'Авторизация', 'Лицензия', 'Спека'];
  const body = rows.map((c, i) => [
    i + 1, c.title, c.provider, c.cats[0] || '', c.score.toFixed(1),
    c.verified ? (c.ok ? 'да' : 'нет') : '—',
    c.ops ?? '', c.paths ?? '', (c.verified && c.ok) ? c.latency : '',
    (c.security || []).join(' ') || 'нет', c.license || '', c.specUrl
  ].map(q).join('\t')).join('\n');

  if (copy(head.map(q).join('\t') + '\n' + body)) toast(`${rows.length} строк скопировано — вставь в таблицу`);
  else toast('Буфер обмена недоступен');
  log(`экспорт: ${rows.length} строк в TSV`, 'hi');
}

/* ── Сводка ───────────────────────────────────────── */
function summary() {
  const v = S.catalog.filter(c => c.verified);
  const live = v.filter(c => c.ok);
  if (!v.length) { toast('Сначала запусти проверку'); return; }
  const avg = live.length ? Math.round(live.reduce((a, b) => a + b.score, 0) / live.length * 10) / 10 : 0;
  const lats = live.map(c => c.latency).sort((a, b) => a - b);
  const med = lats.length ? lats[Math.floor(lats.length / 2)] : 0;
  const noAuth = live.filter(c => !(c.security || []).length).length;
  const cats = new Map();
  for (const c of live) for (const k of c.cats) cats.set(k, (cats.get(k) || 0) + 1);
  const top = [...cats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k} ${n}`).join(', ');
  const bytes = live.reduce((a, c) => a + (c.bytes || 0), 0);

  log(`сводка: проверено ${v.length}, живых ${live.length} (${Math.round(live.length / v.length * 100)}%), средний скор ${avg}`, 'hi');
  log(`медиана отклика ${med} мс · без авторизации ${noAuth} · скачано ${(bytes / 1048576).toFixed(1)} МБ`, '');
  log(`топ категорий: ${top || '—'}`, '');
  toast(`живых ${live.length} · скор ${avg} · отклик ${med} мс · без ключа ${noAuth}`);
}

/* ── Сброс ────────────────────────────────────────── */
function resetAll() {
  if (!confirm('Сбросить все результаты проверки? Каталог останется, но придётся проверять заново.')) return;
  const K = ['verified', 'ok', 'ops', 'paths', 'servers', 'security', 'schemas', 'hasExamples', 'respCodes', 'params', 'sampleOps', 'bytes', 'latency', 'err'];
  S.catalog.forEach(c => { K.forEach(k => delete c[k]); c.score = total(c); });
  S.done = 0; S.ok = 0; S.lat = []; S.open.clear(); S.limit = PAGE;
  DB.set('last', null);
  bumpStats(); render();
  log('результаты сброшены', 'wn');
  toast('Сброшено');
}

function recompute() {
  S.catalog.forEach(c => { c.score = total(c); });
  render();
}

/* ── Веса ─────────────────────────────────────────── */
function buildWeights() {
  const LIST = [
    ['fresh', 'Свежесть', 'как давно обновлялась спецификация'],
    ['docs', 'Документация', 'описание, ссылки, контакты, лицензия'],
    ['modern', 'Версия спеки', 'OpenAPI 3.x против устаревшего 2.0'],
    ['surface', 'Охват', 'сколько операций покрывает API'],
    ['quality', 'Качество спеки', 'примеры, схемы, коды ошибок, серверы'],
    ['live', 'Отклик', 'спека отдаётся и как быстро'],
    ['open', 'Доступность', 'нужен ли ключ и сложность авторизации']
  ];
  $('#wBody').innerHTML = LIST.map(([k, n, d]) => `
    <div class="wi">
      <div class="wi-t"><span>${n}</span><b id="wv_${k}">${S.W[k]}</b></div>
      <input type="range" min="0" max="40" step="1" value="${S.W[k]}" data-k="${k}">
      <div class="wi-d">${d}</div>
    </div>`).join('') +
    `<div class="hint">Веса относительные — важна пропорция, не абсолют. Поставь 0 тому, что неважно.</div>`;

  $('#wBody').querySelectorAll('input[type=range]').forEach(r => {
    r.oninput = () => { S.W[r.dataset.k] = +r.value; $('#wv_' + r.dataset.k).textContent = r.value; };
  });
}

/* ── Старт ────────────────────────────────────────── */
window.AR = { S, log, toast, esc, render, total, subs, save };
bind();
bumpStats();
log('приложение готово. нажми «Найти и проверить»', 'hi');
if ('serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
