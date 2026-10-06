const fs = require('fs');
const { doc, el } = require('./dom-stub.js');
const src = fs.readFileSync('../app/app.js','utf8') + '\n' + fs.readFileSync('../app/chat.js','utf8');

const g = (name) => doc.querySelector(name);
const navigator = {};
const win = { addEventListener(){}, open(){} };
const loc = { origin:'https://test', href:'https://test/' };
const ls = new Map();
const localStorage = { getItem:k=>ls.has(k)?ls.get(k):null, setItem:(k,v)=>ls.set(k,v), removeItem:k=>ls.delete(k) };

const fn = new Function('document','window','navigator','location','performance','requestAnimationFrame',
  'indexedDB','localStorage','confirm','addEventListener','setInterval','clearInterval',
  src + '\n; return { S, scan, render, filtered, total, analyze, subs, detail };');

const api = fn(doc, win, navigator, loc, performance, cb=>setTimeout(cb,0), undefined, localStorage,
  ()=>true, ()=>{}, ()=>0, ()=>{});

(async () => {
  console.log('✔ инициализация прошла, обработчики привязаны');
  api.S.target = 12;
  await api.scan();
  const done = api.S.catalog.filter(c => c.verified);
  console.log(`✔ проверено: ${done.length}, живых: ${api.S.catalog.filter(c=>c.ok).length}, в каталоге: ${api.S.catalog.length}`);
  api.render();
  const top = api.filtered().sort((a,b)=>b.score-a.score).slice(0,6);
  console.log('\nтоп после проверки:');
  top.forEach((c,i)=>console.log(` ${i+1}. ${String(c.score.toFixed(1)).padStart(5)}  ${c.title.slice(0,42)}`));
  // рендер развёрнутой карточки
  const d = api.detail(api.S.catalog.find(c=>c.ok));
  console.log('\n✔ detail() собрал', d.length, 'символов разметки');
  console.log('✔ подкритерии:', JSON.stringify(api.subs(top[0])));
  // чат
  const c = api.S.catalog.find(x=>x.ok);
  console.log('✔ эндпоинтов у примера:', (c.sampleOps||[]).length);
})().catch(e => { console.error('✖ ОШИБКА:', e.message); console.error(e.stack.split('\n').slice(0,4).join('\n')); process.exit(1); });
