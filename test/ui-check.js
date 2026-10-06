const { chromium } = require('playwright-core');
const fs = require('fs');

const BASE = 'http://localhost:8080/';
const SHOT = '/home/user/api-radar/screens';
fs.mkdirSync(SHOT, { recursive: true });

let pass = 0, fail = 0;
const ok = (c, m, extra) => { c ? (pass++, console.log('  ✔ ' + m)) : (fail++, console.log('  ✖ ' + m + (extra ? '  → ' + JSON.stringify(extra) : ''))); };

const overflow = page => page.evaluate(() => {
  const d = document.documentElement;
  const w = d.clientWidth;
  const bad = [...document.querySelectorAll('body *')]
    .filter(e => {
      const r = e.getBoundingClientRect();
      if (!(r.width > 0 && (r.right > w + 1 || r.left < -1))) return false;
      // то, что лежит в собственном горизонтальном скроллере, страницу не расширяет
      let p = e.parentElement;
      while (p && p !== document.body) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') return false;
        p = p.parentElement;
      }
      return true;
    })
    .slice(0, 6)
    .map(e => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}.${String(e.className).split(' ')[0]} right=${Math.round(e.getBoundingClientRect().right)}`);
  return { scrollW: d.scrollWidth, clientW: w, bodyW: document.body.scrollWidth, bad };
});

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForTimeout(900);

  console.log('\n── БАГ 1: шторки не скрывались ─────────────────');
  const st = await page.evaluate(() => {
    const g = id => { const e = document.querySelector(id); return { hidden: e.hidden, display: getComputedStyle(e).display }; };
    return { w: g('#bdW'), chat: g('#bdChat'), toolbar: g('#toolbar'), qClear: g('#qClear'), toast: g('#toast') };
  });
  ok(st.w.display === 'none', 'шторка весов скрыта при запуске', st.w);
  ok(st.chat.display === 'none', 'шторка чата скрыта при запуске', st.chat);
  ok(st.toolbar.display === 'none', 'тулбар (экспорт/сводка/сброс) скрыт до данных', st.toolbar);
  ok(st.qClear.display === 'none', 'крестик очистки поиска скрыт', st.qClear);
  ok(st.toast.display === 'none', 'тост скрыт', st.toast);

  console.log('\n── БАГ 2: горизонтальная прокрутка ─────────────');
  let ov = await overflow(page);
  ok(ov.scrollW <= ov.clientW, `нет горизонтального выноса (${ov.scrollW} ≤ ${ov.clientW})`, ov);
  if (ov.bad.length) console.log('    виновники:', ov.bad);
  await page.screenshot({ path: SHOT + '/1-start.png' });

  console.log('\n── Шторка весов: полный цикл ───────────────────');
  await page.click('#wBtn');
  await page.waitForTimeout(300);
  let sliders = await page.locator('#wBody input[type=range]').count();
  ok(sliders === 7, `при открытии сразу видно ${sliders} ползунков (было 0)`, { sliders });
  ok(await page.locator('#bdW .sheet').isVisible(), 'шторка весов отрисована');
  await page.screenshot({ path: SHOT + '/2-weights.png' });

  await page.click('#wClose');
  await page.waitForTimeout(300);
  ok(await page.evaluate(() => getComputedStyle(document.querySelector('#bdW')).display) === 'none', 'крестик закрывает шторку');

  await page.click('#wBtn'); await page.waitForTimeout(250);
  await page.click('#wApply'); await page.waitForTimeout(350);
  const afterApply = await page.evaluate(() => ({
    disp: getComputedStyle(document.querySelector('#bdW')).display,
    toast: document.querySelector('#toast').hidden ? null : document.querySelector('#toast').textContent
  }));
  ok(afterApply.disp === 'none', '«Применить» закрывает шторку', afterApply);
  ok(!!afterApply.toast, `«Применить» показывает подтверждение: «${afterApply.toast}»`);

  console.log('\n── Сканирование 8 API ──────────────────────────');
  await page.evaluate(() => { AR.S.target = 8; });
  await page.click('#scanBtn');
  await page.waitForFunction(() => window.AR && AR.S.scanning === false && AR.S.done >= 8, null, { timeout: 90000 });
  await page.waitForTimeout(600);

  const res = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.row')];
    return {
      rows: rows.length,
      done: AR.S.done, ok: AR.S.ok, total: AR.S.catalog.length,
      top: rows.slice(0, 3).map(r => r.querySelector('.rtitle').textContent + ' — ' + r.querySelector('.score').textContent),
      logs: document.querySelectorAll('#log div').length,
      toolbarDisplay: getComputedStyle(document.querySelector('#toolbar')).display
    };
  });
  ok(res.rows > 0, `строк в списке: ${res.rows}`);
  ok(res.done >= 8, `проверено ${res.done}, живых ${res.ok}`);
  ok(res.logs > 5, `в логах ${res.logs} записей`);
  ok(res.toolbarDisplay !== 'none', 'тулбар появился после появления данных');
  console.log('    топ-3:', res.top.join(' | '));

  ov = await overflow(page);
  ok(ov.scrollW <= ov.clientW, `нет горизонтального выноса со списком (${ov.scrollW} ≤ ${ov.clientW})`, ov);
  if (ov.bad.length) console.log('    виновники:', ov.bad);
  await page.screenshot({ path: SHOT + '/3-results.png' });

  console.log('\n── Разворот карточки ───────────────────────────');
  await page.locator('.row .row-h').first().click();
  await page.waitForTimeout(400);
  const det = await page.evaluate(() => {
    const d = document.querySelector('.row.open .det');
    if (!d) return null;
    return {
      bars: d.querySelectorAll('.brk-i').length,
      meta: d.querySelectorAll('.mi').length,
      eps: d.querySelectorAll('.ep').length,
      hasChat: !!d.querySelector('[data-act=chat]'),
      desc: (d.querySelector('.desc') || {}).textContent?.slice(0, 60) || ''
    };
  });
  ok(!!det, 'карточка развернулась по стрелочке');
  ok(det && det.bars === 7, `разбивка скора: ${det && det.bars} критериев`);
  ok(det && det.meta >= 10, `метаданных: ${det && det.meta} полей`);
  ok(det && det.hasChat, 'кнопка «Чат» присутствует');
  if (det) console.log('    описание:', det.desc);

  ov = await overflow(page);
  ok(ov.scrollW <= ov.clientW, `нет горизонтального выноса в развёрнутом виде (${ov.scrollW} ≤ ${ov.clientW})`, ov);
  if (ov.bad.length) console.log('    виновники:', ov.bad);
  await page.screenshot({ path: SHOT + '/4-expanded.png', fullPage: false });

  console.log('\n── Кнопка «Чат» ────────────────────────────────');
  await page.click('.row.open [data-act=chat]');
  await page.waitForTimeout(400);
  const chat = await page.evaluate(() => {
    const bd = document.querySelector('#bdChat');
    return {
      display: getComputedStyle(bd).display,
      title: document.querySelector('#chatTitle').textContent,
      tabs: [...document.querySelectorAll('#chatTabs .tab')].map(t => t.textContent.trim()),
      play: !!document.querySelector('#pgSend'),
      ops: document.querySelectorAll('#pgOp option').length
    };
  });
  ok(chat.display !== 'none', 'шторка чата открылась');
  ok(chat.play, 'площадка запросов отрисована');
  ok(chat.ops > 1, `в селектор подгружено ${chat.ops - 1} эндпоинтов из спеки`);
  console.log('    заголовок:', chat.title, '| вкладки:', chat.tabs.join(' / '));

  await page.click('#chatTabs .tab:nth-child(2)');
  await page.waitForTimeout(300);
  ok(await page.locator('#aiK').count() === 1, 'вкладка AI-чат: поле для своего ключа есть');
  await page.screenshot({ path: SHOT + '/5-chat.png' });

  await page.click('#chatClose');
  await page.waitForTimeout(300);
  ok(await page.evaluate(() => getComputedStyle(document.querySelector('#bdChat')).display) === 'none', 'крестик закрывает чат');

  console.log('\n── Ошибки в консоли ────────────────────────────');
  ok(errors.length === 0, `JS-ошибок: ${errors.length}`, errors.slice(0, 5));

  console.log(`\n═══ ИТОГ: ${pass} прошло, ${fail} упало ═══\n`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('КРАШ:', e.message); process.exit(2); });
