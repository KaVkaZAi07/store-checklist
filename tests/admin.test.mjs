import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Small DOM double: reject HTML writes so text safety is exercised by rendering.
class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.hidden = false;
    this._text = '';
    this.className = '';
    this.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(' '); }
  set innerHTML(_) { throw new Error('Dynamic HTML is not permitted in admin rendering'); }
  append(...children) { children.forEach(child => { child.parentElement = this; }); this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = []; this.append(...children); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener() {}
}

function harness() {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) {
      const element = new Element();
      element.parentElement = new Element();
      elements.set(id, element);
    }
    return elements.get(id);
  };
  const context = vm.createContext({
    CONFIG: {
      TIMEZONE: 'Europe/Moscow',
      USERS: { agnesa: { name: 'Агнесса', role: 'employee' }, oksana: { name: 'Оксана', role: 'employee' } }
    },
    TASKS: {
      morning: [{ id: 'm1', name: 'Дверь' }, { id: 'm2', name: 'Музыка' }],
      daytime: [{ id: 'd1', name: 'Покупатели' }],
      evening: [{ id: 'e1', name: 'Закрытие' }]
    },
    TOTAL_TASKS: 4,
    API: { async getDayData() { throw new Error('Test must supply its response'); } },
    document: { addEventListener() {}, getElementById: get, createElement: tag => new Element(tag) },
    console,
  });
  const source = readFileSync(new URL('../js/admin.js', import.meta.url), 'utf8')
    .replace(/\}\)\(\);\s*$/, `
      globalThis.adminTest = {
        sectionStats, totals, renderAll, renderDetails, renderEmployee, loadDayData,
        setData(value, date = '2026-10-04') { dayData = value; dataDate = date; selectedDate = date; },
        setDate(value) { selectedDate = value; },
        state() { return { dayData, dataDate, selectedDate }; }
      };
    })();`);
  vm.runInContext(source, context);
  return { admin: context.adminTest, api: context.API, get };
}

function fixture() {
  return {
    tasks: {
      'Агнесса_m1': { isFailed: true, reason: '<img src=x onerror=alert(1)>', timeStr: '09:05:00' },
      'Оксана_m1': { isFailed: false, isLate: false, timeStr: '09:10:00' },
      'Агнесса_m2': { isFailed: false, isLate: true, timeStr: '10:20:00' },
      'Оксана_e1': { isFailed: true, reason: 'Нет доступа', timeStr: '19:40:00' },
    },
    customersLog: []
  };
}

test('failed records never count as completed; successful colleague covers the shared task', () => {
  const { admin } = harness();
  admin.setData(fixture());
  const overall = admin.totals();
  assert.equal(overall.completed, 2);
  assert.equal(overall.failed, 1);
  assert.equal(overall.pending, 1);
  assert.equal(overall.late, 1);
  const personal = admin.totals('Агнесса');
  assert.equal(personal.completed, 1);
  assert.equal(personal.failed, 1);
  assert.equal(personal.pending, 2);
});

test('an all-failed checklist has zero successful progress', () => {
  const { admin, get } = harness();
  const tasks = Object.fromEntries(['m1', 'm2', 'd1', 'e1'].map(id => ['Агнесса_' + id, { isFailed: true }]));
  admin.setData({ tasks, customersLog: [] });
  admin.renderAll();
  assert.equal(get('overall-total').textContent, '0/4');
  assert.equal(get('agnesa-total').textContent, '0/4');
  assert.equal(get('overall-morning-bar').style.width, '0%');
  assert.match(get('agnesa-status-summary').textContent, /Не выполнено: 4/);
});

test('reasons and visitor names are rendered as text; no arrival never implies presence', () => {
  const { admin, get } = harness();
  const data = fixture();
  data.customersLog = [{ employee: '<script>bad()</script>', timeStr: '12:00:00' }];
  admin.setData(data);
  admin.renderAll();
  admin.renderDetails({ key: 'agnesa', name: 'Агнесса' });
  assert.match(get('detail-tasks').textContent, /<img src=x onerror=alert\(1\)>/);
  assert.match(get('customers-log').textContent, /<script>bad\(\)<\/script>/);
  assert.match(get('agnesa-work-status').textContent, /Приход не отмечен/);
  assert.doesNotMatch(get('agnesa-work-status').textContent, /На работе|Ещё на работе/);
});

test('a late response for a previous date cannot replace the selected report', async () => {
  const { admin, api, get } = harness();
  const pending = new Map();
  api.getDayData = date => new Promise(resolve => pending.set(date, resolve));
  admin.setDate('2026-10-03');
  const first = admin.loadDayData();
  admin.setDate('2026-10-04');
  const second = admin.loadDayData();
  pending.get('2026-10-04')({ ...fixture(), source: 'server' });
  await second;
  pending.get('2026-10-03')({ tasks: {}, customersLog: [], source: 'server' });
  await first;
  assert.equal(admin.state().dataDate, '2026-10-04');
  assert.equal(get('overall-total').textContent, '2/4');
  assert.equal(get('refresh-btn').disabled, false);
});

test('cache is labelled, a failed new date never displays the previous date as an empty report', async () => {
  const { admin, api, get } = harness();
  api.getDayData = async () => ({ ...fixture(), source: 'cache', stale: true });
  admin.setDate('2026-10-03');
  await admin.loadDayData();
  assert.equal(get('data-status').dataset.state, 'warning');
  assert.match(get('data-status').textContent, /Сохранённая копия/);
  assert.equal(get('admin-data').hidden, false);

  api.getDayData = async () => { throw new Error('No cache or server'); };
  admin.setDate('2026-10-04');
  await admin.loadDayData();
  assert.equal(get('data-status').dataset.state, 'error');
  assert.equal(get('admin-data').hidden, true);
  assert.match(get('data-status').textContent, /04\.10\.2026/);
  assert.equal(get('refresh-btn').disabled, false);
});
