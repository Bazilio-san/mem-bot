# Explained: Proactive Behavior

The bot can initiate contact only when there is both a useful candidate and permission from the contact policy.

## Mental Model

Triggers create reasons to write. The contact policy decides whether writing now is acceptable. The message generator
turns the selected reason into a short first message. The channel adapter delivers it.

## Candidate Sources

- Inactivity and daily check-in triggers.
- Goal reminders and user-requested reminders.
- Welcome-back moments after a meaningful absence.
- External events that pass relevance filtering.

## Anti-Spam Model

Soft proactive contact is limited by pauses, daily and weekly caps, and quiet periods after ignored messages. Explicit
user-requested reminders are treated differently from soft contact but still have their own safeguards.

## Code References

- Trigger logic: `../../../../src/pipeline/proactive.js`
- Contact policy: `../../../../src/pipeline/proactiveContactPolicy.js`
- Message generation: `../../../../src/pipeline/proactiveMessage.js`
- External events: `../../../../src/pipeline/events.js`
- Delivery: `../../../../src/telegram/bot.js`
- Concept docs: `../09-proactivity.md`
