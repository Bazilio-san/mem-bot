# Перенос локальных баз на удалённый сервер (полная замена)

Эта инструкция описывает, как полностью заменить содержимое удалённых баз `mem_bot` и `mem_bot_logs`
на текущее состояние локальных баз. Старые данные на сервере при этом безвозвратно удаляются и
заменяются свежим дампом. Процедура повторяемая: выполняйте шаги по порядку.

## Когда применять

Когда нужно «залить» рабочее состояние локальной разработки на боевой сервер целиком, не сохраняя
ничего из того, что уже лежит на сервере. Это не инкрементальная синхронизация и не миграция схемы —
это полная перезапись обеих баз снимком локальных данных.

## Параметры подключения

Реальные значения хранятся в конфигурации и НЕ дублируются в этом документе:

- Локальный сервер PostgreSQL — параметры в `config/local.yaml`, секция `db.postgres.dbs`
  (по умолчанию `localhost:5432`, пользователь `postgres`, базы `mem_bot` и `mem_bot_logs`).
- Удалённый сервер PostgreSQL — параметры в `config/local-remote.yaml`, секция `db.postgres.dbs`
  (хост `77.73.132.128`, порт `5432`, пользователь `postgres`, те же имена баз).

Пароли возьмите из соответствующих файлов конфигурации. Команды ниже ожидают, что вы подставите
пароли в переменные окружения `PGPASSWORD` прямо перед запуском — в файлы их вписывать не нужно.

Удобно один раз задать переменные в текущей сессии оболочки (значения подставьте сами из конфигов):

```bash
LOCAL_PW='<пароль локальной БД из config/local.yaml>'
REMOTE_PW='<пароль удалённой БД из config/local-remote.yaml>'
RHOST=77.73.132.128
RUSER=postgres
```

## Предварительные проверки

1. Версии серверов могут различаться (на момент написания: локально PostgreSQL 16.6, удалённо
   PostgreSQL 14.13). Поэтому используется дамп в формате обычного SQL (plain), который надёжно
   загружается в более старый сервер. Бинарный формат `pg_dump -Fc` тут применять не нужно.
2. На удалённом сервере должно быть доступно расширение `vector` (pgvector) версии не ниже 0.5.0 —
   оно нужно для типа `vector(1536)` и индексов `hnsw`. Проверка:

   ```bash
   PGPASSWORD="$REMOTE_PW" psql -h "$RHOST" -U "$RUSER" -d postgres \
     -tAc "SELECT name, default_version FROM pg_available_extensions WHERE name IN ('vector','pgcrypto');"
   ```

   Сам дамп содержит `CREATE EXTENSION IF NOT EXISTS vector`, поэтому расширение установится в новую
   базу автоматически; важно лишь, чтобы оно было доступно для установки.

## Шаг 1. Снять дампы локальных баз

Дампы складываются в каталог `backups/` (он в `.gitignore`, поэтому данные не попадут в репозиторий).

```bash
cd /d/DEV/ss/mem-bot
TS=$(date +%Y%m%d-%H%M%S)
DUMPDIR="backups/remote-sync-$TS"
mkdir -p "$DUMPDIR"

PGPASSWORD="$LOCAL_PW" pg_dump -h localhost -U postgres --no-owner --no-privileges \
  -d mem_bot      -f "$DUMPDIR/mem_bot.sql"
PGPASSWORD="$LOCAL_PW" pg_dump -h localhost -U postgres --no-owner --no-privileges \
  -d mem_bot_logs -f "$DUMPDIR/mem_bot_logs.sql"

ls -la "$DUMPDIR"
```

Флаги `--no-owner` и `--no-privileges` убирают из дампа привязку к ролям и права доступа: на сервере
всё принадлежит пользователю `postgres`, лишние команды смены владельца только мешали бы.

## Шаг 2. Пересоздать удалённые базы (удаление старых данных)

Перед удалением базы нужно отключить все активные соединения с ней, иначе `DROP DATABASE` не пройдёт.
Если к серверу подключён работающий бот, на время операции его лучше остановить.

```bash
for db in mem_bot mem_bot_logs; do
  PGPASSWORD="$REMOTE_PW" psql -h "$RHOST" -U "$RUSER" -d postgres -v ON_ERROR_STOP=1 <<SQL
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
  WHERE datname='$db' AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS $db;
CREATE DATABASE $db;
SQL
done
```

## Шаг 3. Загрузить дампы на сервер

Загрузка идёт одной транзакцией (`--single-transaction`) с остановкой на первой ошибке
(`ON_ERROR_STOP=1`): либо база зальётся целиком, либо не изменится вовсе.

```bash
PGPASSWORD="$REMOTE_PW" psql -h "$RHOST" -U "$RUSER" -d mem_bot \
  -v ON_ERROR_STOP=1 --single-transaction -f "$DUMPDIR/mem_bot.sql"
PGPASSWORD="$REMOTE_PW" psql -h "$RHOST" -U "$RUSER" -d mem_bot_logs \
  -v ON_ERROR_STOP=1 --single-transaction -f "$DUMPDIR/mem_bot_logs.sql"
```

## Шаг 4. Проверить результат

Сверьте количество строк в ключевых таблицах локально и на сервере, а также наличие индексов `hnsw`.
Небольшое расхождение в журналах (`mem_bot_logs`) допустимо, если локальный бот продолжал писать логи
уже после снятия дампа.

```bash
Q="SELECT 'users='||(SELECT count(*) FROM mem.users)
       ||' facts='||(SELECT count(*) FROM mem.user_facts)
       ||' msg='||(SELECT count(*) FROM mem.conversation_messages)
       ||' notes='||(SELECT count(*) FROM mem.notes);"

echo -n 'LOCAL : '; PGPASSWORD="$LOCAL_PW"  psql -h localhost -U postgres -d mem_bot -tAc "$Q"
echo -n 'REMOTE: '; PGPASSWORD="$REMOTE_PW" psql -h "$RHOST"   -U "$RUSER"  -d mem_bot -tAc "$Q"

echo -n 'hnsw indexes remote: '
PGPASSWORD="$REMOTE_PW" psql -h "$RHOST" -U "$RUSER" -d mem_bot \
  -tAc "SELECT count(*) FROM pg_indexes WHERE indexdef ILIKE '%hnsw%';"
```

## Примечания

- Расширение `vector` на удалённом сервере установится в версии, доступной на сервере (например 0.5.1),
  даже если локально стоит более новая (например 0.8.0). Для текущей схемы (тип `vector(1536)` и
  индексы `hnsw` с `vector_cosine_ops`) версии 0.5.x достаточно.
- Чтобы бот на сервере работал с этими базами, на сервере должен быть выставлен `NODE_ENV=remote`
  (тогда подхватывается `config/local-remote.yaml`).
- Каталог `backups/remote-sync-*` с дампами можно удалить после успешной проверки — он нужен лишь как
  снимок на случай отката.
