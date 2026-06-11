// UI-тест удаления пользователя и записи памяти со страницы «Память» админки (Playwright, без БД и бэкенда).
// Перед запуском собирается фронтенд (vite build), затем web/dist отдаётся локальным express-сервером,
// а все запросы к /api перехватываются заглушками прямо в браузере (page.route). Проверяется поведение
// интерфейса: кнопки удаления у строки пользователя и у записи памяти, диалоги-подтверждения, кнопки
// «Удалить»/«Отмена», флажки «Не напоминать в течение 1 минуты» (раздельное подавление диалогов через
// localStorage для пользователей и записей) и истечение срока подавления.
// Запуск: npm run test:admin-ui
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'web', 'dist');

// Ключи localStorage и длительность подавления — должны совпадать со значениями в web/src/App.vue.
const SUPPRESS_KEY = 'memAdmin.deleteUserConfirmSuppressedUntil';
const FACT_SUPPRESS_KEY = 'memAdmin.deleteFactConfirmSuppressedUntil';
const SUPPRESS_MS = 60 * 1000;

// ---- Мини-фреймворк проверок (как в остальных тестах проекта) ---------------
let passed = 0,
  failed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}
function section(title) {
  console.log(`\n=== ${title} ===`);
}

// ---- Заглушки данных ---------------------------------------------------------
const USERS = [
  { id: 'u-1', externalId: 'tg-1001', name: 'Анна', timezone: 'Europe/Moscow', isAdmin: false, memoryCount: 3 },
  { id: 'u-2', externalId: 'tg-1002', name: 'Борис', timezone: 'Europe/Moscow', isAdmin: false, memoryCount: 1 },
  { id: 'u-3', externalId: 'tg-1003', name: 'Вера', timezone: 'Europe/Moscow', isAdmin: true, memoryCount: 0 },
];
const EMPTY_MEMORY = { profile: [], dialog: [], domain: [], secure: [], reminder: [] };
// У Анны одна запись памяти — на ней проверяется диалог подтверждения удаления записи.
const ANNA_MEMORY = {
  ...EMPTY_MEMORY,
  profile: [{ id: 'f-1', kind: 'preference', text: 'Любит зелёный чай', confidence: 0.9 }],
};

// Журналы DELETE-запросов, дошедших до «сервера»: id удаляемых пользователей и пути удаляемых записей памяти.
const deleteCalls = [];
const factDeleteCalls = [];

// Навесить на страницу перехват всех запросов к /api с ответами-заглушками.
async function stubApi(page) {
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const json = (body, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (p === '/api/auth/me') {
      return json({ authenticated: true, authRequired: false, displayName: 'Тест-админ', botUsername: null });
    }
    if (p === '/api/users' && req.method() === 'GET') {
      return json(USERS);
    }
    const delMatch = p.match(/^\/api\/users\/([^/]+)$/);
    if (delMatch && req.method() === 'DELETE') {
      deleteCalls.push(decodeURIComponent(delMatch[1]));
      return json({ ok: true });
    }
    const factDelMatch = p.match(/^\/api\/users\/([^/]+)\/memory\/([^/]+)\/([^/]+)$/);
    if (factDelMatch && req.method() === 'DELETE') {
      factDeleteCalls.push(factDelMatch.slice(1).map(decodeURIComponent).join('/'));
      return json({ ok: true });
    }
    const memMatch = p.match(/^\/api\/users\/([^/]+)\/memory$/);
    if (memMatch && req.method() === 'GET') {
      return json(decodeURIComponent(memMatch[1]) === 'u-1' ? ANNA_MEMORY : EMPTY_MEMORY);
    }
    return json({ error: `Неожиданный запрос в тесте: ${req.method()} ${p}` }, 500);
  });
}

// Навести курсор на строку пользователя (кнопка удаления видима только при наведении) и нажать корзину.
async function clickDelete(page, userName) {
  const row = page.locator('.user-item', { hasText: userName });
  await row.hover();
  await row.locator('.user-delete').click();
}

const dialogSel = '.p-dialog';

async function main() {
  section('Сборка фронтенда и запуск статического сервера');
  execSync('npm run web:build', { cwd: rootDir, stdio: 'pipe' });
  check('Фронтенд собран (web/dist/index.html существует)', fs.existsSync(path.join(distDir, 'index.html')));

  const app = express();
  app.use(express.static(distDir));
  app.use((req, res) => res.sendFile(path.join(distDir, 'index.html')));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await stubApi(page);

  try {
    section('Кнопка удаления и диалог-предупреждение');
    await page.goto(baseUrl);
    await page.waitForSelector('.user-item');
    check('Список показывает всех пользователей заглушки', (await page.locator('.user-item').count()) === USERS.length);
    check(
      'У каждой строки пользователя есть кнопка удаления',
      (await page.locator('.user-item .user-delete').count()) === USERS.length,
    );

    section('Удаление записи памяти через диалог подтверждения');
    await page.locator('.user-item', { hasText: 'Анна' }).click();
    await page.waitForFunction(() => document.body.innerText.includes('Любит зелёный чай'));
    const factDeleteBtn = page.locator('button[aria-label="Удалить запись"]').first();
    await factDeleteBtn.click();
    await page.waitForSelector(dialogSel);
    const factDialogText = await page.locator(dialogSel).innerText();
    check('Диалог озаглавлен «Удаление записи памяти»', factDialogText.includes('Удаление записи памяти'));
    check('Диалог содержит текст удаляемой записи', factDialogText.includes('Любит зелёный чай'));
    check(
      'В диалоге записи есть флажок «Не напоминать в течение 1 минуты»',
      /Не напоминать в течение 1 минуты/.test(factDialogText),
    );

    await page.locator(`${dialogSel} button`, { hasText: 'Отмена' }).click();
    await page.waitForSelector(dialogSel, { state: 'detached' });
    check('После отмены DELETE-запрос на запись не отправлен', factDeleteCalls.length === 0);

    const tFactBefore = Date.now();
    await factDeleteBtn.click();
    await page.waitForSelector(dialogSel);
    await page.locator(`${dialogSel} label`, { hasText: 'Не напоминать' }).click();
    await page.locator(`${dialogSel} button`, { hasText: 'Удалить' }).click();
    await page.waitForSelector(dialogSel, { state: 'detached' });
    await page.waitForFunction(() => !document.body.innerText.includes('Любит зелёный чай'));
    check(
      'DELETE-запрос отправлен на нужную запись памяти',
      factDeleteCalls.length === 1 && factDeleteCalls[0] === 'u-1/profile/f-1',
    );
    const factStoredUntil = Number(await page.evaluate((k) => localStorage.getItem(k), FACT_SUPPRESS_KEY));
    check(
      'Флажок записал срок подавления для записей ≈ сейчас + 1 минута',
      factStoredUntil >= tFactBefore + SUPPRESS_MS && factStoredUntil <= Date.now() + SUPPRESS_MS,
      `записано ${factStoredUntil}`,
    );
    check(
      'Подавление для записей не затрагивает ключ подавления для пользователей',
      (await page.evaluate((k) => localStorage.getItem(k), SUPPRESS_KEY)) === null,
    );

    section('Диалог удаления пользователя');
    await clickDelete(page, 'Анна');
    await page.waitForSelector(dialogSel);
    const dialogText = await page.locator(dialogSel).innerText();
    check('Диалог содержит имя пользователя', dialogText.includes('Анна'));
    check(
      'Диалог предупреждает о каскадном удалении и сохранении журналов',
      /безвозвратно/.test(dialogText) && /Журналы/.test(dialogText) && /сохранятся/.test(dialogText),
    );
    check(
      'В диалоге есть флажок «Не напоминать в течение 1 минуты»',
      /Не напоминать в течение 1 минуты/.test(dialogText),
    );

    section('Отмена удаления');
    await page.locator(`${dialogSel} button`, { hasText: 'Отмена' }).click();
    await page.waitForSelector(dialogSel, { state: 'detached' });
    check('После отмены DELETE-запрос не отправлен', deleteCalls.length === 0);
    check('После отмены пользователь остался в списке', (await page.locator('.user-item').count()) === USERS.length);

    section('Подтверждение удаления без флажка');
    await clickDelete(page, 'Анна');
    await page.waitForSelector(dialogSel);
    await page.locator(`${dialogSel} button`, { hasText: 'Удалить' }).click();
    await page.waitForSelector(dialogSel, { state: 'detached' });
    await page.waitForFunction(() => document.querySelectorAll('.user-item').length === 2);
    check('DELETE-запрос отправлен на нужного пользователя', deleteCalls.length === 1 && deleteCalls[0] === 'u-1');
    check('Пользователь исчез из списка', !(await page.locator('.user-item').allInnerTexts()).join().includes('Анна'));
    const storedAfterPlain = await page.evaluate((k) => localStorage.getItem(k), SUPPRESS_KEY);
    check('Без флажка подавление в localStorage не записывается', storedAfterPlain === null);

    section('Удаление выбранного пользователя с флажком «не напоминать»');
    await page.locator('.user-item', { hasText: 'Борис' }).click();
    await page.waitForFunction(() => !document.body.innerText.includes('Загрузка памяти пользователя'));
    const tBefore = Date.now();
    await clickDelete(page, 'Борис');
    await page.waitForSelector(dialogSel);
    await page.locator(`${dialogSel} label`, { hasText: 'Не напоминать' }).click();
    await page.locator(`${dialogSel} button`, { hasText: 'Удалить' }).click();
    await page.waitForSelector(dialogSel, { state: 'detached' });
    await page.waitForFunction(() => document.querySelectorAll('.user-item').length === 1);
    check('DELETE-запрос отправлен на выбранного пользователя', deleteCalls.length === 2 && deleteCalls[1] === 'u-2');
    check(
      'Правая панель вернулась к подсказке после удаления выбранного пользователя',
      (await page.locator('.main').innerText()).includes('Выберите пользователя слева'),
    );
    const storedUntil = Number(await page.evaluate((k) => localStorage.getItem(k), SUPPRESS_KEY));
    check(
      'Флажок записал срок подавления ≈ сейчас + 1 минута',
      storedUntil >= tBefore + SUPPRESS_MS && storedUntil <= Date.now() + SUPPRESS_MS,
      `записано ${storedUntil}`,
    );

    section('Пока подавление активно, диалог не показывается');
    await clickDelete(page, 'Вера');
    // Удаление должно пройти сразу, без диалога: дожидаемся ухода строки и проверяем, что диалога не было.
    await page.waitForFunction(() => document.querySelectorAll('.user-item').length === 0);
    check('DELETE-запрос ушёл сразу, без диалога', deleteCalls.length === 3 && deleteCalls[2] === 'u-3');
    check('Диалог при активном подавлении не открывался', (await page.locator(dialogSel).count()) === 0);

    section('Истёкшее подавление снова требует подтверждения');
    await page.evaluate((k) => localStorage.setItem(k, String(Date.now() - 1000)), SUPPRESS_KEY);
    await page.goto(baseUrl); // перезагрузка: заглушка снова отдаёт полный список пользователей
    await page.waitForSelector('.user-item');
    await clickDelete(page, 'Анна');
    await page.waitForSelector(dialogSel);
    check('После истечения срока диалог подтверждения показывается снова', true);
    await page.locator(`${dialogSel} button`, { hasText: 'Отмена' }).click();
    check('Отмена после истечения срока не отправляет DELETE', deleteCalls.length === 3);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }

  console.log(`\nИтого: ✅ ${passed}, ❌ ${failed}`);
  if (failed > 0) {
    console.log('Провалены: ' + failures.join('; '));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Ошибка UI-теста:', err);
  process.exitCode = 1;
});
