-- migrations/004_outbox_notify.sql
-- Событийная доставка очереди: при вставке строки со статусом «pending» база сама посылает
-- уведомление PostgreSQL NOTIFY на канал «outbox_new». Адаптер слушает этот канал и опустошает
-- очередь немедленно, а не по таймеру. Полезная нагрузка уведомления — идентификатор записи:
-- для логики он не обязателен, но удобен при отладке и точечной доставке.
-- Идемпотентно: CREATE OR REPLACE FUNCTION и DROP TRIGGER IF EXISTS позволяют запускать повторно.

CREATE OR REPLACE FUNCTION mem.notify_outbox() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'pending' THEN
    PERFORM pg_notify('outbox_new', NEW.id::text);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notify_outbox ON mem.notification_outbox;
CREATE TRIGGER trg_notify_outbox
  AFTER INSERT ON mem.notification_outbox
  FOR EACH ROW EXECUTE FUNCTION mem.notify_outbox();
