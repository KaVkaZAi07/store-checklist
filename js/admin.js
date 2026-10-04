// Панель владельца: личные отчёты и отдельное покрытие задач магазина.
(function () {
  'use strict';

  const SECTIONS = ['morning', 'daytime', 'evening'];
  const SECTION_NAMES = { morning: 'До 10:00', daytime: 'В течение дня', evening: 'До 20:00' };
  const EMPLOYEES = Object.entries(CONFIG.USERS)
    .filter(([, user]) => user.role === 'employee')
    .map(([key, user]) => ({ key, name: user.name }));
  let selectedDate = '';
  let dayData = null;
  let dataDate = null;
  let requestVersion = 0;
  let activeModal = null;
  let activeEmployee = null;
  let returnFocus = null;

  function today() {
    return new Date().toLocaleDateString('sv-SE', { timeZone: CONFIG.TIMEZONE });
  }

  function yesterday() {
    const date = new Date(today() + 'T12:00:00Z');
    date.setUTCDate(date.getUTCDate() - 1);
    return date.toISOString().slice(0, 10);
  }

  function displayDate(date) {
    return date.split('-').reverse().join('.');
  }

  function displayTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Время не указано' : date.toLocaleTimeString('ru-RU', {
      timeZone: CONFIG.TIMEZONE, hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  }

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function dataStatus(message, state) {
    const status = document.getElementById('data-status');
    status.textContent = message;
    status.dataset.state = state;
  }

  async function loadDayData() {
    const requestedDate = selectedDate;
    const version = ++requestVersion;
    const refresh = document.getElementById('refresh-btn');
    const loading = document.getElementById('loading');
    refresh.disabled = true;
    loading.hidden = false;
    document.getElementById('admin-data').setAttribute('aria-busy', 'true');
    dataStatus('Загружаем отчёт за ' + displayDate(requestedDate) + '…', 'loading');
    if (dataDate !== requestedDate) {
      dayData = null;
      document.getElementById('admin-data').hidden = true;
    }

    try {
      const response = await API.getDayData(requestedDate);
      // Смена даты и повторное обновление могут завершиться в другом порядке.
      if (version !== requestVersion || requestedDate !== selectedDate) return;
      dayData = {
        tasks: response.tasks || {},
        customersLog: response.customersLog || [],
        source: response.source,
        stale: Boolean(response.stale || response.source === 'cache'),
        lastSyncedAt: response.lastSyncedAt
      };
      dataDate = requestedDate;
      const syncTime = response.lastSyncedAt ? displayTime(response.lastSyncedAt) : '';
      if (dayData.stale) {
        dataStatus('Сохранённая копия. Связь с сервером не подтверждена.' +
          (syncTime ? ' Последнее обновление: ' + syncTime + '.' : '') + ' Нажмите «Обновить».', 'warning');
      } else {
        dataStatus('Данные с сервера · обновлено ' + (syncTime || displayTime(new Date())) + ' · время московское', 'success');
      }
      renderAll();
      document.getElementById('admin-data').hidden = false;
    } catch (error) {
      if (version !== requestVersion || requestedDate !== selectedDate) return;
      if (dayData && dataDate === requestedDate) {
        dayData.stale = true;
        dataStatus('Не удалось обновить отчёт. Показаны предыдущие данные за выбранную дату. Повторите обновление.', 'error');
      } else {
        document.getElementById('admin-data').hidden = true;
        dataStatus('Отчёт за ' + displayDate(requestedDate) + ' не загружен. ' +
          (error.message || 'Проверьте подключение.') + ' Нажмите «Обновить», чтобы повторить.', 'error');
      }
    } finally {
      if (version === requestVersion) {
        refresh.disabled = false;
        loading.hidden = true;
        document.getElementById('admin-data').setAttribute('aria-busy', 'false');
      }
    }
  }

  function entryFor(employee, taskId) {
    return dayData.tasks[employee + '_' + taskId];
  }

  function sectionStats(section, employee) {
    const result = { total: TASKS[section].length, completed: 0, failed: 0, pending: 0, late: 0, problems: [] };
    TASKS[section].forEach(task => {
      const entries = employee
        ? [entryFor(employee, task.id)].filter(Boolean)
        : EMPLOYEES.map(emp => entryFor(emp.name, task.id)).filter(Boolean);
      // Отказ одного сотрудника не перекрывает успешное выполнение другим.
      const successful = entries.filter(entry => !entry.isFailed);
      if (successful.length) {
        result.completed++;
        if (successful.every(entry => entry.isLate)) result.late++;
      } else if (entries.length) {
        result.failed++;
        result.problems.push({ task, failed: true });
      } else {
        result.pending++;
        result.problems.push({ task, failed: false });
      }
    });
    return result;
  }

  function setProgress(prefix, section, stats) {
    const bar = document.getElementById(prefix + '-' + section + '-bar');
    const text = document.getElementById(prefix + '-' + section + '-text');
    if (!bar || !text) return;
    const percent = stats.total ? stats.completed / stats.total * 100 : 0;
    bar.style.width = percent + '%';
    bar.className = 'section-progress-fill ' + (percent === 100 ? 'complete' : percent ? 'partial' : 'empty');
    text.textContent = stats.completed + '/' + stats.total;
    bar.parentElement.setAttribute('role', 'progressbar');
    bar.parentElement.setAttribute('aria-label', SECTION_NAMES[section] + ': выполнено');
    bar.parentElement.setAttribute('aria-valuemin', '0');
    bar.parentElement.setAttribute('aria-valuemax', String(stats.total));
    bar.parentElement.setAttribute('aria-valuenow', String(stats.completed));
  }

  function totals(employee) {
    return SECTIONS.reduce((sum, section) => {
      const stats = sectionStats(section, employee);
      ['completed', 'failed', 'pending', 'late'].forEach(key => { sum[key] += stats[key]; });
      sum.problems.push(...stats.problems);
      return sum;
    }, { completed: 0, failed: 0, pending: 0, late: 0, problems: [] });
  }

  function renderStatusSummary(element, stats) {
    element.replaceChildren();
    element.append(
      node('span', 'status-pill success', 'Выполнено: ' + stats.completed),
      node('span', 'status-pill failed', 'Не выполнено: ' + stats.failed),
      node('span', 'status-pill pending', 'Без отметки: ' + stats.pending)
    );
    if (stats.late) element.append(node('span', 'status-pill late', 'С опозданием: ' + stats.late));
  }

  function renderAll() {
    const overall = totals();
    SECTIONS.forEach(section => setProgress('overall', section, sectionStats(section)));
    document.getElementById('overall-total').textContent = overall.completed + '/' + TOTAL_TASKS;
    renderStatusSummary(document.getElementById('overall-status-summary'), overall);

    const allPersonal = EMPLOYEES.map(employee => totals(employee.name));
    const failed = allPersonal.reduce((sum, stats) => sum + stats.failed, 0);
    const late = allPersonal.reduce((sum, stats) => sum + stats.late, 0);
    const pending = allPersonal.reduce((sum, stats) => sum + stats.pending, 0);
    document.getElementById('attention-summary').textContent =
      'В личных отчётах: ' + failed + ' не выполнено · ' + late + ' с опозданием · ' + pending + ' без отметки.';

    EMPLOYEES.forEach(renderEmployee);
    renderCustomers();
    if (activeEmployee && activeModal === 'detail-modal') renderDetails(activeEmployee);
  }

  function renderEmployee(employee) {
    const stats = totals(employee.name);
    document.getElementById(employee.key + '-card').setAttribute('aria-label',
      employee.name + ': выполнено ' + stats.completed + ' из ' + TOTAL_TASKS +
      ', не выполнено ' + stats.failed + ', без отметки ' + stats.pending + '. Открыть личный отчёт.');
    SECTIONS.forEach(section => setProgress(employee.key, section, sectionStats(section, employee.name)));
    document.getElementById(employee.key + '-total').textContent = stats.completed + '/' + TOTAL_TASKS;
    renderStatusSummary(document.getElementById(employee.key + '-status-summary'), stats);

    const container = document.getElementById(employee.key + '-incomplete');
    container.replaceChildren();
    const problems = stats.problems.slice().sort((a, b) => Number(b.failed) - Number(a.failed));
    if (problems.length) {
      container.append(node('div', 'incomplete-header', 'Требуют внимания: ' + problems.length));
      problems.slice(0, 3).forEach(problem => {
        container.append(node('div', 'incomplete-item',
          (problem.failed ? 'Не выполнено: ' : 'Нет отметки: ') + problem.task.name));
      });
      if (problems.length > 3) container.append(node('p', 'card-more', 'Ещё ' + (problems.length - 3) + ' — в подробном отчёте'));
    } else {
      container.append(node('div', 'incomplete-header all-done', 'Все личные задачи выполнены'));
    }

    const arrive = entryFor(employee.name, '_arrive');
    const leave = entryFor(employee.name, '_leave');
    const workStatus = document.getElementById(employee.key + '-work-status');
    workStatus.replaceChildren();
    workStatus.append(node('div', 'work-status-row ' + (arrive ? 'arrived' : 'not-yet'),
      arrive ? 'Приход: ' + (arrive.timeStr || displayTime(arrive.completedAt)) : 'Приход не отмечен'));
    let leaveText = 'Уход не отмечен';
    if (leave) leaveText = 'Уход: ' + (leave.timeStr || displayTime(leave.completedAt));
    else if (arrive && selectedDate === today()) leaveText = 'На работе · уход не отмечен';
    workStatus.append(node('div', 'work-status-row ' + (leave ? 'left' : 'not-yet'), leaveText));
  }

  function renderCustomers() {
    const list = document.getElementById('customers-log');
    const logs = dayData.customersLog.slice().sort((a, b) =>
      (Date.parse(b.timestamp || b.eventTime) || 0) - (Date.parse(a.timestamp || a.eventTime) || 0));
    document.getElementById('customers-count').textContent = String(logs.length);
    list.replaceChildren();
    if (!logs.length) {
      list.append(node('li', 'empty-state', 'За эту дату отметок о покупателях нет.'));
      return;
    }
    logs.forEach(log => {
      const row = node('li', 'journal-entry');
      row.append(node('span', 'journal-employee', log.employee || 'Сотрудник'),
        node('span', 'journal-time', log.timeStr || displayTime(log.timestamp || log.eventTime)));
      list.append(row);
    });
  }

  function renderDetails(employee) {
    document.getElementById('detail-title').textContent = employee.name + ' · ' + displayDate(selectedDate);
    const container = document.getElementById('detail-tasks');
    container.replaceChildren();
    SECTIONS.forEach(section => {
      container.append(node('h3', 'detail-section-title', SECTION_NAMES[section]));
      TASKS[section].forEach(task => {
        const entry = entryFor(employee.name, task.id);
        const kind = !entry ? 'pending' : entry.isFailed ? 'failed' : entry.isLate ? 'late' : 'success';
        const symbols = { pending: '○', failed: '×', late: '!', success: '✓' };
        const labels = { pending: 'Нет отметки', failed: 'Не выполнено', late: 'Выполнено с опозданием', success: 'Выполнено' };
        const row = node('div', 'detail-task');
        const icon = node('span', 'status-symbol ' + kind, symbols[kind]);
        icon.setAttribute('aria-hidden', 'true');
        const info = node('div', 'detail-task-info');
        info.append(node('div', 'detail-task-name', task.name));
        info.append(node('div', 'detail-task-meta ' + kind, labels[kind] +
          (entry ? ' · ' + (entry.timeStr || displayTime(entry.completedAt)) : '')));
        if (entry && entry.isFailed) info.append(node('p', 'detail-reason', 'Причина: ' + (entry.reason || 'не указана')));
        row.append(icon, info);
        container.append(row);
      });
    });
  }

  function openModal(id, employee) {
    if (activeModal) closeModal(false);
    returnFocus = document.activeElement;
    activeModal = id;
    activeEmployee = employee || null;
    if (employee) renderDetails(employee);
    const modal = document.getElementById(id);
    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');
    document.querySelector('.admin-page').inert = true;
    document.body.classList.add('modal-open');
    history.pushState({ checklistModal: id }, '');
    modal.querySelector('button').focus();
  }

  function closeModal(goBack = true) {
    if (!activeModal) return;
    const id = activeModal;
    const modal = document.getElementById(id);
    activeModal = null;
    activeEmployee = null;
    document.querySelector('.admin-page').inert = false;
    document.body.classList.remove('modal-open');
    if (returnFocus && returnFocus.isConnected) returnFocus.focus();
    returnFocus = null;
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
    if (goBack && history.state && history.state.checklistModal === id) history.back();
  }

  function updateDateDisplay() {
    document.getElementById('selected-date').textContent = '📅 ' + displayDate(selectedDate);
    document.getElementById('today-btn').classList.toggle('active', selectedDate === today());
    document.getElementById('yesterday-btn').classList.toggle('active', selectedDate === yesterday());
    document.getElementById('today-btn').setAttribute('aria-pressed', String(selectedDate === today()));
    document.getElementById('yesterday-btn').setAttribute('aria-pressed', String(selectedDate === yesterday()));
    document.getElementById('date-picker').value = selectedDate;
    document.getElementById('date-picker').max = today();
  }

  function selectDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value > today()) return;
    selectedDate = value;
    updateDateDisplay();
    loadDayData();
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!Auth.requireAuth('admin')) return;
    selectedDate = today();
    updateDateDisplay();
    document.getElementById('today-btn').addEventListener('click', () => selectDate(today()));
    document.getElementById('yesterday-btn').addEventListener('click', () => selectDate(yesterday()));
    document.getElementById('date-picker').addEventListener('change', event => selectDate(event.target.value));
    document.getElementById('refresh-btn').addEventListener('click', loadDayData);
    document.getElementById('logout-btn').addEventListener('click', () => Auth.logout());

    EMPLOYEES.forEach(employee => {
      const card = document.getElementById(employee.key + '-card');
      if (!card) return;
      card.addEventListener('click', () => openModal('detail-modal', employee));
      card.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openModal('detail-modal', employee);
        }
      });
    });
    document.getElementById('show-instructions-btn').addEventListener('click', () => openModal('instructions-modal'));
    ['detail', 'instructions'].forEach(name => {
      document.getElementById(name + '-close').addEventListener('click', () => closeModal());
      document.getElementById(name + '-modal').addEventListener('click', event => {
        if (event.target.id === name + '-modal') closeModal();
      });
    });
    document.addEventListener('keydown', event => {
      if (!activeModal) return;
      if (event.key === 'Escape') { event.preventDefault(); closeModal(); }
      if (event.key === 'Tab') {
        const focusable = [...document.getElementById(activeModal).querySelectorAll('button, a[href], input, textarea, [tabindex="0"]')]
          .filter(element => !element.disabled && !element.hidden);
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });
    window.addEventListener('popstate', () => closeModal(false));

    const updateNetwork = () => document.getElementById('offline-banner').classList.toggle('visible', !navigator.onLine);
    updateNetwork();
    window.addEventListener('offline', updateNetwork);
    window.addEventListener('online', () => { updateNetwork(); loadDayData(); });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { updateDateDisplay(); loadDayData(); }
    });
    loadDayData();
    setInterval(() => { if (!document.hidden) { updateDateDisplay(); loadDayData(); } }, CONFIG.ADMIN_REFRESH_INTERVAL);
  });
})();
