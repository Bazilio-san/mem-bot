import { memorySearchTool } from './memory/memory-search.js';
import { schedulerCreateTaskTool } from './scheduler/scheduler_create_task.js';
import { schedulerListTasksTool } from './scheduler/scheduler_list_tasks.js';
import { secureRecordGetTool } from './secure-record-get.js';
import { memoryListTool } from './memory/memory-list.js';
import { memoryForgetEntityTool } from './memory/memory-forget-entity.js';
import { memoryForgetAllTool } from './memory/memory-forget-all.js';
import { memoryPinTool } from './memory/memory-pin.js';
import { globalFactAddTool } from './global-fact/global-fact-add.js';
import { globalFactDeleteTool } from './global-fact/global-fact-delete.js';
import { globalFactListTool } from './global-fact/global-fact-list.js';
import { globalKnowledgeSearchTool } from './global-knowledge/global-knowledge-search.js';
import { globalKnowledgeAddTool } from './global-knowledge/global-knowledge-add.js';
import { globalKnowledgeDeleteTool } from './global-knowledge/global-knowledge-delete.js';
import { setReplyModeTool } from './voice/voice-or-text.js';
import { setVoicePreferenceTool } from './voice/voice-set-preference.js';
import { skillReadReferenceTool } from './skill-read-reference.js';
import { skillAuthorListTool } from './skill-authoring/skill-author-list.js';
import { skillAuthorReadTool } from './skill-authoring/skill-author-read.js';
import { skillAuthorCreateTool } from './skill-authoring/skill-author-create.js';
import { skillAuthorValidateTool } from './skill-authoring/skill-author-validate.js';
import { skillAuthorApplyTool } from './skill-authoring/skill-author-apply.js';
import { skillAuthorSetFieldTool } from './skill-authoring/skill-author-set-field.js';
import { skillAuthorWritePromptTool } from './skill-authoring/skill-author-write-prompt.js';
import { skillAuthorWriteExtractionTool } from './skill-authoring/skill-author-write-extraction.js';
import { skillAuthorAddReferenceTool } from './skill-authoring/skill-author-add-reference.js';
import { skillAuthorRemoveReferenceTool } from './skill-authoring/skill-author-remove-reference.js';
import { skillAuthorEnableTool } from './skill-authoring/skill-author-enable.js';
import { skillAuthorDisableTool } from './skill-authoring/skill-author-disable.js';
import { skillAuthorDeleteTool } from './skill-authoring/skill-author-delete.js';
import { skillAuthorReloadTool } from './skill-authoring/skill-author-reload.js';

export const allTools = [
  memorySearchTool,
  schedulerCreateTaskTool,
  schedulerListTasksTool,
  secureRecordGetTool,
  memoryListTool,
  memoryForgetEntityTool,
  memoryForgetAllTool,
  memoryPinTool,
  globalFactAddTool,
  globalFactDeleteTool,
  globalFactListTool,
  globalKnowledgeSearchTool,
  globalKnowledgeAddTool,
  globalKnowledgeDeleteTool,
  setReplyModeTool,
  setVoicePreferenceTool,
  skillReadReferenceTool,
  skillAuthorListTool,
  skillAuthorReadTool,
  skillAuthorCreateTool,
  skillAuthorValidateTool,
  skillAuthorApplyTool,
  skillAuthorSetFieldTool,
  skillAuthorWritePromptTool,
  skillAuthorWriteExtractionTool,
  skillAuthorAddReferenceTool,
  skillAuthorRemoveReferenceTool,
  skillAuthorEnableTool,
  skillAuthorDisableTool,
  skillAuthorDeleteTool,
  skillAuthorReloadTool,
];
