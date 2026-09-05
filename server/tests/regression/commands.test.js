// Gap audit (Roy's request, following the weekday/audience/all-day bug
// report): "undo," "list tasks," and "help" are the bot's original three
// system commands — matched deterministically before the LLM is ever
// called — and had ZERO test coverage anywhere in this suite, despite
// being core, established, everyday-use features. Found by systematically
// compiling a full scenario list for the whole bot and cross-checking it
// against what actually has tests, not by a new bug report.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestPool } from '../setup/testDb.js';
import { setPool } from '../../src/db/pool.js';
import { seedFamily } from '../setup/seedFamily.js';
import { createFakeCalendar, createFakeMessenger, createFakeLlm } from '../setup/fakes.js';
import { handleIncomingMessage } from '../../src/pipeline/pipeline.js';
import * as tasksRepo from '../../src/repositories/tasks.js';
import * as extractionLogRepo from '../../src/repositories/extractionLog.js';
import { matchCommand, helpReply, formatTaskList } from '../../src/pipeline/commands.js';

let pool;
beforeEach(() => {
  pool = createTestPool();
  setPool(pool);
});

test('matchCommand recognizes undo/list tasks/help case-insensitively and with surrounding whitespace', () => {
  assert.equal(matchCommand('undo'), 'undo');
  assert.equal(matchCommand('UNDO'), 'undo');
  assert.equal(matchCommand('  undo  '), 'undo');
  assert.equal(matchCommand('list tasks'), 'list_tasks');
  assert.equal(matchCommand('List Tasks'), 'list_tasks');
  assert.equal(matchCommand('help'), 'help');
  assert.equal(matchCommand('Help'), 'help');
});

test('matchCommand does not misfire on a real message that merely contains one of these words', () => {
  assert.equal(matchCommand("Let's undo the plans for tonight, going out instead"), null);
  assert.equal(matchCommand('Please help me remember to buy milk'), null);
  assert.equal(matchCommand('Add list tasks for the school project'), null);
});

test('formatTaskList: empty vs. a real list, with due dates and a done checkmark', () => {
  assert.equal(formatTaskList([]), 'No tasks yet.');
  const list = formatTaskList([
    { title: 'Bring $10 for the field trip', due_date: '2026-09-08', status: 'pending' },
    { title: 'Sign the permission slip', due_date: null, status: 'pending' },
    { title: 'Pack swim bag', due_date: new Date('2026-09-09T00:00:00Z'), status: 'done' },
  ]);
  assert.match(list, /^Current tasks:/);
  assert.match(list, /Bring \$10 for the field trip \(due 2026-09-08\)/);
  assert.match(list, /Sign the permission slip$/m, 'no due date -- no "(due ...)" suffix at all');
  assert.match(list, /✅ Pack swim bag \(due 2026-09-09\)/);
});

test('helpReply mentions every real command the bot actually understands', () => {
  const reply = helpReply();
  assert.match(reply, /undo/i);
  assert.match(reply, /list tasks/i);
  assert.match(reply, /rules/i);
});

test('"help" replies with the help text, without ever calling the LLM', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({});

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'help', externalMessageId: 'wamid.cmd-help' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );

  assert.equal(result.outcome, 'command');
  assert.equal(llm.calls.length, 0, 'a command must be resolved before the LLM is ever called');
  assert.equal(messenger.sent[0].text, helpReply());
});

test('"list tasks" shows real pending tasks, without calling the LLM', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Bring $10 for the field trip by Friday': {
      title: 'Bring $10 for the field trip', date: '2026-09-11', time: null, person: null, category: 'todo',
      reminder_requested: false, reminder_datetime: null,
    },
  });

  await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Bring $10 for the field trip by Friday', externalMessageId: 'wamid.cmd-list1' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'list tasks', externalMessageId: 'wamid.cmd-list2' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );

  assert.equal(result.outcome, 'command');
  assert.equal(llm.calls.length, 1, 'only the earlier capture called the LLM -- "list tasks" itself must not');
  assert.match(messenger.sent.at(-1).text, /Bring \$10 for the field trip/);
});

test('"list tasks" with nothing pending says so plainly, not an empty message', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'list tasks', externalMessageId: 'wamid.cmd-list3' },
    { pool, llmExtract: async () => { throw new Error('must not call the LLM for a command'); }, calendar, messenger }
  );

  assert.equal(result.outcome, 'command');
  assert.equal(messenger.sent[0].text, 'No tasks yet.');
});

test('"undo" reverts the most recently written CALENDAR event: deletes it and marks the log undone', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Dance class at 4pm': {
      title: 'Dance class', date: '2026-09-08', time: '16:00', person: null, category: 'activity',
      reminder_requested: false, reminder_datetime: null,
    },
  });

  const written = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Dance class at 4pm', externalMessageId: 'wamid.cmd-undo1' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );
  assert.equal(calendar.events.size, 1);

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'undo', externalMessageId: 'wamid.cmd-undo2' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );

  assert.equal(result.outcome, 'command');
  assert.equal(calendar.events.size, 0, 'the real Calendar event must actually be deleted');
  assert.match(messenger.sent.at(-1).text, /Done — undid that/);

  const undoneLog = await extractionLogRepo.findById(written.log.id, pool);
  assert.equal(undoneLog.state, 'undone');
});

test('"undo" reverts the most recently written TASK (date-only capture): soft-deletes it, not the Calendar', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Bring $10 for the field trip by Friday': {
      title: 'Bring $10 for the field trip', date: '2026-09-11', time: null, person: null, category: 'todo',
      reminder_requested: false, reminder_datetime: null,
    },
  });

  await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Bring $10 for the field trip by Friday', externalMessageId: 'wamid.cmd-undo3' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );
  const before = await tasksRepo.findAllForFamily(family.id, pool);
  assert.equal(before.length, 1);

  await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'undo', externalMessageId: 'wamid.cmd-undo4' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );

  const after = await tasksRepo.findAllForFamily(family.id, pool);
  assert.equal(after.length, 0, 'soft-deleted tasks are excluded from findAllForFamily');
});

test('"undo" with nothing recent to undo says so honestly, touches nothing', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'undo', externalMessageId: 'wamid.cmd-undo5' },
    { pool, llmExtract: async () => { throw new Error('must not call the LLM for a command'); }, calendar, messenger }
  );

  assert.equal(result.outcome, 'command');
  assert.equal(result.undone, null);
  assert.match(messenger.sent[0].text, /Nothing to undo/);
  assert.equal(calendar.events.size, 0);
});
