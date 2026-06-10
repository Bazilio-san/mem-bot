// Тесты ядра заметок (src/notes/store.js): CRUD, мягкое удаление с восстановлением, изоляция
// пользователей, лента с курсорной пагинацией и гибридный поиск (вектор + полнотекст + RRF).
// БД реальная (нужны pgvector и сгенерированный search_tsv); эмбеддинги подменяются детерминированной
// заглушкой через __setEmbedForTests, чтобы тест не ходил в LLM-провайдер и был воспроизводимым.
// Запуск: npm run test:notes-store (перед первым запуском — npm run migrate).
import assert from 'node:assert/strict';
import { query, closePool } from '../src/db.js';
import { ensureUser } from '../src/repo.js';
import {
  __setEmbedForTests,
  createNote,
  getNote,
  updateNote,
  deleteNote,
  restoreNote,
  listNotes,
  searchNotesForLlm,
  NOTE_BODY_MAX,
} from '../src/notes/store.js';

// Детерминированная замена эмбеддингов: ключевое слово в тексте задаёт ось единичного вектора.
// Тексты со словами одной оси получают одинаковый вектор (косинусное расстояние 0), разных осей —
// ортогональные (расстояние 1, выше порога 0.6 — не совпадение). «котлета» и «шницель» сидят на одной
// оси: это имитация смысловой близости лексически разных слов. Слово «безэмбеддинга» имитирует сбой
// провайдера эмбеддингов.
const AXES = [['котлета', 'шницель'], ['отпуск'], ['сервер'], ['гитара']];
function fakeEmbed(text) {
  if (text.includes('безэмбеддинга')) {
    return null;
  }
  const t = text.toLowerCase();
  const idx = AXES.findIndex((words) => words.some((w) => t.includes(w)));
  const vec = Array.from({ length: 1536 }, () => 0);
  vec[idx >= 0 ? idx : AXES.length] = 1;
  return vec;
}
__setEmbedForTests(async (text) => fakeEmbed(text));

async function freshUser(extId) {
  await query('DELETE FROM mem.users WHERE external_id = $1', [extId]);
  return ensureUser(extId);
}

const u = await freshUser('notes-store-test-main');
const stranger = await freshUser('notes-store-test-stranger');

// ---- 1. Валидация входных данных --------------------------------------------
await assert.rejects(createNote({ userId: u.id, body: '   ' }), /не может быть пустым/);
await assert.rejects(createNote({ userId: u.id, body: 'x'.repeat(NOTE_BODY_MAX + 1) }), /длиннее/);
await assert.rejects(createNote({ userId: u.id, body: 'ок', tags: 'не массив' }), /массивом строк/);

// Теги нормализуются: обрезка пробелов, нижний регистр, удаление дублей и пустых.
const tagged = await createNote({ userId: u.id, body: 'Заметка про теги', tags: [' Работа ', 'работа', '', 'Дом'] });
assert.deepEqual(tagged.tags, ['работа', 'дом']);

// ---- 2. CRUD и изоляция пользователей ----------------------------------------
const n1 = await createNote({ userId: u.id, title: 'Рецепт', body: 'Как пожарить котлета вкусно', tags: ['еда'] });
assert.ok(Number(n1.id) > 0, 'заметка получила числовой id');
assert.equal(n1.title, 'Рецепт');

const fetched = await getNote({ userId: u.id, id: n1.id });
assert.equal(fetched.body, 'Как пожарить котлета вкусно');
assert.equal(await getNote({ userId: stranger.id, id: n1.id }), null, 'чужая заметка не читается');

// Частичное обновление: меняется только заголовок, тело нетронуто, changed отражает суть.
const upd = await updateNote({ userId: u.id, id: n1.id, title: 'Рецепт котлет' });
assert.deepEqual(upd.changed, ['title']);
assert.equal(upd.note.title, 'Рецепт котлет');
assert.equal(upd.note.body, 'Как пожарить котлета вкусно');

// Обновление без фактических изменений ничего не пишет.
const noop = await updateNote({ userId: u.id, id: n1.id, title: 'Рецепт котлет' });
assert.deepEqual(noop.changed, []);

// Пин.
const pinned = await updateNote({ userId: u.id, id: n1.id, pinned: true });
assert.deepEqual(pinned.changed, ['pinned']);
assert.equal(pinned.note.pinned, true);

// Чужое обновление и удаление невозможны.
assert.equal(await updateNote({ userId: stranger.id, id: n1.id, title: 'взлом' }), null);
assert.equal(await deleteNote({ userId: stranger.id, id: n1.id }), null);

// ---- 3. Мягкое удаление и восстановление -------------------------------------
const victim = await createNote({ userId: u.id, body: 'Заметка на удаление' });
assert.ok(await deleteNote({ userId: u.id, id: victim.id }));
assert.equal(await getNote({ userId: u.id, id: victim.id }), null, 'удалённая не видна');
assert.equal(await deleteNote({ userId: u.id, id: victim.id }), null, 'повторное удаление — no-op');

const restored = await restoreNote({ userId: u.id, id: victim.id });
assert.equal(restored.body, 'Заметка на удаление');
assert.ok(await getNote({ userId: u.id, id: victim.id }), 'после восстановления снова видна');
assert.equal(await restoreNote({ userId: u.id, id: victim.id }), null, 'restore неудалённой — no-op');

// ---- 4. Лента: сортировка и курсорная пагинация -------------------------------
const feedUser = await freshUser('notes-store-test-feed');
const created = [];
for (let i = 0; i < 7; i++) {
  created.push(await createNote({ userId: feedUser.id, title: `Заметка ${i}`, body: `Тело ${i}` }));
}
await updateNote({ userId: feedUser.id, id: created[2].id, pinned: true });

const page1 = await listNotes({ userId: feedUser.id, limit: 3 });
assert.equal(page1.total, 7);
assert.equal(page1.items.length, 3);
assert.equal(String(page1.items[0].id), String(created[2].id), 'закреплённая заметка первая');
assert.ok(page1.nextCursor, 'есть курсор продолжения');

const page2 = await listNotes({ userId: feedUser.id, limit: 3, cursor: page1.nextCursor });
const page3 = await listNotes({ userId: feedUser.id, limit: 3, cursor: page2.nextCursor });
assert.equal(page3.nextCursor, null, 'последняя страница без курсора');
const allIds = [...page1.items, ...page2.items, ...page3.items].map((n) => String(n.id));
assert.equal(new Set(allIds).size, 7, 'страницы покрывают все заметки без дублей');

// Битый курсор не валит выборку, а просто читается как первая страница.
const badCursor = await listNotes({ userId: feedUser.id, limit: 3, cursor: 'мусор' });
assert.equal(badCursor.items.length, 3);

// ---- 5. Гибридный поиск --------------------------------------------------------
const sUser = await freshUser('notes-store-test-search');
const meat = await createNote({ userId: sUser.id, title: 'Ужин', body: 'Пожарить котлета на сковороде' });
await createNote({ userId: sUser.id, title: 'Поездка', body: 'Спланировать отпуск на море' });
const report = await createNote({
  userId: sUser.id,
  title: 'Работа',
  body: 'Подготовить квартальный отчёт безэмбеддинга',
});
await createNote({ userId: stranger.id, title: 'Чужое', body: 'Чужая котлета не должна найтись' });

// 5a. Семантика: запрос с тем же «вектором», но другой формулировкой — находится только нужная заметка.
const semantic = await listNotes({ userId: sUser.id, q: 'жареная котлета' });
assert.equal(semantic.items.length, 1, 'семантический поиск нашёл ровно одну заметку');
assert.equal(String(semantic.items[0].id), String(meat.id));
assert.ok(semantic.items[0].relevance > 0, 'у результата есть оценка релевантности');

// 5b. Полнотекст с морфологией: заметка без эмбеддинга (сбой провайдера) находится по слову «отчёт»,
// хотя в тексте оно стоит в другой форме («отчёт» в им. падеже здесь совпадает, проверяем стемминг запросом
// во множественном числе).
const fulltext = await listNotes({ userId: sUser.id, q: 'отчёты безэмбеддинга' });
assert.equal(fulltext.items.length, 1, 'полнотекстовая ветка спасает заметку без эмбеддинга');
assert.equal(String(fulltext.items[0].id), String(report.id));

// 5c. RRF: заметка, найденная обеими ветками (вектор + полнотекст), ранжируется выше чисто векторного
// совпадения. «Шницель» смыслово близок запросу «котлета» (одна ось заглушки), но слова «котлета» в его
// тексте нет — полнотекстовая ветка находит только заметку про котлету, и RRF поднимает её наверх
// независимо от порядка кандидатов внутри векторной ветки (там у обеих расстояние 0).
const schnitzel = await createNote({ userId: sUser.id, body: 'Шницель на сковороде' });
const fused = await listNotes({ userId: sUser.id, q: 'котлета' });
const fusedIds = fused.items.map((n) => String(n.id));
assert.ok(fusedIds.includes(String(meat.id)) && fusedIds.includes(String(schnitzel.id)), 'найдены обе заметки');
assert.equal(String(fused.items[0].id), String(meat.id), 'двойное совпадение (вектор+текст) ранжируется выше');

// 5d. Изоляция: чужая «котлета» не попала в выдачу.
assert.ok(fused.items.every((n) => n.user_id === sUser.id));

// 5e. Фильтр по тегу в ленте.
await createNote({ userId: sUser.id, body: 'тегированная', tags: ['проект'] });
const byTag = await listNotes({ userId: sUser.id, tag: 'проект' });
assert.equal(byTag.items.length, 1);
assert.equal(byTag.total, 1, 'total учитывает фильтр по тегу');

// ---- 6. Компактная выдача для LLM ---------------------------------------------
const llmUser = await freshUser('notes-store-test-llm');
await createNote({ userId: llmUser.id, title: 'Длинная', body: `котлета ${'x'.repeat(500)}` });
const llmRes = await searchNotesForLlm({ userId: llmUser.id, q: 'котлета' });
assert.equal(llmRes.items.length, 1);
assert.ok(llmRes.items[0].snippet.length <= 301, 'сниппет обрезан');
assert.ok(llmRes.items[0].snippet.endsWith('…'));
assert.equal(typeof llmRes.items[0].id, 'number');

__setEmbedForTests(null);
await closePool();
console.log('notes-store.test.mjs: ok');
