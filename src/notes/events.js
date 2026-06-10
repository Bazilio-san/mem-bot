// Meta-events of the notes widget in the LLM dialog history. Every successful mutation made through the
// widget REST API is recorded as a short system message in mem.conversation_messages — on the next turn
// the agent sees that the user created/edited/deleted a note, without the note data itself flooding the
// context. The widget-shown event is NOT written here: the text result of the notes_show_widget tool
// already lands in history through the regular tool-result flow.
import { saveMessage, ensureConversation } from '../repo.js';

const CHANGED_RU = {
  title: 'заголовок',
  body: 'текст',
  tags: 'теги',
  pinned: 'закрепление',
};

function noteLabel(note) {
  const title = String(note?.title || '').trim();
  return title ? `#${note.id} «${title}»` : `#${note?.id}`;
}

function eventText(action, note, changed) {
  switch (action) {
    case 'create':
      return `[notes] Пользователь создал заметку ${noteLabel(note)} через виджет.`;
    case 'update': {
      const what = changed.map((c) => CHANGED_RU[c] || c).join(', ');
      return `[notes] Пользователь отредактировал заметку ${noteLabel(note)} через виджет${what ? `: изменено — ${what}` : ''}.`;
    }
    case 'delete':
      return `[notes] Пользователь удалил заметку ${noteLabel(note)} через виджет.`;
    case 'restore':
      return `[notes] Пользователь восстановил удалённую заметку ${noteLabel(note)} через виджет.`;
    default:
      return `[notes] Действие ${action} с заметкой ${noteLabel(note)} через виджет.`;
  }
}

// Write a meta-event into the dialog history. conversationId comes from the widget token (the dialog the
// widget was shown in); when it is absent (Mini App opened from the chat menu) the user's active
// conversation is used. Never throws: a failed meta-event must not break the CRUD operation it describes.
export async function recordNoteEvent({ userId, conversationId = null, action, note, changed = [] }) {
  try {
    const convId = conversationId || (await ensureConversation(userId)).id;
    await saveMessage(convId, userId, 'system', eventText(action, note, changed), {
      metadata: {
        source: 'notes_widget',
        action,
        note_id: Number(note?.id) || null,
        ...(changed.length ? { changed } : {}),
      },
    });
  } catch (err) {
    console.error('notes: failed to record a widget meta-event:', err.message);
  }
}
