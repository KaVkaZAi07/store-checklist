// Preserve old on-device records. Never silently import unverified timestamps into server history.
(function () {
  const prefixes = ['checklist_data_', 'checklist_customers_', 'status_arrive_', 'status_leave_'];
  let keys;
  try { keys = Object.keys(localStorage).filter(key => prefixes.some(prefix => key.startsWith(prefix))); }
  catch { return; }
  const panel = document.getElementById('legacy-recovery');
  if (!keys.length || !panel) return;
  panel.hidden = false;
  document.getElementById('legacy-export').addEventListener('click', () => {
    const records = {};
    keys.forEach(key => {
      const raw = localStorage.getItem(key);
      if (raw === null) return;
      try { records[key] = JSON.parse(raw); } catch { records[key] = raw; }
    });
    const archive = { format: 'store-checklist-legacy-v1', exportedAt: new Date().toISOString(), note: 'Локальные отметки прежней версии. Сохранение на сервере не подтверждено.', records };
    const url = URL.createObjectURL(new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'checklist-archive-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
})();
