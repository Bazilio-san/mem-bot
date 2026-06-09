-- migrations/016_voice_preference.sql
-- Пользовательский выбор тембра голосового ответа. NULL означает глобальный fallback VOICE_OUTPUT_VOICE.
ALTER TABLE mem.users
  ADD COLUMN IF NOT EXISTS voice_output_voice text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE connamespace = 'mem'::regnamespace
       AND conname = 'users_voice_output_voice_check'
  ) THEN
    ALTER TABLE mem.users
      ADD CONSTRAINT users_voice_output_voice_check
      CHECK (
        voice_output_voice IS NULL
        OR voice_output_voice IN (
          'alloy', 'ash', 'ballad', 'cedar', 'coral', 'marin',
          'nova', 'fable', 'onyx', 'sage', 'verse'
        )
      );
  END IF;
END $$;
