import { test, expect } from '@playwright/test';
import { createTestDb } from '../../supabase/tests/helpers.mjs';
import { readFile } from 'node:fs/promises';

let fixture;
test.beforeEach(async () => { fixture = await createTestDb(); });
test.afterEach(async () => { await fixture.db.close(); });

async function connect(context, options = {}) {
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1') return route.continue();
    if (!url.pathname.startsWith('/rest/v1/rpc/')) return route.abort();
    const name = url.pathname.split('/').at(-1);
    const body = route.request().postDataJSON();
    if (options.offline) return route.abort('internetdisconnected');
    if (options.rejectWrites && name === 'checklist_request' && body.p_action !== 'get_day') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Запись отклонена сервером' }) });
    const parameters = name === 'checklist_login' ? [body.p_user_key, body.p_pin]
      : name === 'checklist_logout' ? [body.p_token] : [body.p_token, body.p_action, JSON.stringify(body.p_payload)];
    if (!['checklist_login', 'checklist_logout', 'checklist_request'].includes(name)) return route.abort();
    const result = await fixture.rpc(name, parameters);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) });
  });
}
async function login(page, key = 'agnesa') {
  await page.goto('/');
  await page.locator('#btn-' + key).click();
  await page.getByRole('textbox', { name: 'PIN-код' }).fill(fixture.pins[key]);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page).toHaveURL(key === 'owner' ? /admin.html$/ : /employee.html$/);
  await expect(page.locator(key === 'owner' ? '#data-status' : '#sync-status')).toContainText(key === 'owner' ? 'Данные с сервера' : 'Данные обновлены');
}
async function noHorizontalOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

test('employee saves, reloads, undoes, reports failure and owner sees real SQL records', async ({ page, context, browser }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await connect(context);
  await login(page);
  await expect(page.locator('#leave-btn')).toBeDisabled();
  await expect(page.locator('#complete-m9')).toBeDisabled();
  await page.locator('#arrive-btn').click();
  await expect(page.locator('#arrive-btn')).toContainText('На работе с');
  await page.locator('#complete-m1').click();
  await expect(page.locator('#count-done')).toHaveText('1');
  await page.reload();
  await expect(page.locator('#undo-m1')).toBeVisible();
  await page.locator('#undo-m1').click();
  await expect(page.locator('#count-done')).toHaveText('0');
  const reason = '<img src=x onerror="window.xss=1"> Дверь заклинило';
  await page.locator('#fail-m1').click();
  await page.locator('#fail-reason').fill(reason);
  await page.locator('#fail-submit').click();
  await expect(page.locator('#count-failed')).toHaveText('1');
  await expect(page.locator('#count-done')).toHaveText('0');
  await expect(page.locator('#task-m1')).toContainText(reason);
  expect(await page.evaluate(() => window.xss)).toBeUndefined();
  await page.locator('#complete-m2').click();
  await page.locator('#customers-btn').click();
  await expect(page.locator('#customers-summary')).toContainText('1');
  await page.locator('#leave-btn').click();
  await expect(page.locator('#leave-btn')).toContainText('Смена завершена');
  await page.reload();
  await expect(page.locator('#count-failed')).toHaveText('1');
  await expect(page.locator('#count-done')).toHaveText('1');
  await noHorizontalOverflow(page);
  await page.screenshot({ path: 'artifacts/employee-mobile.png', fullPage: true });
  await page.getByRole('switch').click();
  await page.screenshot({ path: 'artifacts/employee-mobile-light.png', fullPage: true });
  const owner = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  try {
    await connect(owner);
    const admin = await owner.newPage();
    await login(admin, 'owner');
    await expect(admin.locator('#overall-total')).toHaveText('1/19');
    await expect(admin.locator('#agnesa-total')).toHaveText('1/19');
    await expect(admin.locator('#customers-count')).toHaveText('1');
    await expect(admin.locator('#agnesa-work-status')).toContainText('Уход:');
    await admin.locator('#agnesa-card').click();
    await expect(admin.locator('#detail-tasks')).toContainText(reason);
    expect(await admin.locator('#detail-tasks img').count()).toBe(0);
    await admin.getByRole('button', { name: 'Закрыть подробный отчёт' }).click();
    await noHorizontalOverflow(admin);
    await admin.evaluate(() => window.scrollTo(0, 0));
    await admin.screenshot({ path: 'artifacts/owner-desktop.png', fullPage: true });
    await admin.setViewportSize({ width: 390, height: 844 });
    await noHorizontalOverflow(admin);
    await admin.screenshot({ path: 'artifacts/owner-mobile.png', fullPage: true });
  } finally { await owner.close(); }
  expect(errors).toEqual([]);
});

test('failed write keeps task unmarked; cache is read only after connection loss', async ({ page, context }) => {
  const options = {};
  await connect(context, options);
  await login(page);
  options.rejectWrites = true;
  await page.locator('#complete-m1').click();
  await expect(page.locator('#toast')).toContainText('отклонена');
  await expect(page.locator('#count-done')).toHaveText('0');
  await expect(page.locator('#complete-m1')).toBeEnabled();
  options.rejectWrites = false;
  await page.locator('#complete-m1').click();
  await expect(page.locator('#count-done')).toHaveText('1');
  options.offline = true;
  await page.reload();
  await expect(page.locator('#sync-status')).toContainText('Сохранённая копия');
  await expect(page.locator('#count-done')).toHaveText('1');
  await expect(page.locator('#complete-m2')).toBeDisabled();
  await expect(page.locator('#customers-btn')).toBeDisabled();
  options.offline = false;
  await page.locator('#refresh-btn').click();
  await expect(page.locator('#complete-m2')).toBeEnabled();
});

test('confirmation unlocks only after eight morning decisions; undo is server timed', async ({ page, context }) => {
  await connect(context);
  await login(page);
  for (let i = 1; i <= 8; i++) {
    await page.locator('#complete-m' + i).click();
    await expect(page.locator('#count-done')).toHaveText(String(i));
  }
  await expect(page.locator('#complete-m9')).toBeEnabled();
  await page.locator('#complete-m9').click();
  await expect(page.locator('#count-done')).toHaveText('9');
  await expect(page.locator('#undo-m1')).toBeDisabled();
  await page.locator('#undo-m9').click();
  await expect(page.locator('#undo-m1')).toBeEnabled();
  await fixture.db.exec("UPDATE public.checklist_entries SET completed_at=clock_timestamp()-interval '2 minutes' WHERE task_id='m1'");
  await page.reload();
  await expect(page.locator('#task-m1')).toContainText('Выполнено');
  await expect(page.locator('#undo-m1')).toHaveCount(0);
});

test('wrong PIN stays on login, valid session logs out and cannot reopen admin', async ({ page, context }) => {
  await connect(context);
  await page.goto('/');
  await page.locator('#btn-owner').click();
  await page.getByRole('textbox', { name: 'PIN-код' }).fill('999999999999');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.locator('#pin-error')).toContainText('Неверный');
  await page.getByRole('textbox', { name: 'PIN-код' }).fill(fixture.pins.owner);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page).toHaveURL(/admin.html$/);
  await page.locator('#logout-btn').click();
  await expect(page).toHaveURL(/index.html$/);
  await page.goto('/admin.html');
  await expect(page).toHaveURL(/index.html$/);
});

test('legacy on-device history can be exported and survives a new login', async ({ page, context }) => {
  await connect(context);
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('checklist_data_2026-06-01', JSON.stringify({ 'Агнесса_m1': { employee: 'Агнесса', taskName: 'Историческая отметка' } })));
  await page.reload();
  await expect(page.locator('#legacy-recovery')).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать прежние отметки' }).click();
  const download = await downloaded;
  const archive = JSON.parse(await readFile(await download.path(), 'utf8'));
  expect(archive.format).toBe('store-checklist-legacy-v1');
  expect(archive.records['checklist_data_2026-06-01']['Агнесса_m1'].taskName).toBe('Историческая отметка');
  await login(page);
  expect(await page.evaluate(() => localStorage.getItem('checklist_data_2026-06-01'))).not.toBeNull();
});
