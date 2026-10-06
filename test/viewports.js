const { chromium } = require('playwright-core');
(async () => {
  const b = await chromium.launch({ args: ['--no-sandbox','--disable-dev-shm-usage'] });
  let bad = 0;
  for (const w of [320, 360, 390, 412, 430, 768]) {
    const ctx = await b.newContext({ viewport: { width: w, height: 780 } });
    const p = await ctx.newPage();
    await p.goto('http://localhost:8080/', { waitUntil: 'load' });
    await p.waitForTimeout(500);
    await p.evaluate(() => { AR.S.target = 4; });
    await p.click('#scanBtn');
    await p.waitForFunction(() => AR.S.scanning === false && AR.S.done >= 4, null, { timeout: 90000 });
    await p.waitForTimeout(300);
    await p.locator('.row .row-h').first().click();
    await p.waitForTimeout(250);
    await p.click('.row.open [data-act=chat]');
    await p.waitForTimeout(250);
    const r = await p.evaluate(() => {
      const d = document.documentElement, W = d.clientWidth;
      const off = [...document.querySelectorAll('body *')].filter(e => {
        const q = e.getBoundingClientRect();
        if (!(q.width > 0 && (q.right > W + 1 || q.left < -1))) return false;
        let n = e.parentElement;
        while (n && n !== document.body) { const ox = getComputedStyle(n).overflowX;
          if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') return false; n = n.parentElement; }
        return true;
      }).slice(0,3).map(e => `${e.tagName.toLowerCase()}${e.id?'#'+e.id:''}.${String(e.className).split(' ')[0]}`);
      return { sw: d.scrollWidth, cw: W, off, chatOpen: getComputedStyle(document.querySelector('#bdChat')).display !== 'none' };
    });
    const ok = r.sw <= r.cw && r.chatOpen;
    if (!ok) bad++;
    console.log(`  ${ok ? '✔' : '✖'} ${String(w).padStart(4)}px  scrollWidth=${r.sw} (экран ${r.cw})  чат=${r.chatOpen?'ок':'НЕ ОТКРЫЛСЯ'}${r.off.length ? '  виновники: '+r.off.join(', ') : ''}`);
    await ctx.close();
  }
  console.log(bad ? `\n${bad} проблемных ширин` : '\n✔ все ширины чистые');
  await b.close();
})();
