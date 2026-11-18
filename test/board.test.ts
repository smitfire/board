import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as vm from 'node:vm';
import { Context } from '@deepseek-ai/cordis';
import ToolsService from '@deepseek-ai/dsh-tools';
import CommandRuntime from '@deepseek-ai/dsh-commands';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import { KanbanStore } from '../dist/core/index.js';
import * as boardPlugin from '../dist/dsh/index.js';

test('KanbanStore enforces 6-column DAG acyclicity, auto-unblocking, writeScopes warnings, and CAS', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-board-core-'));
  const store = new KanbanStore(join(dir, 'board.db'));
  try {
    const a = store.proposeCard({ id: 'card-a', title: 'Implement router', writeScopes: ['src/router'] });
    assert.equal(a.card.column, 'ready');

    const b = store.proposeCard({
      id: 'card-b',
      title: 'Add router tests',
      blockedBy: ['card-a'],
      writeScopes: ['test'],
    });
    assert.equal(b.card.column, 'backlog');

    // Transitive cycle (A -> B -> D -> A) must also be rejected cleanly
    store.proposeCard({ id: 'card-d', title: 'Deploy', blockedBy: ['card-b'], writeScopes: ['deploy'] });
    assert.throws(() => store.addDependency('card-a', 'card-d'), /DAG cycle rejected/);

    // Cannot move blocked dependency card directly to in_progress before parent is done
    const blockedMove = store.moveCard({ cardId: 'card-b', toColumn: 'in_progress', actor: 'worker' });
    assert.equal(blockedMove.status, 'blocked_by_dependencies');

    // Overlapping writeScopes emit warning when card-a is in_progress
    store.moveCard({ cardId: 'card-a', toColumn: 'in_progress', actor: 'worker-1', expectedRevision: 1 });
    const c = store.proposeCard({ id: 'card-c', title: 'Edit router middleware', writeScopes: ['src/router/mw.ts'] });
    assert.equal(c.scopeConflicts.length, 1);
    assert.equal(c.scopeConflicts[0].cardId, 'card-a');

    // Stale CAS revision fails loudly
    const staleCas = store.moveCard({ cardId: 'card-a', toColumn: 'done', actor: 'worker-1', expectedRevision: 1 });
    assert.equal(staleCas.status, 'conflict');

    // Completing card-a auto-promotes card-b from backlog -> ready
    store.moveCard({ cardId: 'card-a', toColumn: 'review', actor: 'worker-1', expectedRevision: 2 });
    const doneRes = store.moveCard({ cardId: 'card-a', toColumn: 'done', actor: 'reviewer', expectedRevision: 3 });
    assert.equal(doneRes.ok, true);
    assert.deepEqual(doneRes.unblockedIds, ['card-b']);
    assert.equal(store.getCard('card-b')?.column, 'ready');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DSH Cordis plugin serves /ns-board API routes, /board command, and client slot bundle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-board-web-'));
  const ctx = new Context();
  const wsFiber = ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  await wsFiber;
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolsService);
  await ctx.plugin(CommandRuntime);

  const fiber = ctx.plugin(boardPlugin, { dbPath: join(dir, 'board.db') });
  await fiber;

  try {
    const origin = ctx.webServer.getOrigin();
    const stateResp = await fetch(`${origin}/ns-board/api/state`);
    assert.equal(stateResp.status, 200);
    const emptyState = (await stateResp.json()) as { revision: number; cards: unknown[] };
    assert.equal(emptyState.cards.length, 0);

    const createResp = await fetch(`${origin}/ns-board/api/cards`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'web-1', title: 'Verify WebUI card', writeScopes: ['src'] }),
    });
    assert.equal(createResp.status, 201);

    const moveResp = await fetch(`${origin}/ns-board/api/move`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cardId: 'web-1', toColumn: 'review', actor: 'worker', expectedRevision: 1 }),
    });
    assert.equal(moveResp.status, 200);

    const cmd = ctx.commands.find({} as never, 'board');
    assert.ok(cmd);
    const cmdOut = await cmd.handler({
      commandId: 'cmd-1' as never,
      agent: {} as never,
      rawInput: '',
      attachments: [],
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(cmdOut.kind, 'success');
    assert.match(cmdOut.text ?? '', /Verify WebUI card/);

    // Verify /ns-board/api/events streams live SSE board snapshots
    const sseAbort = new AbortController();
    const sseResp = await fetch(`${origin}/ns-board/api/events`, { signal: sseAbort.signal });
    assert.equal(sseResp.status, 200);
    assert.match(sseResp.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = sseResp.body!.getReader();
    const firstChunk = new TextDecoder().decode((await reader.read()).value);
    sseAbort.abort();
    assert.match(firstChunk, /event: board/);
    assert.match(firstChunk, /Verify WebUI card/);

    // Verify dist/client.cjs registers main, sidebar.panellist, and conversation.input.dock slots cleanly
    const bundlePath = resolve(import.meta.dirname, '..', 'dist', 'client.cjs');
    const code = readFileSync(bundlePath, 'utf8');
    type ClientDef = {
      id: string;
      factory: (req: (id: string) => unknown) => { inject: string[]; apply: (c: unknown) => void };
    };
    const box: { def?: ClientDef } = {};
    vm.runInNewContext(code, {
      window: {
        __ModuleLoader__: {
          load: (def: ClientDef) => {
            box.def = def;
          },
        },
      },
    });
    assert.ok(box.def);
    const fakeReq = (id: string) => {
      if (id === 'react') return { useState: (v: unknown) => [v, () => {}], useEffect: () => {} };
      if (id === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null };
      if (id === '@deepseek-ai/dsh-client-ui-primitives') return {};
      throw new Error(`unexpected client require: ${id}`);
    };
    const pluginObj = box.def.factory(fakeReq);
    assert.deepEqual([...pluginObj.inject], ['slots', 'locale', 'layout']);
    const registeredSlots: string[] = [];
    const fakeClientCtx = {
      effect: (fn: () => void) => { fn(); return () => {}; },
      locale: { register: () => () => {}, bind: () => (k: string) => k },
      layout: { selectPanel: () => {} },
      slots: {
        inject: (slot: string, fn: () => void) => {
          registeredSlots.push(slot);
          fn();
        },
        register: (meta: unknown) => meta,
      },
    };
    pluginObj.apply(fakeClientCtx);
    assert.deepEqual(registeredSlots.sort(), ['conversation.input.dock', 'main', 'sidebar.panellist']);
  } finally {
    await fiber.dispose();
    await wsFiber.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('KanbanStore tracks modelTier, phase, updateCardMeta, getComments, legacy SQLite migration, and NS_BOARD_DB_PATH', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-board-tier-'));
  const legacyDbPath = join(dir, 'legacy.db');
  const legacy = new DatabaseSync(legacyDbPath);
  legacy.exec(`
    CREATE TABLE board_meta (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL);
    INSERT INTO board_meta (id, revision, updated_at) VALUES (1, 1, 100);
    CREATE TABLE cards (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      col TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      owner TEXT NOT NULL DEFAULT '',
      agent_session_id TEXT,
      write_scopes_json TEXT NOT NULL DEFAULT '[]',
      blocked_by_json TEXT NOT NULL DEFAULT '[]',
      approval_json TEXT,
      review_findings INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      author TEXT NOT NULL,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    INSERT INTO cards (id, title, description, col, revision, owner, created_at, updated_at)
    VALUES ('legacy-1', 'Old row', '', 'ready', 1, 'coder', 100, 100);
  `);
  legacy.close();

  const store = new KanbanStore(legacyDbPath);
  try {
    assert.equal(store.getCard('legacy-1')?.title, 'Old row');
    assert.throws(() => store.proposeCard({ id: 'bad-tier', title: 'Bad', modelTier: 'ultra' as never }), /invalid modelTier/);

    const metaUpdated = store.updateCardMeta('legacy-1', { modelTier: 'capable', phase: 'planning', owner: 'orchestrator' });
    assert.equal(metaUpdated?.modelTier, 'capable');
    assert.equal(metaUpdated?.phase, 'planning');
    assert.equal(store.updateCardMeta('missing-card', { phase: 'done' }), undefined);

    const p = store.proposeCard({ id: 'tiered-1', title: 'Mechanical change', modelTier: 'efficient', phase: 'executing', writeScopes: ['src/a.ts'] });
    assert.equal(p.card.modelTier, 'efficient');
    assert.equal(p.card.phase, 'executing');

    const badMove = store.moveCard({ cardId: 'tiered-1', toColumn: 'in_progress', actor: 'orch', phase: 'bogus' as never });
    assert.equal(badMove.status, 'invalid');

    store.moveCard({ cardId: 'tiered-1', toColumn: 'in_progress', actor: 'orch', role: 'orchestrator', reason: 'Start work' });
    assert.match(store.digest(), /tiered-1\(in_progress\/executing:efficient\)/);
    store.addComment({ cardId: 'tiered-1', author: 'orch', role: 'orchestrator', kind: 'plan', body: 'Plan recorded' });
    const comments = store.getComments('tiered-1');
    assert.equal(comments.length, 2);
    assert.equal(comments[1].kind, 'plan');

    const revMove = store.moveCard({ cardId: 'tiered-1', toColumn: 'done', actor: 'reviewer', role: 'reviewer' });
    assert.equal(revMove.card?.phase, 'done');
  } finally {
    store.close();
  }

  const prevOverride = process.env.NS_BOARD_DB_PATH;
  process.env.NS_BOARD_DB_PATH = ':memory:';
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolsService);
  await ctx.plugin(CommandRuntime);
  const fiber = ctx.plugin(boardPlugin, { dbPath: join(dir, 'should-not-create.db') });
  await fiber;
  try {
    ctx.nsBoard!.proposeCard({ id: 'mem-1', title: 'Mem tier card', modelTier: 'capable', phase: 'planning' });
    const text = boardPlugin.formatBoardText(ctx.nsBoard!.snapshot());
    assert.match(text, /tier=capable/);
    assert.match(text, /phase=planning/);
  } finally {
    await fiber.dispose();
    if (prevOverride === undefined) delete process.env.NS_BOARD_DB_PATH;
    else process.env.NS_BOARD_DB_PATH = prevOverride;
    rmSync(dir, { recursive: true, force: true });
  }
});
