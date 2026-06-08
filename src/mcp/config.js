// src/mcp/config.js
// Список подключаемых MCP-серверов читается из JSON-файла в формате Claude Code (.mcp.json).
// Файл не под контролем версий (см. .gitignore): у каждого окружения он свой и может содержать секреты.
// Отсутствие файла или ошибка разбора не должны ронять процесс — в этом случае серверов просто нет.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Путь к файлу конфигурации. По умолчанию .mcp.json в корне проекта; можно переопределить переменной
// окружения MCP_CONFIG_PATH, если файл лежит в другом месте.
const CONFIG_PATH = resolve(process.cwd(), process.env.MCP_CONFIG_PATH || '.mcp.json');

// Привести одну запись из секции mcpServers формата Claude Code к внутреннему описанию сервера.
// Поддерживается только транспорт по HTTP (StreamableHTTP): для записи нужен url. Поля title,
// requiresAdmin и disabled — необязательные расширения; их нет в стандартном формате Claude Code.
function normalizeServer(alias, raw) {
  const type = raw.type || 'http';
  if (type !== 'http' && type !== 'sse') {
    console.error(`MCP «${alias}»: транспорт «${type}» не поддерживается (нужен http/sse). Пропускаю.`);
    return null;
  }
  if (!raw.url) {
    console.error(`MCP «${alias}»: не задан url. Пропускаю.`);
    return null;
  }
  return {
    alias,                                   // короткий префикс, попадёт в имена инструментов модели
    title: raw.title || alias,               // человекочитаемое имя для журналов и статусов
    url: raw.url,
    headers: raw.headers || null,            // заголовки транспорта — место для будущего токена авторизации
    enabled: raw.disabled !== true,          // совместимо с полем «disabled» из формата Claude Code
    requiresAdmin: raw.requiresAdmin === true,
  };
}

// Прочитать и разобрать .mcp.json. Любой сбой (нет файла, битый JSON, не тот формат) приводит к пустому
// списку серверов, а не к падению процесса. Содержательная причина пишется в журнал.
export function loadMcpServers() {
  let text;
  try {
    text = readFileSync(CONFIG_PATH, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];    // файла нет — это штатная ситуация, не ошибка
    console.error(`MCP: не удалось прочитать ${CONFIG_PATH}: ${err.message}. MCP-серверы отключены.`);
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    console.error(`MCP: ${CONFIG_PATH} содержит некорректный JSON: ${err.message}. MCP-серверы отключены.`);
    return [];
  }

  const servers = parsed && parsed.mcpServers;
  if (!servers || typeof servers !== 'object') {
    console.error(`MCP: в ${CONFIG_PATH} нет объекта «mcpServers». MCP-серверы отключены.`);
    return [];
  }

  return Object.entries(servers)
    .map(([alias, raw]) => normalizeServer(alias, raw))
    .filter(Boolean);
}
