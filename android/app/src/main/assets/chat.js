/* ══════════════════════════════════════════════════════════
   API Radar — шторка «Чат»: площадка запросов + AI-чат
   Площадка: запросы по спеке, только по явному нажатию.
   AI-чат: работает через ключ, который вводит сам пользователь.
   ══════════════════════════════════════════════════════════ */
'use strict';

let cur = null, tab = 'play', msgs = [];

const PROVIDERS = {
  openai: {
    name: 'OpenAI', url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini',
    build: (k, m, hist) => ({
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + k },
      body: JSON.stringify({ model: m, messages: hist })
    }),
    read: j => (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || JSON.stringify(j)
  },
  anthropic: {
    name: 'Anthropic', url: 'https://api.anthropic.com/v1/messages', model: 'claude-sonnet-4-5',
    build: (k, m, hist) => ({
      headers: {
        'Content-Type': 'application/json', 'x-api-key': k,
        'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({ model: m, max_tokens: 1024, messages: hist.filter(x => x.role !== 'system') })
    }),
    read: j => (j.content && j.content[0] && j.content[0].text) || JSON.stringify(j)
  },
  gemini: {
    name: 'Google Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/models', model: 'gemini-2.0-flash',
    build: (k, m, hist) => ({
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(k)}`,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: hist.map(x => ({ role: x.role === 'assistant' ? 'model' : 'user', parts: [{ text: x.content }] })) })
    }),
    read: j => (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0].text) || JSON.stringify(j)
  },
  openrouter: {
    name: 'OpenRouter', url: 'https://openrouter.ai/api/v1/chat/completions', model: 'openai/gpt-4o-mini',
    build: (k, m, hist) => ({
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + k, 'HTTP-Referer': location.origin, 'X-Title': 'API Radar' },
      body: JSON.stringify({ model: m, messages: hist })
    }),
    read: j => (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || JSON.stringify(j)
  },
  custom: {
    name: 'Свой (OpenAI-совместимый)', url: '', model: '',
    build: (k, m, hist, u) => ({
      url: u, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + k },
      body: JSON.stringify({ model: m, messages: hist })
    }),
    read: j => (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || JSON.stringify(j)
  }
};

function pretty(txt) {
  try {
    let s = JSON.stringify(JSON.parse(txt), null, 2);
    s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return s.replace(/("(?:\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false)\b|\bnull\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, m => {
      let c = '#c9a56a';
      if (/^"/.test(m)) c = /:$/.test(m) ? '#8fb3d9' : '#8fb79b';
      else if (/^(true|false)$/.test(m)) c = '#b58fc0';
      else if (/^null$/.test(m)) c = '#6a7284';
      return `<span style="color:${c}">${m}</span>`;
    });
  } catch { return esc(txt).slice(0, 20000); }
}

/* ── Открыть шторку ───────────────────────────────── */
function openChat(c) {
  cur = c; tab = 'play'; msgs = [];
  $('#chatTitle').textContent = c.title;
  $('#chatSub').textContent = [c.provider, c.verified ? (c.ok ? `живой, ${c.latency} мс` : 'недоступен') : 'не проверен'].join(' · ');
  $('#chatTabs').querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.t === 'play'));
  $('#bdChat').hidden = false;
  renderTab();
}

$('#chatClose').onclick = () => { $('#bdChat').hidden = true; cur = null; };
$('#bdChat').addEventListener('click', e => { if (e.target.id === 'bdChat') { $('#bdChat').hidden = true; cur = null; } });
$('#chatTabs').onclick = e => {
  const t = e.target.closest('.tab'); if (!t) return;
  tab = t.dataset.t;
  $('#chatTabs').querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x === t));
  renderTab();
};

function renderTab() { tab === 'play' ? renderPlay() : renderAI(); }

/* ── Площадка ─────────────────────────────────────── */
function renderPlay() {
  const c = cur; if (!c) return;
  const base = (c.servers && c.servers[0]) || '';
  const ops = c.sampleOps || [];
  const opts = ops.length
    ? ops.map((o, i) => `<option value="${i}">${o.m} ${esc(o.p)}${o.s ? ' — ' + esc(o.s.slice(0, 46)) : ''}</option>`).join('')
    : '';
  const authNote = c.verified
    ? ((c.security || []).length
      ? `Спека заявляет авторизацию: <b>${esc((c.security || []).join(', '))}</b>. Свой ключ добавь вручную в заголовки.`
      : 'Спека не требует авторизации — можно пробовать сразу.')
    : 'API ещё не проверен — замини его сначала, тогда появятся эндпоинты.';

  $('#chatBody').innerHTML = `
    <p class="hint">${authNote}</p>
    ${opts ? `<div class="f"><label>Эндпоинт из спеки</label>
      <select id="pgOp"><option value="">— выбрать —</option>${opts}</select></div>` : ''}
    <div class="f2">
      <div class="f"><label>Метод</label><select id="pgM">
        <option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option>
      </select></div>
      <div class="f"><label>Путь</label><input id="pgP" placeholder="/v1/resource" value="${esc(ops[0] ? ops[0].p : '')}"></div>
    </div>
    <div class="f"><label>Базовый URL</label><input id="pgB" value="${esc(base)}" placeholder="https://api.example.com"></div>
    <div class="f"><label>Заголовки (по строке: Name: value)</label>
      <textarea id="pgH" placeholder="Authorization: Bearer ВАШ_КЛЮЧ"></textarea></div>
    <div class="f"><label>Тело запроса (JSON)</label><textarea id="pgBody" placeholder='{"key":"value"}'></textarea></div>
    <button class="send" id="pgSend">Отправить запрос</button>
    <div id="pgOut"></div>
    <p class="hint" style="margin-top:14px">Запрос уходит напрямую из браузера. Если видишь ошибку CORS — сервер API не разрешает
    обращения из браузера; это ограничение площадки, а не самого API. Не-GET запросы требуют подтверждения.</p>`;

  const pOp = $('#pgOp');
  if (pOp) pOp.onchange = () => {
    const o = ops[+pOp.value]; if (!o) return;
    $('#pgM').value = o.m; $('#pgP').value = o.p;
  };
  $('#pgSend').onclick = sendPlay;
}

async function sendPlay() {
  const m = $('#pgM').value, p = $('#pgP').value.trim();
  const base = ($('#pgB').value || '').trim().replace(/\/+$/, '');
  const out = $('#pgOut');
  if (!base) { toast('Укажи базовый URL'); return; }

  if (m !== 'GET') {
    if (!confirm(`${m} может изменить данные на сервере.\n\nОтправлять запрос к ${base}${p}?`)) return;
  }

  const headers = {};
  for (const line of ($('#pgH').value || '').split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  let body;
  const bt = ($('#pgBody').value || '').trim();
  if (bt && m !== 'GET') { headers['Content-Type'] ||= 'application/json'; body = bt; }

  const url = base + (p.startsWith('/') ? p : '/' + p);
  out.innerHTML = `<div class="resp"><div class="resp-h">отправляю ${m}…</div></div>`;
  log(`площадка: ${m} ${url}`, 'hi');

  const t0 = performance.now();
  try {
    const r = await fetch(url, { method: m, headers, body, redirect: 'follow' });
    const txt = await r.text();
    const dt = Math.round(performance.now() - t0);
    const cls = r.status < 300 ? 'r2' : r.status < 500 ? 'r4' : 'r5';
    out.innerHTML = `<div class="resp">
      <div class="resp-h"><span class="${cls}" style="padding:2px 7px;border-radius:5px">${r.status} ${esc(r.statusText)}</span>
        <span>${dt} мс</span><span>${(txt.length / 1024).toFixed(1)} КБ</span>
        <span style="margin-left:auto;cursor:pointer" id="cpResp">копировать</span></div>
      <pre>${pretty(txt)}</pre></div>`;
    const cp = $('#cpResp');
    if (cp) cp.onclick = () => { navigator.clipboard?.writeText(txt); toast('Ответ скопирован'); };
    log(`площадка: ответ ${r.status} за ${dt} мс`, r.ok ? 'ok' : 'wn');
  } catch (e) {
    out.innerHTML = `<div class="resp"><div class="resp-h"><span class="r5" style="padding:2px 7px;border-radius:5px">сбой</span></div>
      <pre>${esc(String(e.message || e))}\n\nЕсли это CORS — сервер не принимает запросы из браузера.</pre></div>`;
    log('площадка: ' + (e.message || e), 'er');
  }
}

/* ── AI-чат ───────────────────────────────────────── */
function renderAI() {
  const sel = Object.keys(PROVIDERS).map(k =>
    `<option value="${k}">${PROVIDERS[k].name}</option>`).join('');
  $('#chatBody').innerHTML = `
    <p class="hint">Чат работает на <b>твоём</b> ключе: он сохраняется только локально, в этом приложении,
    и уходит напрямую выбранному провайдеру. Никаких чужих ключей здесь нет и не может быть.</p>
    <div class="f"><label>Провайдер</label><select id="aiP">${sel}</select></div>
    <div class="f"><label>Модель</label><input id="aiM" value="gpt-4o-mini"></div>
    <div class="f"><label>Ключ API</label><input id="aiK" type="password" placeholder="sk-…" autocomplete="off"></div>
    <div id="aiCustom" hidden><div class="f"><label>URL эндпоинта</label><input id="aiU" placeholder="https://…/v1/chat/completions"></div></div>
    <p class="hint warn">Ключ хранится в локальном хранилище приложения. Удалить — кнопка ниже.</p>
    <div style="margin-bottom:12px"><button class="btn-ghost" id="aiForget">Забыть ключ</button></div>
    <div class="msgs" id="aiMsgs"></div>
    <div class="composer">
      <textarea id="aiIn" rows="1" placeholder="сообщение…"></textarea>
      <button id="aiSend" aria-label="Отправить">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/></svg>
      </button>
    </div>`;

  const p = $('#aiP'), KEY = k => 'ar_key_' + k;
  const loadKey = () => { $('#aiK').value = localStorage.getItem(KEY(p.value)) || ''; };
  const syncModel = () => { $('#aiM').value = PROVIDERS[p.value].model || ''; $('#aiCustom').hidden = p.value !== 'custom'; };

  p.onchange = () => { syncModel(); loadKey(); };
  p.value = localStorage.getItem('ar_provider') || 'openai';
  syncModel(); loadKey();
  $('#aiK').oninput = () => {
    localStorage.setItem('ar_provider', p.value);
    if ($('#aiK').value) localStorage.setItem(KEY(p.value), $('#aiK').value);
  };
  $('#aiForget').onclick = () => {
    Object.keys(PROVIDERS).forEach(k => localStorage.removeItem(KEY(k)));
    $('#aiK').value = ''; toast('Ключ удалён');
  };
  $('#aiIn').oninput = e => { e.target.style.height = 'auto'; e.target.style.height = Math.min(110, e.target.scrollHeight) + 'px'; };
  $('#aiSend').onclick = sendAI;
  $('#aiIn').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAI(); }
  });
  drawMsgs();
}

function drawMsgs() {
  const box = $('#aiMsgs'); if (!box) return;
  if (!msgs.length) {
    box.innerHTML = `<div class="msg sys">Пусто. Вставь свой ключ и напиши что-нибудь —
      модель ответит напрямую через провайдера.</div>`;
    return;
  }
  box.innerHTML = msgs.map(m => `<div class="msg ${m.role === 'user' ? 'me' : 'ai'}">${esc(m.content)}</div>`).join('');
  box.scrollTop = box.scrollHeight;
}

async function sendAI() {
  const p = $('#aiP').value, key = ($('#aiK').value || '').trim();
  const model = ($('#aiM').value || '').trim();
  const txt = ($('#aiIn').value || '').trim();
  if (!txt) return;
  if (!key) { toast('Сначала вставь свой ключ'); return; }
  if (!model) { toast('Укажи модель'); return; }

  const P = PROVIDERS[p];
  msgs.push({ role: 'user', content: txt });
  $('#aiIn').value = ''; $('#aiIn').style.height = 'auto';
  drawMsgs();

  const btn = $('#aiSend'); btn.disabled = true;
  msgs.push({ role: 'assistant', content: '…' });
  drawMsgs();

  try {
    const cfg = P.build(key, model, msgs.filter(m => m.content !== '…'), $('#aiU') ? $('#aiU').value : '');
    const r = await fetch(cfg.url || P.url, { method: 'POST', headers: cfg.headers, body: cfg.body });
    const j = await r.json();
    if (!r.ok) throw new Error((j.error && (j.error.message || JSON.stringify(j.error))) || ('HTTP ' + r.status));
    msgs[msgs.length - 1] = { role: 'assistant', content: P.read(j) };
    log(`AI-чат: ответ получен (${p}, ${model})`, 'ok');
  } catch (e) {
    msgs[msgs.length - 1] = { role: 'assistant', content: 'Ошибка: ' + (e.message || e) };
    log('AI-чат: ' + (e.message || e), 'er');
  }
  btn.disabled = false;
  drawMsgs();
}
