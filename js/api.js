// Server RPCs own all writes. Offline data is a read-only snapshot.
const API = {
  _serverOffset: 0,
  _now() { return Date.now() + this._serverOffset; },
  _todayKey() { return new Date(this._now()).toLocaleDateString('sv-SE', { timeZone: CONFIG.TIMEZONE }); },
  _baseUrl() { return (CONFIG.SUPABASE_URL || '').replace(/\/+$/, ''); },
  _cachePrefix: 'checklist_v2_cache_',
  _boundToken: null,
  _session() {
    try { return JSON.parse(localStorage.getItem('checklist_session_v2') || 'null'); }
    catch { return null; }
  },
  _cacheKey(date) { return this._cachePrefix + (this._session()?.user?.key || 'none') + '_' + date; },
  _pendingVisitKey(date) { return 'checklist_pending_visit_' + (this._session()?.user?.key || '') + '_' + date; },
  _readCache(date) {
    try {
      const value = JSON.parse(localStorage.getItem(this._cacheKey(date)) || 'null');
      return value && value.date === date && value.tasks && Array.isArray(value.customersLog) ? value : null;
    } catch { return null; }
  },
  _writeCache(date, data) {
    try { localStorage.setItem(this._cacheKey(date), JSON.stringify(data)); } catch { /* Optional cache. */ }
  },
  clearCache() {
    try {
      Object.keys(localStorage).filter(k => k.startsWith(this._cachePrefix)).forEach(k => localStorage.removeItem(k));
    } catch { /* Storage may be unavailable. */ }
  },
  async _rpc(name, body) {
    if (!this._baseUrl() || !CONFIG.SUPABASE_ANON_KEY) throw new Error('Подключение к серверу не настроено. Обратитесь к владельцу.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(this._baseUrl() + '/rest/v1/rpc/' + name, {
        method: 'POST', cache: 'no-store', signal: controller.signal,
        headers: { apikey: CONFIG.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      let data;
      try { data = await response.json(); } catch { throw new Error('Сервер вернул некорректный ответ. Повторите позже.'); }
      if (!response.ok || data?.success === false) {
        const error = new Error(data?.error || (response.status === 404 ? 'Сервер ещё не настроен для этой версии. Обратитесь к владельцу.' : 'Сервер не подтвердил операцию. Повторите позже.'));
        error.code = data?.code || String(response.status);
        error.retryAfter = data?.retryAfter;
        throw error;
      }
      if (!data || typeof data !== 'object' || data.success !== true) throw new Error('Сервер не подтвердил операцию.');
      if (data.serverTime && Number.isFinite(Date.parse(data.serverTime))) this._serverOffset = Date.parse(data.serverTime) - Date.now();
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Сервер не ответил вовремя. Обновите данные перед повторной отметкой.');
      if (error instanceof TypeError) throw new Error('Нет связи с сервером. Отметка не подтверждена — проверьте подключение и обновите данные.');
      throw error;
    } finally { clearTimeout(timeout); }
  },
  async verifyPin(userKey, pin) { return this._rpc('checklist_login', { p_user_key: userKey, p_pin: pin }); },
  async _request(action, payload = {}) {
    const session = this._session();
    if (this._boundToken && session?.token !== this._boundToken) {
      const error = new Error('Профиль изменился в другой вкладке. Войдите снова.');
      error.code = 'SESSION_CHANGED';
      if (typeof window !== 'undefined') window.location.href = 'index.html';
      throw error;
    }
    if (!session?.token || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= Date.now()) {
      localStorage.removeItem('checklist_session_v2');
      this.clearCache();
      if (typeof window !== 'undefined') window.location.href = 'index.html';
      const error = new Error('Сессия завершилась. Войдите снова.');
      error.code = 'UNAUTHORIZED';
      throw error;
    }
    const token = session.token;
    try {
      const result = await this._rpc('checklist_request', { p_token: token, p_action: action, p_payload: payload });
      if (this._session()?.token !== token) {
        const error = new Error('Профиль изменился. Обновите страницу.');
        error.code = 'SESSION_CHANGED';
        throw error;
      }
      return result;
    } catch (error) {
      if (['UNAUTHORIZED', 'SESSION_EXPIRED', 'INVALID_SESSION'].includes(error.code)) {
        if (this._session()?.token !== token) { error.code = 'SESSION_CHANGED'; throw error; }
        localStorage.removeItem('checklist_session_v2');
        this.clearCache();
        if (typeof window !== 'undefined') window.location.href = 'index.html';
      }
      throw error;
    }
  },
  async getDayData(date) {
    try {
      const data = await this._request('get_day', { date });
      if (!data.tasks || typeof data.tasks !== 'object' || !Array.isArray(data.customersLog)) throw new Error('Неверный формат данных сервера.');
      try {
        const pendingKey = this._pendingVisitKey(date);
        const pendingId = localStorage.getItem(pendingKey);
        if (pendingId && data.customersLog.some(item => item.id === pendingId)) localStorage.removeItem(pendingKey);
      } catch { /* Optional retry bookkeeping. */ }
      const result = { ...data, date, source: 'server', stale: false, lastSyncedAt: new Date().toISOString() };
      this._writeCache(date, result);
      return result;
    } catch (error) {
      if (['UNAUTHORIZED', 'SESSION_EXPIRED', 'INVALID_SESSION', 'SESSION_CHANGED'].includes(error.code)) throw error;
      const cached = this._readCache(date);
      if (!cached) throw error;
      return { ...cached, source: 'cache', stale: true, error: error.message };
    }
  },
  async _mutate(action, payload, date) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('Нет подключения. Для сохранения отметки нужен интернет.');
    const result = await this._request(action, { ...payload, date: date || this._todayKey() });
    const savedDate = result.date || date || this._todayKey();
    const cached = this._readCache(savedDate);
    if (cached) {
      const employee = this._session()?.user?.name;
      const taskId = payload.taskId || (payload.status ? '_' + payload.status : null);
      if (action === 'undo_task' || action === 'undo_work_status') delete cached.tasks[employee + '_' + taskId];
      else if (taskId && result.entry) cached.tasks[employee + '_' + taskId] = result.entry;
      else if (action === 'log_customers' && result.entry && !cached.customersLog.some(item => item.id === result.entry.id)) cached.customersLog.push(result.entry);
      this._writeCache(savedDate, cached);
    }
    return result;
  },
  completeTask(employee, taskId, taskName, section, date) { return this._mutate('complete_task', { taskId }, date); },
  failTask(employee, taskId, taskName, section, reason, date) { return this._mutate('fail_task', { taskId, reason }, date); },
  undoTask(employee, taskId, section, date) { return this._mutate('undo_task', { taskId }, date); },
  logWorkStatus(employee, status, date) { return this._mutate('work_status', { status }, date); },
  undoWorkStatus(employee, status, date) { return this._mutate('undo_work_status', { status }, date); },
  async logCustomersEvent(employee, date) {
    const key = this._pendingVisitKey(date || this._todayKey());
    let eventId;
    try { eventId = localStorage.getItem(key); } catch { /* Optional storage. */ }
    if (!eventId) eventId = crypto.randomUUID();
    try { localStorage.setItem(key, eventId); } catch { /* Same request remains idempotent. */ }
    const result = await this._mutate('log_customers', { eventId }, date);
    try { if (localStorage.getItem(key) === eventId) localStorage.removeItem(key); } catch { /* Optional storage. */ }
    return result;
  },
  async logout(token) { if (token) return this._rpc('checklist_logout', { p_token: token }); }
};
