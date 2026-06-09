import { memorySearchTool } from './memory/memory-search.js';
import { schedulerCreateTaskTool } from './scheduler/scheduler_create_task.js';
import { schedulerListTasksTool } from './scheduler/scheduler_list_tasks.js';
import { secureRecordGetTool } from './secure-record-get.js';
import { memoryListTool } from './memory/memory-list.js';
import { memoryForgetEntityTool } from './memory/memory-forget-entity.js';
import { memoryForgetAllTool } from './memory/memory-forget-all.js';
import { globalFactAddTool } from './global-fact/global-fact-add.js';
import { globalFactDeleteTool } from './global-fact/global-fact-delete.js';
import { globalFactListTool } from './global-fact/global-fact-list.js';
import { globalKnowledgeSearchTool } from './global-knowledge/global-knowledge-search.js';
import { globalKnowledgeAddTool } from './global-knowledge/global-knowledge-add.js';
import { globalKnowledgeDeleteTool } from './global-knowledge/global-knowledge-delete.js';
import { setReplyModeTool } from './set-reply-mode.js';
import { setVoicePreferenceTool } from './set-voice-preference.js';
import { skillReadReferenceTool } from './skill-read-reference.js';

export const allTools = [
  memorySearchTool,
  schedulerCreateTaskTool,
  schedulerListTasksTool,
  secureRecordGetTool,
  memoryListTool,
  memoryForgetEntityTool,
  memoryForgetAllTool,
  globalFactAddTool,
  globalFactDeleteTool,
  globalFactListTool,
  globalKnowledgeSearchTool,
  globalKnowledgeAddTool,
  globalKnowledgeDeleteTool,
  setReplyModeTool,
  setVoicePreferenceTool,
  skillReadReferenceTool,
];
