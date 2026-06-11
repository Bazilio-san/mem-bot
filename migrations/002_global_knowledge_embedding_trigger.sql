-- Триггер целостности «текст ↔ эмбеддинг» для общей базы знаний (mem.global_knowledge).
-- Любое изменение title/content, в котором тем же UPDATE не передан новый вектор, обнуляет embedding:
-- устаревший вектор больше не описывает содержимое и не должен участвовать в семантическом поиске.
-- Это закрывает рассинхрон даже при правках в обход приложения (psql, скрипты, сторонний код) —
-- запись остаётся доступной через полнотекстовый фолбэк, а фоновая задача embedding_repair и админка
-- пересчитывают вектор заново. Если приложение пишет текст и свежий вектор одним UPDATE, сброса нет.
CREATE OR REPLACE FUNCTION mem.global_knowledge_reset_embedding()
RETURNS trigger AS $$
BEGIN
    IF (NEW.title IS DISTINCT FROM OLD.title OR NEW.content IS DISTINCT FROM OLD.content)
       AND NEW.embedding IS NOT DISTINCT FROM OLD.embedding THEN
        NEW.embedding := NULL;
    END IF;
    -- Заодно поддерживаем updated_at: до этого триггера колонку никто автоматически не обновлял.
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_global_knowledge_reset_embedding ON mem.global_knowledge;
CREATE TRIGGER trg_global_knowledge_reset_embedding
    BEFORE UPDATE ON mem.global_knowledge
    FOR EACH ROW
    EXECUTE FUNCTION mem.global_knowledge_reset_embedding();
