// Employee records are authoritative only after the API confirms the write.
(function () {
  'use strict';

  const SECTIONS = ['morning', 'daytime', 'evening'];
  const CONFIRMATIONS = { morning: 'm9', evening: 'e8' };
  const busy = new Set();
  let user, activeDate;
  let entries = {};
  let customers = [];
  let source = 'loading';
  let lastSyncedAt = null;
  let loading = false;
  let revision = 0;
  let reloadNeeded = false;
  let toastTimer;
  let activeModal = null;
  let focusBeforeModal = null;
  let failureTask = null;
  let customerCooldown = 0;

  const byId = id => document.getElementById(id);
  const today = () => typeof API._todayKey === 'function' ? API._todayKey() : new Date().toLocaleDateString('sv-SE', { timeZone: CONFIG.TIMEZONE });
  const key = id => user.name + '_' + id;
  const entry = id => entries[key(id)];
  const canWrite = () => source === 'server' && navigator.onLine;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(text, className, handler, disabled = false) {
    const node = element('button', className, text);
    node.type = 'button';
    node.disabled = disabled;
    node.addEventListener('click', handler);
    return node;
  }

  function timeText(value) {
    if (!value || Number.isNaN(new Date(value).getTime())) return '';
    return new Date(value).toLocaleTimeString('ru-RU', {
      timeZone: CONFIG.TIMEZONE, hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  }

  function savedTime(record) { return record.timeStr || timeText(record.completedAt || record.timestamp); }

  function showToast(message, type = 'success') {
    clearTimeout(toastTimer);
    const toast = byId('toast');
    toast.textContent = message;
    toast.className = 'toast visible ' + type;
    toastTimer = setTimeout(() => toast.classList.remove('visible'), type === 'error' ? 7000 : 4500);
  }

  function errorText(error) {
    return error && error.message ? error.message : 'Не удалось сохранить. Обновите данные и попробуйте ещё раз.';
  }

  function undoSeconds(record) {
    const timestamp = new Date(record.completedAt).getTime();
    if (!Number.isFinite(timestamp)) return 0;
    const now = typeof API._now === 'function' ? API._now() : Date.now();
    return Math.max(0, Math.ceil((timestamp + CONFIG.UNDO_TIMEOUT - now) / 1000));
  }

  function undoBlock(id, section) {
    if (id === '_arrive' && entry('_leave')) return 'Сначала отмените завершение смены.';
    if (id === '_arrive' && busy.has('_leave')) return 'Дождитесь сохранения завершения смены.';
    const confirmation = CONFIRMATIONS[section];
    if (confirmation && id !== confirmation && entry(confirmation)) return 'Для отмены сначала отмените подтверждение раздела.';
    if (confirmation && id !== confirmation && busy.has(confirmation)) return 'Дождитесь сохранения подтверждения раздела.';
    return '';
  }

  function addUndo(container, id, section, record) {
    if (!undoSeconds(record)) return;
    const blocker = undoBlock(id, section);
    const undo = button('Отменить', 'undo-btn', () => undoRecord(id, section), !canWrite() || busy.has(id) || Boolean(blocker));
    undo.id = 'undo-' + id;
    undo.dataset.undoId = id;
    undo.dataset.section = section;
    undo.textContent = busy.has(id) ? 'Отменяем…' : 'Отменить · ' + undoSeconds(record) + ' с';
    if (blocker) undo.title = blocker;
    container.append(undo);
    if (blocker) container.append(element('p', 'task-hint undo-hint', blocker));
  }

  function sectionReady(section, id) {
    if (CONFIRMATIONS[section] !== id) return true;
    return TASKS[section].filter(task => task.id !== id).every(task => entry(task.id) && !busy.has(task.id));
  }

  function createTask(task, section, index) {
    const record = entry(task.id);
    const card = element('article', 'task-card');
    card.id = 'task-' + task.id;
    card.setAttribute('aria-labelledby', 'name-' + task.id);
    const marker = element('span', 'task-index', String(index + 1).padStart(2, '0'));
    marker.setAttribute('aria-hidden', 'true');
    const content = element('div', 'task-content');
    const heading = element('h3', 'task-name', task.name);
    heading.id = 'name-' + task.id;
    content.append(heading);
    card.append(marker, content);
    const actions = element('div', 'task-actions');
    if (record) {
      card.classList.add(record.isFailed ? 'failed' : record.isLate ? 'late' : 'completed');
      marker.textContent = record.isFailed ? '×' : '✓';
      const status = record.isFailed ? 'Не выполнено' : record.isLate ? 'Выполнено с опозданием' : 'Выполнено';
      content.append(element('p', 'task-status', status + ' · ' + savedTime(record)));
      if (record.isFailed && record.reason) content.append(element('p', 'task-reason', 'Причина: ' + record.reason));
      addUndo(actions, task.id, section, record);
    } else {
      const ready = sectionReady(section, task.id);
      const locked = !canWrite() || busy.has(task.id) || !ready;
      const complete = button(busy.has(task.id) ? 'Сохраняем…' : CONFIRMATIONS[section] === task.id ? 'Подтвердить' : 'Выполнено', 'complete-btn', () => saveTask(task, section), locked);
      complete.id = 'complete-' + task.id;
      complete.setAttribute('aria-label', 'Выполнено: ' + task.name);
      const fail = button('Не выполнено', 'fail-btn', () => openFailure(task, section), locked);
      fail.id = 'fail-' + task.id;
      fail.setAttribute('aria-label', 'Не выполнено: ' + task.name);
      actions.append(complete, fail);
      if (!ready) {
        const hint = element('p', 'task-hint', 'Сначала отметьте все предыдущие задачи этого раздела.');
        hint.id = 'hint-' + task.id;
        content.append(hint);
        complete.setAttribute('aria-describedby', hint.id);
        fail.setAttribute('aria-describedby', hint.id);
      }
    }
    if (actions.childElementCount) content.append(actions);
    return card;
  }

  function renderProgress() {
    let done = 0, failed = 0;
    SECTIONS.forEach(section => {
      let sectionDone = 0, sectionFailed = 0;
      TASKS[section].forEach(task => {
        const record = entry(task.id);
        if (record) record.isFailed ? sectionFailed++ : sectionDone++;
      });
      done += sectionDone;
      failed += sectionFailed;
      const badge = byId(section + '-count');
      badge.textContent = sectionDone + '/' + TASKS[section].length;
      badge.classList.toggle('done', sectionDone === TASKS[section].length);
      badge.setAttribute('role', 'status');
      badge.setAttribute('aria-label', 'Выполнено ' + sectionDone + ' из ' + TASKS[section].length + '; не выполнено ' + sectionFailed);
    });
    const remaining = TOTAL_TASKS - done - failed;
    byId('count-done').textContent = done;
    byId('count-failed').textContent = failed;
    byId('count-remaining').textContent = remaining;
    byId('progress-number').textContent = done;
    byId('progress-total').textContent = 'из ' + TOTAL_TASKS;
    byId('progress-text').textContent = remaining
      ? 'Выполнено ' + done + ' из ' + TOTAL_TASKS + '. Без отметки: ' + remaining + (failed ? '. Не выполнено: ' + failed + '.' : '.')
      : failed ? 'Все задачи отмечены. Не выполнено: ' + failed + ' — причины сохранены.' : 'Все задачи выполнены. Спасибо за работу!';
    const circumference = 2 * Math.PI * 52;
    byId('progress-ring').style.strokeDasharray = circumference;
    byId('progress-ring').style.strokeDashoffset = circumference * (1 - done / TOTAL_TASKS);
  }

  function renderWorkStatus() {
    ['arrive', 'leave'].forEach(type => {
      const id = '_' + type;
      const record = entry(id);
      const control = byId(type + '-btn');
      const feedback = byId(type + '-feedback');
      control.disabled = !canWrite() || busy.has(id) || Boolean(record) || (type === 'leave' && (!entry('_arrive') || busy.has('_arrive')));
      control.classList.toggle('recorded', Boolean(record));
      control.querySelector('span').textContent = busy.has(id) ? 'Сохраняем…' : record
        ? (type === 'arrive' ? 'На работе с ' : 'Смена завершена в ') + savedTime(record)
        : type === 'arrive' ? 'Я на работе' : 'Завершить смену';
      feedback.replaceChildren();
      if (record) addUndo(feedback, id, 'status', record);
      if (type === 'leave' && !entry('_arrive')) feedback.append(element('p', 'task-hint', 'Сначала отметьте начало смены.'));
    });
  }

  function renderCustomers() {
    const ownRecords = customers.filter(record => record.employee === user.name);
    byId('customers-summary').textContent = 'Сегодня вы отметили: ' + ownRecords.length;
    const list = byId('customers-log');
    list.replaceChildren();
    ownRecords.slice().sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 5).forEach(record => {
      list.append(element('li', '', 'Визит · ' + savedTime(record)));
    });
    renderCustomerButton();
  }

  function renderCustomerButton() {
    const control = byId('customers-btn');
    control.disabled = !canWrite() || busy.has('customers') || customerCooldown > Date.now();
    control.textContent = busy.has('customers') ? 'Сохраняем визит…' : '+ Записать визит';
  }

  function renderSync() {
    const status = byId('sync-status');
    const last = lastSyncedAt ? ' Последнее обновление: ' + timeText(lastSyncedAt) + '.' : '';
    if (loading) status.textContent = 'Обновляем отметки…';
    else if (!navigator.onLine) status.textContent = 'Нет интернета. Только просмотр.' + last;
    else if (source === 'server') status.textContent = 'Данные обновлены' + (lastSyncedAt ? ' в ' + timeText(lastSyncedAt) : '') + ' · МСК';
    else if (source === 'cache') status.textContent = 'Сохранённая копия. Обновите данные для новых отметок.' + last;
    else status.textContent = 'Не удалось загрузить отметки. Нажмите «Обновить».';
    status.dataset.state = !navigator.onLine || source !== 'server' ? 'warning' : 'ready';
    byId('offline-banner').hidden = navigator.onLine;
    byId('refresh-btn').disabled = loading || busy.size > 0;
    byId('refresh-btn').textContent = loading ? 'Обновляем…' : 'Обновить';
  }

  function renderAll() {
    // Preserve keyboard focus when replacing task rows after a save or refresh.
    const focusedId = document.activeElement && document.activeElement.id;
    SECTIONS.forEach(section => {
      const container = byId(section + '-tasks');
      container.replaceChildren(...TASKS[section].map((task, index) => createTask(task, section, index)));
      container.setAttribute('aria-busy', String(loading));
    });
    renderProgress();
    renderWorkStatus();
    renderCustomers();
    renderSync();
    if (focusedId && !activeModal) {
      const next = byId(focusedId);
      if (next && !next.disabled) next.focus({ preventScroll: true });
    }
  }

  function updateDate() {
    byId('current-date').textContent = new Date(activeDate + 'T12:00:00Z').toLocaleDateString('ru-RU', {
      timeZone: CONFIG.TIMEZONE, weekday: 'long', day: 'numeric', month: 'long'
    }) + ' · МСК';
  }

  function checkDay() {
    const nextDate = today();
    if (activeDate === nextDate) return false;
    activeDate = nextDate;
    revision++;
    entries = {};
    customers = [];
    source = 'loading';
    lastSyncedAt = null;
    closeModal(true);
    updateDate();
    renderAll();
    reloadNeeded = true;
    if (!loading && !busy.size) loadDayData();
    return true;
  }

  async function loadDayData() {
    if (loading || busy.size) { reloadNeeded = true; return; }
    loading = true;
    reloadNeeded = false;
    const requestedDate = activeDate;
    const requestedRevision = revision;
    renderSync();
    try {
      const data = await API.getDayData(requestedDate);
      if (requestedDate !== activeDate || requestedRevision !== revision) { reloadNeeded = true; return; }
      entries = data.tasks || {};
      customers = data.customersLog || [];
      source = data.source === 'server' && !data.stale ? 'server' : 'cache';
      lastSyncedAt = data.lastSyncedAt || null;
    } catch (error) {
      if (requestedDate === activeDate && requestedRevision === revision) {
        source = Object.keys(entries).length || customers.length ? 'cache' : 'error';
        showToast(errorText(error), 'error');
      }
    } finally {
      loading = false;
      renderAll();
      if (reloadNeeded && !busy.size) loadDayData();
    }
  }

  async function mutate(id, operation, apply, message) {
    if (checkDay()) { showToast('Начался новый день. Дождитесь загрузки нового чек-листа.', 'warning'); return false; }
    if (busy.has(id)) return false;
    if (!canWrite()) { showToast('Для сохранения нужен интернет и актуальные данные. Нажмите «Обновить».', 'error'); return false; }
    const mutationDate = activeDate;
    busy.add(id);
    revision++;
    renderAll();
    try {
      const result = await operation(mutationDate);
      if (!result || result.success !== true) throw new Error('Сервер не подтвердил сохранение. Обновите данные.');
      if (today() !== activeDate) checkDay();
      if (mutationDate === activeDate && (!result.date || result.date === activeDate)) {
        apply(result);
        showToast(typeof message === 'function' ? message(result) : message);
      } else {
        reloadNeeded = true;
        showToast('Отметка сохранена за предыдущий день. Обновляем сегодняшний чек-лист.', 'warning');
      }
      return true;
    } catch (error) {
      showToast(errorText(error), 'error');
      if (activeModal === 'fail-modal' && failureTask?.task.id === id) byId('fail-error').textContent = errorText(error);
      // A timeout may have happened after the server accepted the write.
      reloadNeeded = true;
      return false;
    } finally {
      busy.delete(id);
      revision++;
      renderAll();
      if (reloadNeeded && !loading && !busy.size) loadDayData();
    }
  }

  function acceptEntry(id, result) {
    if (!result.entry || !result.entry.completedAt) throw new Error('Не получено подтверждение отметки. Обновите данные.');
    entries[key(id)] = result.entry;
  }

  async function saveTask(task, section) {
    if (entry(task.id) || !sectionReady(section, task.id)) return;
    const saved = await mutate(task.id,
      date => API.completeTask(user.name, task.id, task.name, section, date),
      result => acceptEntry(task.id, result),
      result => result.entry.isLate ? 'Выполнено с опозданием. Отметка сохранена.' : 'Выполнение сохранено.');
    if (saved) byId('undo-' + task.id)?.focus({ preventScroll: true });
  }

  async function undoRecord(id, section) {
    if (!entry(id) || !undoSeconds(entry(id)) || undoBlock(id, section)) return;
    const saved = await mutate(id,
      date => section === 'status' ? API.undoWorkStatus(user.name, id.slice(1), date) : API.undoTask(user.name, id, section, date),
      () => { delete entries[key(id)]; }, 'Отметка отменена.');
    if (saved) (byId('complete-' + id) || byId(id.slice(1) + '-btn'))?.focus({ preventScroll: true });
  }

  async function saveWorkStatus(type) {
    const id = '_' + type;
    if (entry(id) || (type === 'leave' && (!entry('_arrive') || busy.has('_arrive')))) return;
    await mutate(id, date => API.logWorkStatus(user.name, type, date), result => acceptEntry(id, result),
      type === 'arrive' ? 'Начало смены сохранено. Хорошего рабочего дня!' : 'Смена завершена. Все отметки сохранены.');
  }

  async function saveCustomer() {
    if (Date.now() < customerCooldown) return;
    await mutate('customers', date => API.logCustomersEvent(user.name, date), result => {
      if (!result.entry) throw new Error('Не получено подтверждение визита. Обновите данные.');
      const existingIndex = result.entry.id ? customers.findIndex(record => record.id === result.entry.id) : -1;
      if (existingIndex >= 0) customers[existingIndex] = result.entry;
      else customers.push(result.entry);
      customerCooldown = Date.now() + 1500;
    }, 'Визит сохранён.');
  }

  function openModal(id, firstFocus) {
    focusBeforeModal = document.activeElement;
    activeModal = id;
    const modal = byId(id);
    modal.hidden = false;
    modal.classList.add('active');
    document.querySelector('.employee-page').inert = true;
    document.body.classList.add('dialog-open');
    (byId(firstFocus) || modal.querySelector('[role="dialog"]')).focus();
  }

  function closeModal(force = false) {
    if (!activeModal || (!force && activeModal === 'fail-modal' && failureTask && busy.has(failureTask.task.id))) return;
    const modal = byId(activeModal);
    modal.hidden = true;
    modal.classList.remove('active');
    activeModal = null;
    document.querySelector('.employee-page').inert = false;
    document.body.classList.remove('dialog-open');
    const restore = focusBeforeModal && focusBeforeModal.id ? byId(focusBeforeModal.id) : focusBeforeModal;
    if (restore && restore.isConnected && !restore.disabled) restore.focus({ preventScroll: true });
  }

  function openFailure(task, section) {
    if (checkDay() || !canWrite() || busy.has(task.id) || entry(task.id) || !sectionReady(section, task.id)) return;
    failureTask = { task, section };
    byId('fail-task-name').textContent = task.name;
    byId('fail-reason').value = '';
    byId('fail-error').textContent = '';
    openModal('fail-modal', 'fail-reason');
  }

  async function submitFailure(event) {
    event.preventDefault();
    if (!failureTask || busy.has(failureTask.task.id)) return;
    const { task, section } = failureTask;
    const reason = byId('fail-reason').value.trim();
    if (reason.length < 3 || reason.length > 500) {
      byId('fail-error').textContent = 'Укажите причину длиной от 3 до 500 символов.';
      byId('fail-reason').focus();
      return;
    }
    if (entry(task.id) || !sectionReady(section, task.id)) {
      byId('fail-error').textContent = 'Данные задачи изменились. Закройте окно и проверьте отметки.';
      return;
    }
    const submit = byId('fail-submit');
    submit.disabled = true;
    submit.textContent = 'Сохраняем…';
    byId('fail-error').textContent = '';
    const saved = await mutate(task.id,
      date => API.failTask(user.name, task.id, task.name, section, reason, date),
      result => acceptEntry(task.id, result), 'Отметка «Не выполнено» и причина сохранены.');
    submit.disabled = false;
    submit.textContent = 'Сохранить причину';
    if (saved) {
      closeModal();
      byId('undo-' + task.id)?.focus({ preventScroll: true });
    }
  }

  function tick() {
    if (checkDay()) return;
    document.querySelectorAll('[data-undo-id]').forEach(control => {
      const record = entry(control.dataset.undoId);
      const seconds = record ? undoSeconds(record) : 0;
      if (!seconds) {
        const container = control.parentElement;
        control.remove();
        container.querySelector('.undo-hint')?.remove();
      } else if (!busy.has(control.dataset.undoId)) control.textContent = 'Отменить · ' + seconds + ' с';
    });
    renderCustomerButton();
  }

  document.addEventListener('DOMContentLoaded', () => {
    user = Auth.requireAuth('employee');
    if (!user) return;
    activeDate = today();
    byId('employee-name').textContent = user.name;
    updateDate();
    byId('logout-btn').addEventListener('click', () => Auth.logout());
    byId('refresh-btn').addEventListener('click', () => { if (!checkDay()) loadDayData(); });
    byId('arrive-btn').addEventListener('click', () => saveWorkStatus('arrive'));
    byId('leave-btn').addEventListener('click', () => saveWorkStatus('leave'));
    byId('customers-btn').addEventListener('click', saveCustomer);
    byId('show-instructions-btn').addEventListener('click', () => openModal('instructions-modal', 'instructions-close'));
    byId('instructions-close').addEventListener('click', () => closeModal());
    byId('fail-close').addEventListener('click', () => closeModal());
    byId('fail-form').addEventListener('submit', submitFailure);
    ['fail-modal', 'instructions-modal'].forEach(id => {
      byId(id).addEventListener('click', event => { if (event.target === byId(id)) closeModal(); });
    });
    document.addEventListener('keydown', event => {
      if (!activeModal) return;
      if (event.key === 'Escape') { event.preventDefault(); closeModal(); }
      if (event.key === 'Tab') {
        const focusable = [...byId(activeModal).querySelectorAll('button:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')];
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });
    window.addEventListener('online', () => { if (!checkDay()) loadDayData(); });
    window.addEventListener('offline', renderAll);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && !checkDay()) loadDayData(); });
    window.addEventListener('pageshow', event => { if (event.persisted && !checkDay()) loadDayData(); });
    renderAll();
    loadDayData();
    setInterval(tick, 1000);
    setInterval(() => { if (!document.hidden && !checkDay()) loadDayData(); }, CONFIG.REFRESH_INTERVAL);
  });
})();
