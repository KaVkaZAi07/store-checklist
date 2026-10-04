// Тема доступна мышью, касанием и клавиатурой; отказ localStorage не блокирует приложение.
(function () {
  'use strict';
  const THEME_KEY = 'app-theme';
  let savedTheme = 'dark';
  try { savedTheme = localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'; } catch (_) {}

  function applyTheme(theme) {
    const light = theme === 'light';
    document.documentElement.classList.toggle('light-theme', light);
    document.documentElement.style.colorScheme = light ? 'light' : 'dark';
    const toggle = document.getElementById('theme-toggle');
    if (toggle) {
      toggle.setAttribute('role', 'switch');
      toggle.setAttribute('aria-label', 'Светлая тема');
      toggle.setAttribute('aria-checked', String(light));
      toggle.setAttribute('tabindex', '0');
    }
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.setAttribute('content', light ? '#F7F5F2' : '#080706');
  }

  function toggleTheme() {
    const theme = document.documentElement.classList.contains('light-theme') ? 'dark' : 'light';
    try { localStorage.setItem(THEME_KEY, theme); } catch (_) {}
    applyTheme(theme);
  }

  applyTheme(savedTheme);
  document.addEventListener('DOMContentLoaded', () => {
    applyTheme(savedTheme);
    const toggle = document.getElementById('theme-toggle');
    if (!toggle) return;
    toggle.addEventListener('click', toggleTheme);
    // Нативная кнопка сама преобразует Enter/Space в click.
    if (toggle.tagName !== 'BUTTON') {
      toggle.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          toggleTheme();
        }
      });
    }
  });
  window.addEventListener('storage', event => {
    if (event.key === THEME_KEY) applyTheme(event.newValue === 'light' ? 'light' : 'dark');
  });
})();
