#!/usr/bin/env node
/**
 * Deterministic local test harness for the qty-increment / stop-list stock
 * consumption invariant (hotfix/qty-increment-consumes-stoplist).
 *
 * Loads app.js in a vm context with a mocked DOM/localStorage/Firebase so
 * addItem()/changeQty()/etc. run against an in-memory `orders` object with
 * no network access and no live Firebase writes.
 *
 * Run: node test-qty-increment-stoplist.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---------------------------------------------------------------------
// Minimal permissive DOM mock: any element/property/method access is
// safe and no-op unless explicitly overridden. This is sufficient because
// the logic under test lives in the `orders` object, not the DOM.
// ---------------------------------------------------------------------
function makeFakeElement() {
  const store = { classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } }, style: {}, dataset: {} };
  const handler = {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === Symbol.toPrimitive || typeof prop === 'symbol') return undefined;
      if (['addEventListener','removeEventListener','appendChild','remove','focus','blur',
           'setAttribute','removeAttribute','scrollIntoView','preventDefault','click'].includes(prop)) {
        return () => {};
      }
      if (prop === 'querySelector') return () => makeFakeElement();
      if (prop === 'querySelectorAll') return () => [];
      if (prop === 'getAttribute') return () => null;
      if (prop === 'closest') return () => null;
      if (prop === 'matches') return () => false;
      if (prop === 'cloneNode') return () => makeFakeElement();
      return undefined;
    },
    set(target, prop, value) { target[prop] = value; return true; },
  };
  return new Proxy(store, handler);
}

function makeDocument() {
  const cache = new Map();
  return {
    getElementById(id) {
      if (!cache.has(id)) cache.set(id, makeFakeElement());
      return cache.get(id);
    },
    querySelector() { return makeFakeElement(); },
    querySelectorAll() { return []; },
    createElement() { return makeFakeElement(); },
    addEventListener() {},
    removeEventListener() {},
    body: makeFakeElement(),
    documentElement: makeFakeElement(),
  };
}

function makeLocalStorage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: k => { map.delete(k); },
  };
}

// Firebase mock: captures audit log writes and order/notes/sent writes into
// in-memory stores. No network access, nothing is ever written live.
function makeDb(state) {
  function makeRef(pathStr) {
    return {
      push(obj) {
        if (pathStr === 'auditLog') state.auditLog.push(obj);
        return { catch() { return this; }, then() { return this; } };
      },
      set(obj) { state.store[pathStr] = obj; return { catch() {}, then(fn) { fn && fn(); } }; },
      update(obj) { state.store[pathStr] = Object.assign(state.store[pathStr] || {}, obj); return Promise.resolve(); },
      remove() { delete state.store[pathStr]; return Promise.resolve(); },
      once() { return Promise.resolve({ val: () => (pathStr in state.store ? state.store[pathStr] : null), forEach() {} }); },
      on() { /* no-op: tests drive `orders` directly, listeners are never needed */ },
      off() {},
      transaction(updateFn, cb) {
        const cur = state.store[pathStr];
        const next = updateFn(cur);
        if (next !== undefined) state.store[pathStr] = next;
        if (cb) cb(null, true, { val: () => state.store[pathStr] });
        return Promise.resolve();
      },
      child(sub) { return makeRef(pathStr + '/' + sub); },
    };
  }
  return { ref: makeRef };
}

// ---------------------------------------------------------------------
// Build sandbox + load app.js
// ---------------------------------------------------------------------
function loadApp() {
  const state = { auditLog: [], store: {}, alerts: [] };
  const sandbox = {};
  sandbox.localStorage = makeLocalStorage({ deviceId: 'dev_test', deviceName: 'Test Device' });
  sandbox.document = makeDocument();
  sandbox.window = sandbox; // window.addEventListener('DOMContentLoaded', ...) becomes a no-op capture
  sandbox.window.addEventListener = () => {}; // never fire init/DOMContentLoaded — tests drive state directly
  sandbox.navigator = { userAgent: 'test-harness' };
  sandbox.alert = msg => { state.alerts.push(msg); };
  sandbox.console = console;
  sandbox.db = makeDb(state);
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.Date = Date;
  sandbox.Math = Math;
  sandbox.JSON = JSON;
  sandbox.Object = Object;
  sandbox.Promise = Promise;

  const ctx = vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  vm.runInContext(src, ctx, { filename: 'app.js' });

  // Expose test hooks into the same top-level lexical scope as app.js so we
  // can read/reset `orders`/`currentTable`/`sentQty` and call its functions.
  const hookSrc = `
    (function(){
      globalThis.__test = {
        getOrders: () => orders,
        setOrders: (o) => { orders = o; },
        setCurrentTable: (t) => { currentTable = t; },
        getCurrentTable: () => currentTable,
        setSentQty: (s) => { sentQty = s; },
        addItem, addItemByName, addItemByVariant, changeQty, selectSide,
        isEffectivelyStopped, consumeDerivedStock, findDerivedLinkByDerivedName,
      };
    })();
  `;
  vm.runInContext(hookSrc, ctx, { filename: 'test-hooks.js' });

  return { ctx, state, api: ctx.__test };
}

// ---------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------
const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail || '' });
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? '  (' + detail + ')' : ''));
}

function fakeBtn() {
  return { classList: { add(){}, contains(){ return false; } }, querySelector: () => ({ textContent: '' }) };
}

function freshEnv() {
  const { state, api } = loadApp();
  api.setOrders({});
  api.setCurrentTable('T1');
  api.setSentQty({});
  return { state, api };
}

// 1. Controlled regular item, stop-list qty 2
(function test1() {
  const { state, api } = freshEnv();
  api.getOrders()['🛑'] = { TestItem: { price: 5, qty: 2, itemName: 'TestItem' } };
  api.addItem(fakeBtn(), 'TestItem', 5, undefined);
  check('1a: add decrements stoplist 2->1, order qty 1',
    api.getOrders()['🛑'].TestItem.qty === 1 && api.getOrders()['T1'].TestItem.qty === 1,
    'stop=' + api.getOrders()['🛑'].TestItem.qty + ' orderQty=' + api.getOrders()['T1'].TestItem.qty);

  api.changeQty('TestItem', 1);
  check('1b: + decrements stoplist 1->0, order qty 2',
    api.getOrders()['🛑'].TestItem.qty === 0 && api.getOrders()['T1'].TestItem.qty === 2,
    'stop=' + api.getOrders()['🛑'].TestItem.qty + ' orderQty=' + api.getOrders()['T1'].TestItem.qty);

  const alertsBefore = state.alerts.length;
  api.changeQty('TestItem', 1);
  check('1c: + blocked at stoplist 0, order qty stays 2',
    api.getOrders()['🛑'].TestItem.qty === 0 && api.getOrders()['T1'].TestItem.qty === 2 && state.alerts.length > alertsBefore,
    'stop=' + api.getOrders()['🛑'].TestItem.qty + ' orderQty=' + api.getOrders()['T1'].TestItem.qty + ' alerted=' + (state.alerts.length > alertsBefore));
})();

// 2. Explicit stop-list qty 0
(function test2() {
  const { state, api } = freshEnv();
  api.getOrders()['🛑'] = { StoppedItem: { price: 5, qty: 0, itemName: 'StoppedItem' } };
  api.addItem(fakeBtn(), 'StoppedItem', 5, undefined);
  check('2a: add blocked when stoplist qty=0', !api.getOrders()['T1'].StoppedItem, 'orderLine=' + JSON.stringify(api.getOrders()['T1'].StoppedItem));

  // Simulate a stale pre-existing order line (item became stopped after being added)
  api.getOrders()['T1'].StoppedItem = { price: 5, qty: 1, itemName: 'StoppedItem' };
  api.changeQty('StoppedItem', 1);
  check('2b: + on stale line blocked when stoplist qty=0', api.getOrders()['T1'].StoppedItem.qty === 1, 'qty=' + api.getOrders()['T1'].StoppedItem.qty);
})();

// 3. Uncontrolled item (absent stop-list entry)
(function test3() {
  const { api } = freshEnv();
  api.addItem(fakeBtn(), 'FreeItem', 4, undefined);
  check('3a: add succeeds, no stoplist entry created',
    api.getOrders()['T1'].FreeItem.qty === 1 && !(api.getOrders()['🛑'] && api.getOrders()['🛑'].FreeItem));
  api.changeQty('FreeItem', 1);
  check('3b: + succeeds, still no stoplist entry',
    api.getOrders()['T1'].FreeItem.qty === 2 && !(api.getOrders()['🛑'] && api.getOrders()['🛑'].FreeItem));
})();

// 4. Popup/group variant (house_wine_white)
(function test4() {
  const { api } = freshEnv();
  api.getOrders()['🛑'] = { house_wine_white: { price: 7, qty: 2, itemName: 'house_wine_white' } };
  api.addItemByVariant('house_wine_white', 7, 'White');
  check('4a: variant add decrements own stock 2->1', api.getOrders()['🛑'].house_wine_white.qty === 1 && api.getOrders()['T1'].house_wine_white.qty === 1);
  api.changeQty('house_wine_white', 1);
  check('4b: variant + decrements own stock 1->0, qty 2', api.getOrders()['🛑'].house_wine_white.qty === 0 && api.getOrders()['T1'].house_wine_white.qty === 2);
  api.changeQty('house_wine_white', 1);
  check('4c: variant + blocked at 0', api.getOrders()['🛑'].house_wine_white.qty === 0 && api.getOrders()['T1'].house_wine_white.qty === 2);
})();

// 5. Wine item (bottled wines route through the same addItem() path)
(function test5() {
  const { api } = freshEnv();
  const wineName = 'Aveleda Fonte Vinho Verde Branco';
  api.getOrders()['🛑'] = {};
  api.getOrders()['🛑'][wineName] = { price: 22, qty: 2, itemName: wineName };
  api.addItem(fakeBtn(), wineName, 22, wineName);
  check('5a: wine add decrements stock 2->1', api.getOrders()['🛑'][wineName].qty === 1 && api.getOrders()['T1'][wineName].qty === 1);
  api.changeQty(wineName, 1);
  check('5b: wine + decrements stock 1->0, qty 2', api.getOrders()['🛑'][wineName].qty === 0 && api.getOrders()['T1'][wineName].qty === 2);
})();

// 6. Side/component item
(function test6() {
  const { api } = freshEnv();
  const mainName = 'Утиная грудка'; // main course, not derived
  const sideName = 'Рис';
  api.getOrders()['🛑'] = {
    [mainName]: { price: 24, qty: 2, itemName: mainName },
    [sideName]: { price: 3, qty: 2, itemName: sideName },
  };
  api.addItemByName(mainName, 24);
  const tableOrder = api.getOrders()['T1'];
  const mainKey = Object.keys(tableOrder).find(k => tableOrder[k].itemName === mainName);
  check('6a: main add decrements own stock 2->1', api.getOrders()['🛑'][mainName].qty === 1);

  api.selectSide(sideName, 0);
  const sideKey = Object.keys(tableOrder).find(k => tableOrder[k].isSide && tableOrder[k].itemName === sideName);
  check('6b: side selection decrements side stock 2->1', api.getOrders()['🛑'][sideName].qty === 1 && !!sideKey);

  api.changeQty(sideKey, 1);
  check('6c: + on side line decrements side stock 1->0, side qty 2',
    api.getOrders()['🛑'][sideName].qty === 0 && tableOrder[sideKey].qty === 2,
    'sideStock=' + api.getOrders()['🛑'][sideName].qty + ' sideQty=' + tableOrder[sideKey].qty);
})();

// Derived stock (Part C): mother 'Стейк тунца' -> derived 'Салат с тунцом', ratio 2
(function testDerived() {
  const { api } = freshEnv();
  const mother = 'Стейк тунца';
  const derived = 'Салат с тунцом';
  api.getOrders()['🛑'] = { [mother]: { price: 26, qty: 3, itemName: mother } };
  api.addItem(fakeBtn(), derived, 12, undefined);
  check('D1: derived add converts 1 mother unit, creates residual',
    api.getOrders()['🛑'][mother].qty === 2 && api.getOrders()['🛑'][derived].qty === 1 && api.getOrders()['T1'][derived].qty === 1,
    'mother=' + api.getOrders()['🛑'][mother].qty + ' derivedResidual=' + api.getOrders()['🛑'][derived].qty);

  api.changeQty(derived, 1);
  check('D2: derived + consumes own residual, mother untouched',
    api.getOrders()['🛑'][mother].qty === 2 && !api.getOrders()['🛑'][derived] && api.getOrders()['T1'][derived].qty === 2,
    'mother=' + api.getOrders()['🛑'][mother].qty + ' residualPresent=' + !!api.getOrders()['🛑'][derived]);

  api.changeQty(derived, 1);
  check('D3: derived + converts another mother unit (2->1)',
    api.getOrders()['🛑'][mother].qty === 1 && api.getOrders()['🛑'][derived].qty === 1 && api.getOrders()['T1'][derived].qty === 3,
    'mother=' + api.getOrders()['🛑'][mother].qty);

  api.changeQty(derived, 1);
  check('D4: derived + consumes last residual, qty 4',
    !api.getOrders()['🛑'][derived] && api.getOrders()['T1'][derived].qty === 4);

  api.changeQty(derived, 1);
  check('D5: derived + blocked once mother<=1 and no residual, qty stays 4',
    api.getOrders()['T1'][derived].qty === 4,
    'qty=' + api.getOrders()['T1'][derived].qty + ' mother=' + api.getOrders()['🛑'][mother].qty);
})();

// Root-cause regression: order line whose displayName (localized/EN text, or a
// combined group+variant label) differs from its canonical stock key (itemName).
// This is the normal case for every real menu button, which always passes a
// dispName distinct from the internal item name (EN translation, or
// "<group label> - <variant label>" for popup variants). Before the fix,
// changeQty()/rollbackOneToStoplist() resolved the stock key from
// displayName first, silently missing the real stoplist entry.
(function testDisplayNameMismatch() {
  const { api } = freshEnv();
  const key = 'Хлебная корзина';     // canonical stock key (itemName) - not a main-course item
  const disp = 'Bread Basket';       // EN display text, as passed by every real add button
  api.getOrders()['🛑'] = { [key]: { price: 24, qty: 2, itemName: key } };
  api.addItem(fakeBtn(), key, 24, disp);
  check('9a: add with EN displayName still decrements canonical stock 2->1',
    api.getOrders()['🛑'][key].qty === 1 && api.getOrders()['T1'][key].qty === 1);

  api.changeQty(key, 1);
  check('9b: + with EN displayName decrements canonical stock 1->0, qty 2 (regression for displayName-vs-itemName key bug)',
    api.getOrders()['🛑'][key].qty === 0 && api.getOrders()['T1'][key].qty === 2,
    'stop=' + api.getOrders()['🛑'][key].qty + ' orderQty=' + api.getOrders()['T1'][key].qty);

  api.changeQty(key, 1);
  check('9c: + with EN displayName blocked once canonical stock is 0',
    api.getOrders()['🛑'][key].qty === 0 && api.getOrders()['T1'][key].qty === 2);

  // Release/rollback path (minus on an unsent line) must restore the same canonical key.
  api.changeQty(key, -1);
  check('9d: - releases stock back to canonical key (qty 2->1, stock 0->1)',
    api.getOrders()['🛑'][key].qty === 1 && api.getOrders()['T1'][key].qty === 1,
    'stop=' + api.getOrders()['🛑'][key].qty + ' orderQty=' + (api.getOrders()['T1'][key] ? api.getOrders()['T1'][key].qty : 0));
})();

// 7. Table 13 (stop-list) regression: undefined -> 0 -> 1 -> 2, minus back down
(function test7() {
  const { api } = freshEnv();
  api.setCurrentTable('🛑');
  const btn = fakeBtn();
  api.addItem(btn, 'RegressionItem', 5, undefined); // undefined -> 0 (explicit stop, first tap)
  check('7a: first stop-list tap creates qty=0', api.getOrders()['🛑'].RegressionItem.qty === 0);
  api.addItem(btn, 'RegressionItem', 5, undefined); // 0 -> 1
  check('7b: second tap -> qty=1', api.getOrders()['🛑'].RegressionItem.qty === 1);
  api.addItem(btn, 'RegressionItem', 5, undefined); // 1 -> 2
  check('7c: third tap -> qty=2', api.getOrders()['🛑'].RegressionItem.qty === 2);
  api.changeQty('RegressionItem', -1); // 2 -> 1
  check('7d: minus -> qty=1', api.getOrders()['🛑'].RegressionItem.qty === 1);
  api.changeQty('RegressionItem', -1); // 1 -> 0
  check('7e: minus -> qty=0 (stays, explicit stop)', api.getOrders()['🛑'].RegressionItem.qty === 0);
  api.changeQty('RegressionItem', -1); // 0 -> removed (absent/unlimited)
  check('7f: minus from 0 -> entry removed (absent)', !api.getOrders()['🛑'].RegressionItem);
})();

// 8. Audit log: stoplist_change before order_qty_change on success; no order_qty_change on block
(function test8() {
  const { state, api } = freshEnv();
  api.getOrders()['🛑'] = { AuditItem: { price: 5, qty: 2, itemName: 'AuditItem' } };
  api.addItem(fakeBtn(), 'AuditItem', 5, undefined);
  state.auditLog.length = 0; // reset, only interested in the + press

  api.changeQty('AuditItem', 1);
  const idxStop = state.auditLog.findIndex(e => e.action === 'stoplist_change');
  const idxQty = state.auditLog.findIndex(e => e.action === 'order_qty_change');
  check('8a: successful + writes STOP LIST CHANGED before QTY CHANGED',
    idxStop !== -1 && idxQty !== -1 && idxStop < idxQty,
    'idxStop=' + idxStop + ' idxQty=' + idxQty);

  state.auditLog.length = 0;
  api.changeQty('AuditItem', 1); // now blocked (stock is 0)
  const hasQtyChange = state.auditLog.some(e => e.action === 'order_qty_change');
  check('8b: blocked + writes no order_qty_change', !hasQtyChange, 'entries=' + JSON.stringify(state.auditLog.map(e => e.action)));
})();

// ---------------------------------------------------------------------
console.log('');
const failed = results.filter(r => !r.pass);
console.log(results.length + ' checks, ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed.');
if (failed.length) {
  console.log('FAILED:');
  failed.forEach(f => console.log('  - ' + f.name + (f.detail ? ' (' + f.detail + ')' : '')));
  process.exit(1);
}
process.exit(0);
