import { memorySearchTool } from './memory-search.js';
import { schedulerCreateTaskTool } from './scheduler-create-task.js';
import { secureRecordGetTool } from './secure-record-get.js';
import { searchFlightsTool } from './search-flights.js';
import { memoryListTool } from './memory-list.js';
import { memoryForgetEntityTool } from './memory-forget-entity.js';
import { memoryForgetAllTool } from './memory-forget-all.js';
import { globalFactAddTool } from './global-fact-add.js';
import { globalFactDeleteTool } from './global-fact-delete.js';
import { globalFactListTool } from './global-fact-list.js';
import { globalKnowledgeSearchTool } from './global-knowledge-search.js';
import { globalKnowledgeAddTool } from './global-knowledge-add.js';
import { globalKnowledgeDeleteTool } from './global-knowledge-delete.js';
import { setReplyModeTool } from './set-reply-mode.js';

export const allTools = [
  memorySearchTool,
  schedulerCreateTaskTool,
  secureRecordGetTool,
  searchFlightsTool,
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
];
