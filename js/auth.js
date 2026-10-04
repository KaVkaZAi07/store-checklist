// Local session metadata is for navigation only; every API call verifies the token on the server.
const Auth = {
  SESSION_KEY: 'checklist_session_v2',
  getCurrentUser() {
    const session = API._session();
    const configured = CONFIG.USERS[session?.user?.key];
    if (!session?.token || !configured || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= Date.now()) return null;
    if (session.user.role !== configured.role || session.user.name !== configured.name) return null;
    return session.user;
  },
  async login(userKey, pin) {
    if (!CONFIG.USERS[userKey]) return { success: false, error: 'Выберите профиль.' };
    if (!/^\d{6,12}$/.test(pin)) return { success: false, error: 'Введите PIN из 6–12 цифр.' };
    try {
      const result = await API.verifyPin(userKey, pin);
      if (!result.token || !result.user || !result.expiresAt) throw new Error('Сервер не создал сессию.');
      API.clearCache();
      localStorage.setItem(this.SESSION_KEY, JSON.stringify({ token: result.token, user: result.user, expiresAt: result.expiresAt }));
      ['checklist_user_key', 'checklist_user_name', 'checklist_user_role'].forEach(k => localStorage.removeItem(k));
      window.location.href = result.user.role === 'admin' ? 'admin.html' : 'employee.html';
      return { success: true };
    } catch (error) { return { success: false, error: error.message || 'Не удалось войти. Повторите позже.' }; }
  },
  async logout() {
    const button = document.getElementById('logout-btn');
    if (button) { button.disabled = true; button.textContent = 'Выходим…'; }
    const session = API._session();
    localStorage.removeItem(this.SESSION_KEY);
    API.clearCache();
    ['checklist_user_key', 'checklist_user_name', 'checklist_user_role'].forEach(k => localStorage.removeItem(k));
    // Revoke online before leaving; expiry bounds an offline logout.
    try { await API.logout(session?.token); } catch { /* Local logout still takes effect. */ }
    window.location.href = 'index.html';
  },
  requireAuth(role) {
    const user = this.getCurrentUser();
    if (!user || (role && user.role !== role)) { window.location.replace('index.html'); return null; }
    API._boundToken = API._session().token;
    return user;
  },
  checkExistingSession() {
    const user = this.getCurrentUser();
    if (user) { window.location.replace(user.role === 'admin' ? 'admin.html' : 'employee.html'); return; }
    localStorage.removeItem(this.SESSION_KEY);
    this._setupLoginPage();
  },
  _setupLoginPage() {
    const modal = document.getElementById('pin-modal');
    if (!modal) return;
    const input = document.getElementById('pin-input');
    const error = document.getElementById('pin-error');
    const submit = document.getElementById('pin-submit');
    const close = document.getElementById('pin-close');
    let selected = null;
    let trigger = null;
    let busy = false;
    const update = () => {
      input.value = input.value.replace(/\D/g, '').slice(0, 12);
      document.getElementById('pin-length').textContent = input.value.length ? 'Введено цифр: ' + input.value.length : 'От 6 до 12 цифр';
      submit.disabled = busy || input.value.length < 6;
    };
    const setBusy = (value) => {
      busy = value;
      modal.setAttribute('aria-busy', String(value));
      modal.querySelectorAll('.keypad-btn').forEach(btn => btn.disabled = value);
      input.disabled = value;
      close.disabled = value;
      submit.textContent = value ? 'Проверяем…' : 'Войти';
      update();
    };
    const closeModal = () => {
      if (busy) return;
      modal.classList.remove('active');
      input.value = '';
      selected = null;
      trigger?.focus();
    };
    document.querySelectorAll('.user-btn').forEach(btn => btn.addEventListener('click', () => {
      trigger = btn;
      selected = btn.dataset.user;
      document.getElementById('pin-user-name').textContent = CONFIG.USERS[selected].name;
      input.value = '';
      error.textContent = '';
      error.classList.remove('visible');
      modal.classList.add('active');
      update();
      input.focus();
    }));
    close.addEventListener('click', closeModal);
    modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
    modal.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); closeModal(); }
      if (e.key === 'Enter' && e.target === input) { e.preventDefault(); submit.click(); }
      if (e.key === 'Tab') {
        const controls = [...modal.querySelectorAll('button:not(:disabled), input:not(:disabled)')].filter(el => el.offsetParent !== null);
        const first = controls[0], last = controls.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    });
    input.addEventListener('input', () => { error.classList.remove('visible'); update(); });
    modal.querySelectorAll('.keypad-btn').forEach(btn => {
      btn.setAttribute('aria-label', btn.dataset.val === 'backspace' ? 'Удалить цифру' : btn.dataset.val === 'clear' ? 'Очистить PIN' : btn.dataset.val);
      btn.addEventListener('click', () => {
        if (busy) return;
        input.value = btn.dataset.val === 'clear' ? '' : btn.dataset.val === 'backspace' ? input.value.slice(0, -1) : input.value + btn.dataset.val;
        update();
      });
    });
    submit.addEventListener('click', async () => {
      if (busy || !selected || input.value.length < 6) return;
      setBusy(true);
      const result = await this.login(selected, input.value);
      if (!result.success) {
        setBusy(false);
        error.textContent = result.error;
        error.classList.add('visible');
        input.value = '';
        update();
        input.focus();
      }
    });
    update();
  }
};

// A profile change in another tab must never leave the previous employee's screen active.
window.addEventListener('storage', event => {
  if (event.key === Auth.SESSION_KEY) window.location.replace('index.html');
});
