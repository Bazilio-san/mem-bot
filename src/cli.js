// Interactive chat in the terminal. Connects to the whole memory pipeline.
// Run: npm run chat   (or: node src/cli.js [externalId] [domainKey])
import readline from 'node:readline';
import { handleMessage } from './agent.js';
import { tick } from './pipeline/scheduler.js';
import { closePool } from './db.js';
import { flushLlmLog } from './pipeline/llm-log.js';
import { flushAgentEventLog } from './pipeline/agent-event-log.js';
import { ensureUser } from './repo.js';
import { isAdmin } from './pipeline/admin.js';
import {
  addGlobalFact,
  deleteGlobalFact,
  listGlobalFacts,
  searchGlobalKnowledge,
  addGlobalKnowledge,
  deleteGlobalKnowledge,
} from './pipeline/global-memory.js';

const externalId = process.argv[2] || 'cli-user';
let domainKey = process.argv[3] || 'general';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

console.log(`Memory chatbot. User: ${externalId}, domain: ${domainKey}.`);
console.log('Commands: /domain <key> — switch domain, /tick — run the scheduler, /exit — quit.');
console.log(
  `Global memory (writing — admin only): /fact-add <text>, /fact-list, /fact-del <id>, /kb-add <text>, /kb-find <query>, /kb-del <id>.\n`,
);

// Check that the current user is an administrator. Returns the user id or null.
async function requireAdmin() {
  const user = await ensureUser(externalId);
  if (!(await isAdmin(user.id))) {
    console.log('This command is available to administrators only. Set the is_admin flag on the user in the database.');
    return null;
  }
  return user.id;
}

// Background scheduler pass every 10 seconds, so reminders actually fire.
const schedulerTimer = setInterval(async () => {
  try {
    const r = await tick();
    if (r.processed > 0) {
      console.log(`\n[scheduler] tasks processed: ${r.processed}\n> `);
    }
  } catch {
    /* ignore one-off errors of the background pass */
  }
}, 10000);

async function main() {
  while (true) {
    const input = (await ask('> ')).trim();
    if (!input) {
      continue;
    }
    if (input === '/exit') {
      break;
    }
    if (input.startsWith('/domain ')) {
      domainKey = input.slice(8).trim() || 'general';
      console.log(`Domain: ${domainKey}`);
      continue;
    }
    if (input === '/tick') {
      const r = await tick();
      console.log(`Tasks processed: ${r.processed}`);
      continue;
    }

    // --- Global facts (always-on, shared by everyone; writing admin-only) ---
    if (input.startsWith('/fact-add ')) {
      const adminId = await requireAdmin();
      if (!adminId) {
        continue;
      }
      const text = input.slice(10).trim();
      if (!text) {
        console.log('Provide the fact text: /fact-add <text>');
        continue;
      }
      const f = await addGlobalFact({ factText: text, createdBy: adminId });
      console.log(`Global fact added. Id: ${f.id}`);
      continue;
    }
    if (input === '/fact-list') {
      const adminId = await requireAdmin();
      if (!adminId) {
        continue;
      }
      const facts = await listGlobalFacts({ includeDisabled: true });
      if (!facts.length) {
        console.log('No global facts yet.');
      } else {
        for (const f of facts) {
          console.log(`  ${f.enabled ? '●' : '○'} ${f.id} (priority ${f.priority}): ${f.fact_text}`);
        }
      }
      continue;
    }
    if (input.startsWith('/fact-del ')) {
      const adminId = await requireAdmin();
      if (!adminId) {
        continue;
      }
      const id = input.slice(10).trim();
      const ok = await deleteGlobalFact(id);
      console.log(ok ? 'Global fact deleted.' : 'No fact with that id was found.');
      continue;
    }

    // --- Shared knowledge base (RAG): search available to everyone, writing admin-only ---
    if (input.startsWith('/kb-add ')) {
      const adminId = await requireAdmin();
      if (!adminId) {
        continue;
      }
      const text = input.slice(8).trim();
      if (!text) {
        console.log('Provide the text: /kb-add <text>');
        continue;
      }
      const k = await addGlobalKnowledge({ content: text, createdBy: adminId });
      console.log(`Text added to the knowledge base. Id: ${k.id}`);
      continue;
    }
    if (input.startsWith('/kb-find ')) {
      const q = input.slice(9).trim();
      if (!q) {
        console.log('Provide the query: /kb-find <query>');
        continue;
      }
      const hits = await searchGlobalKnowledge({ domainKey, query: q });
      if (!hits.length) {
        console.log('No relevant fragments found.');
      } else {
        for (const h of hits) {
          console.log(`  ${h.id}: ${h.title ? h.title + ' — ' : ''}${h.content}`);
        }
      }
      continue;
    }
    if (input.startsWith('/kb-del ')) {
      const adminId = await requireAdmin();
      if (!adminId) {
        continue;
      }
      const id = input.slice(8).trim();
      const ok = await deleteGlobalKnowledge(id);
      console.log(ok ? 'Knowledge base record deleted.' : 'No record with that id was found.');
      continue;
    }

    try {
      const res = await handleMessage({ externalId, userMessage: input, domainKey });
      ({ domainKey } = res);
      if (res.toolsUsed.length) {
        console.log(`  [tools: ${res.toolsUsed.map((t) => t.name).join(', ')}]`);
      }
      console.log(`bot> ${res.answer}\n`);
    } catch (err) {
      console.error('Processing error:', err.message);
    }
  }
  clearInterval(schedulerTimer);
  rl.close();
  await flushLlmLog();
  await flushAgentEventLog();
  await closePool();
}

main();
