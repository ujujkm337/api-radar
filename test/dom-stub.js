// минимальная заглушка DOM для smoke-теста
const fs = require('fs');
function el(sel) {
  const e = {
    _sel: sel, children: [], style: {}, dataset: {}, value: '', textContent: '', innerHTML: '',
    hidden: false, disabled: false, scrollTop: 0, scrollHeight: 0, firstChild: null,
    classList: { _s: new Set(), add(...c){c.forEach(x=>this._s.add(x))}, remove(...c){c.forEach(x=>this._s.delete(x))},
                 toggle(c,f){ f===undefined? (this._s.has(c)?this._s.delete(c):this._s.add(c)) : (f?this._s.add(c):this._s.delete(c)) },
                 contains(c){return this._s.has(c)} },
    addEventListener(){}, removeEventListener(){}, setAttribute(){}, getAttribute(){return 'true'},
    appendChild(c){this.children.push(c); return c}, removeChild(c){this.children=this.children.filter(x=>x!==c)},
    remove(){}, insertAdjacentHTML(){}, querySelector: s => el(s), querySelectorAll: () => [],
    closest: () => null, focus(){}, click(){}, scrollIntoView(){}
  };
  return e;
}
const cache = new Map();
const doc = {
  querySelector: s => { if(!cache.has(s)) cache.set(s, el(s)); return cache.get(s); },
  querySelectorAll: () => [],
  createElement: t => el(t),
  addEventListener(){}, documentElement: el('html'), body: el('body')
};
module.exports = { doc, el };
