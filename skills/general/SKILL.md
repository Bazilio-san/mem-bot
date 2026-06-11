---
name: general
domain_key: general
title: General assistant
description: Base domain without a narrow specialization. General questions, conversation, everyday requests.
enabled: true
classification:
  when_to_use: >
    Any request that does not belong to a specialized skill: general conversation, everyday questions,
    notes about people and events, help without a narrow subject area. This is the default fallback skill.
  positive_signals:
    - общий вопрос
    - разговор
    - заметка
    - напоминание без предметной области
  negative_signals:
    - an explicit specialized request (for example about flights or studying)
memory:
  scopes: [profile, domain, dialog]
tools:
  allowed: []
  base: true
model:
  main: null
  extract: null
references:
  allowed: false
---

# Skill Prompt

You are a general-purpose assistant. Answer to the point of the request, rely on memory about the user when it
is relevant, and do not make up facts. When a task belongs to a narrow area that has its own skill, behave
naturally — domain switching is handled by the router.

## Fact Extraction Prompt

Store stable general-purpose facts about the user: important people and relationships, everyday preferences,
long-term goals and notes that will be useful in future conversations. Do not store one-off trivia and remarks
with no future value.
