import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { isLoopbackHost } from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-commands';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type {} from '@deepseek-ai/dsh-agent';
import {
  BOARD_COLUMNS,
  KanbanStore,
  type BoardColumn,
  type BoardRole,
  type BoardStateSnapshot,
  type CardExecPhase,
  type CardModelTier,
  type CommentKind,
} from '../core/index.js';

export const name = 'ns-board';
export const inject = ['tools', 'commands', 'systemPrompt'] as const;

export interface PluginConfig {
  dbPath: string;
}

export const Config = z.object({
  dbPath: z.string().default('.ns-dsh/board.db'),
});

declare module '@deepseek-ai/cordis' {
  interface Context {
    nsBoard?: KanbanStore;
  }
}

function renderJson(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }];
}

const LOOPBACK_ORIGIN_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;
const LOOPBACK_HOST_RE = /^(?:127\.\d+\.\d+\.\d+|localhost|\[::1\]|::1)(?::\d+)?$/i;

function isLoopbackRequest(req: IncomingMessage): boolean {
  const host = String(req.headers.host ?? '');
  if (!host || !LOOPBACK_HOST_RE.test(host)) return false;
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.length > 0 && !LOOPBACK_ORIGIN_RE.test(origin)) {
    return false;
  }
  return true;
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage, limitBytes = 65_536): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      rejectBody(err);
    };
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limitBytes) {
        req.pause();
        fail(Object.assign(new Error('request body exceeds 64KB limit'), { statusCode: 413 }));
        return;
      }
      if (!settled) chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        resolveBody(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch {
        rejectBody(Object.assign(new Error('invalid JSON body'), { statusCode: 400 }));
      }
    });
    req.on('error', fail);
    req.on('aborted', () => fail(Object.assign(new Error('request aborted'), { statusCode: 400 })));
  });
}

export function formatBoardText(snap: BoardStateSnapshot): string {
  if (snap.cards.length === 0) return 'NS-Board (empty): 0 cards.';
  const lines = [`NS-Board rev=${snap.revision} (${JSON.stringify(snap.counts)})`];
  for (const col of BOARD_COLUMNS) {
    const items = snap.cards.filter((c) => c.column === col);
    if (items.length === 0) continue;
    lines.push(`[${col.toUpperCase()}]`);
    for (const c of items) {
      const deps = c.blockedBy.length > 0 ? ` blockedBy=[${c.blockedBy.join(',')}]` : '';
      const scopes = c.writeScopes.length > 0 ? ` scopes=[${c.writeScopes.join(',')}]` : '';
      const tier = c.modelTier ? ` tier=${c.modelTier}` : '';
      const phase = c.phase ? ` phase=${c.phase}` : '';
      const hitl = c.approvalNeeded ? ` APPROVAL(${c.approvalNeeded.toolName})` : '';
      lines.push(`  - ${c.id}@r${c.revision} (${c.owner}${tier}${phase})${hitl}: ${c.title}${deps}${scopes}`);
    }
  }
  return lines.join('\n');
}

function resolveBoardDbPath(rawConfigDbPath?: string): string {
  const envDb = process.env.NS_BOARD_DB_PATH?.trim();
  if (envDb) return envDb === ':memory:' ? ':memory:' : resolve(process.cwd(), envDb);
  const cfgDb = rawConfigDbPath?.trim();
  if (cfgDb && cfgDb !== '.ns-dsh/board.db') {
    return cfgDb === ':memory:' ? ':memory:' : resolve(process.cwd(), cfgDb);
  }
  const localLegacy = resolve(process.cwd(), '.ns-dsh/board.db');
  if (existsSync(localLegacy)) return localLegacy;
  const stateDir = process.env.NS_DSH_STATE_DIR?.trim();
  if (stateDir) return join(resolve(stateDir), 'board.db');
  return localLegacy;
}

export function apply(ctx: Context, rawConfig: Partial<PluginConfig> = {}): void {
  const resolvedDbPath = resolveBoardDbPath(rawConfig.dbPath);
  const store = new KanbanStore(resolvedDbPath);
  ctx.effect(() => () => {
    store.close();
  });

  ctx.provide('nsBoard', store);

  ctx.systemPrompt.context({
    name: 'ns-board:digest',
    order: 182,
    interpolate: false,
    text: () => store.digest(),
  });

  ctx.commands.register({
    name: 'board',
    description: 'Inspect or summarize the HITL Kanban & DAG board.',
    handler: async () => ({ kind: 'success', text: formatBoardText(store.snapshot()) }),
  });

  // Mount HTTP/SSE API routes when dsh web's loopback WebServer is active; skip cleanly in headless CLI.
  ctx.inject(['webServer'], (webCtx) => {
    const server = webCtx.webServer;
    if (!isLoopbackHost(server.host)) {
      webCtx.logger('ns-board').warn(`refusing /ns-board API routes on non-loopback host ${server.host}`);
      return;
    }

    const sseClients = new Set<ServerResponse>();
    const unsubscribe = store.subscribe((snap) => {
      const msg = `event: board\ndata: ${JSON.stringify(snap)}\n\n`;
      for (const client of sseClients) {
        try {
          client.write(msg);
        } catch {
          sseClients.delete(client);
        }
      }
    });

    const keepalive = setInterval(() => {
      for (const client of sseClients) {
        try {
          client.write(':keepalive\n\n');
        } catch {
          sseClients.delete(client);
        }
      }
    }, 15_000);
    keepalive.unref();

    const disposers = [
      server.register({
        kind: 'exact',
        path: '/ns-board/api/state',
        handler: (req, res) => {
          if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
          if (!isLoopbackRequest(req)) return sendJson(res, 403, { error: 'loopback required' });
          sendJson(res, 200, store.snapshot());
        },
      }),
      server.register({
        kind: 'exact',
        path: '/ns-board/api/events',
        handler: (req, res) => {
          if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
          if (!isLoopbackRequest(req)) return sendJson(res, 403, { error: 'loopback required' });
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
          });
          res.on('error', () => {
            sseClients.delete(res);
          });
          sseClients.add(res);
          res.write(`event: board\ndata: ${JSON.stringify(store.snapshot())}\n\n`);
          req.on('close', () => {
            sseClients.delete(res);
          });
        },
      }),
      server.register({
        kind: 'exact',
        path: '/ns-board/api/cards',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
          if (!isLoopbackRequest(req)) return sendJson(res, 403, { error: 'loopback required' });
          try {
            const body = await readJsonBody(req);
            const resPropose = store.proposeCard({
              id: typeof body.id === 'string' ? body.id : undefined,
              title: String(body.title ?? ''),
              description: typeof body.description === 'string' ? body.description : undefined,
              owner: typeof body.owner === 'string' ? body.owner : 'human',
              modelTier: typeof body.modelTier === 'string' ? (body.modelTier as CardModelTier) : undefined,
              phase: typeof body.phase === 'string' ? (body.phase as CardExecPhase) : undefined,
              writeScopes: Array.isArray(body.writeScopes) ? body.writeScopes.map(String) : undefined,
              blockedBy: Array.isArray(body.blockedBy) ? body.blockedBy.map(String) : undefined,
            });
            sendJson(res, 201, resPropose);
          } catch (err) {
            const status = (err as { statusCode?: number }).statusCode ?? 400;
            sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
          }
        },
      }),
      server.register({
        kind: 'exact',
        path: '/ns-board/api/move',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
          if (!isLoopbackRequest(req)) return sendJson(res, 403, { error: 'loopback required' });
          try {
            const body = await readJsonBody(req);
            const outcome = store.moveCard({
              cardId: String(body.cardId ?? ''),
              toColumn: String(body.toColumn ?? '') as BoardColumn,
              actor: typeof body.actor === 'string' ? body.actor : 'human',
              role: typeof body.role === 'string' ? (body.role as BoardRole) : 'human',
              reason: typeof body.reason === 'string' ? body.reason : undefined,
              expectedRevision: typeof body.expectedRevision === 'number' ? body.expectedRevision : undefined,
              modelTier: typeof body.modelTier === 'string' ? (body.modelTier as CardModelTier) : undefined,
              phase: typeof body.phase === 'string' ? (body.phase as CardExecPhase) : undefined,
              clearApproval: body.clearApproval === true,
            });
            sendJson(res, outcome.ok ? 200 : outcome.status === 'conflict' ? 409 : 400, outcome);
          } catch (err) {
            const status = (err as { statusCode?: number }).statusCode ?? 400;
            sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
          }
        },
      }),
    ];

    webCtx.effect(() => () => {
      clearInterval(keepalive);
      unsubscribe();
      for (const client of sseClients) {
        try { client.end(); } catch { /* ignore */ }
      }
      sseClients.clear();
      for (const d of disposers) d();
    });
  });

  const schemaObj = { type: 'object' as const, properties: {}, additionalProperties: true };

  ctx.tools.register(
    defineTool({
      name: 'board_view',
      description: 'Read current 6-column Kanban & DAG state (optionally filter by column).',
      parameters: {
        column: { type: 'string', description: 'Optional column filter: backlog|ready|in_progress|review|done|blocked.' },
      },
      output: { schema: schemaObj, render: renderJson },
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const snap = store.snapshot();
        if (typeof args.column === 'string' && args.column.trim()) {
          const col = args.column.trim();
          if (!(BOARD_COLUMNS as readonly string[]).includes(col)) {
            throw new Error(`invalid column "${col}"; expected one of ${BOARD_COLUMNS.join('|')}`);
          }
          return {
            revision: snap.revision,
            counts: snap.counts,
            cards: snap.cards.filter((c) => c.column === col),
          } as never;
        }
        return snap as never;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'board_propose',
      description: 'Propose a Kanban task card with optional writeScopes and cycle-checked blockedBy dependencies.',
      parameters: {
        id: { type: 'string', description: 'Optional stable card id.' },
        title: { type: 'string', required: true, description: 'Short task title.' },
        description: { type: 'string', description: 'Acceptance criteria & context.' },
        owner: { type: 'string', description: 'Assigned worker/role.' },
        modelTier: { type: 'string', description: 'Optional model tier: efficient|capable.' },
        phase: { type: 'string', description: 'Optional execution phase: planning|executing|review|done.' },
        writeScopes: { type: 'json', description: 'Relative files/directories the card may modify.' },
        blockedBy: { type: 'json', description: 'Array of prerequisite card ids.' },
      },
      output: { schema: schemaObj, render: renderJson },
      execute: async (args, exec) =>
        store.proposeCard({
          id: typeof args.id === 'string' ? args.id : undefined,
          title: String(args.title),
          description: typeof args.description === 'string' ? args.description : undefined,
          owner: typeof args.owner === 'string' ? args.owner : 'orchestrator',
          agentSessionId: exec.agent ? String(exec.agent.session.id) : undefined,
          modelTier: typeof args.modelTier === 'string' ? (args.modelTier as CardModelTier) : undefined,
          phase: typeof args.phase === 'string' ? (args.phase as CardExecPhase) : undefined,
          writeScopes: Array.isArray(args.writeScopes) ? args.writeScopes.map(String) : undefined,
          blockedBy: Array.isArray(args.blockedBy) ? args.blockedBy.map(String) : undefined,
        }) as never,
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'board_move',
      description: 'Move a card across columns with CAS revision check and automatic dependency unblocking.',
      parameters: {
        cardId: { type: 'string', required: true, description: 'Target card id.' },
        toColumn: { type: 'string', required: true, description: 'backlog|ready|in_progress|review|done|blocked.' },
        actor: { type: 'string', description: 'Actor identifier (default worker).' },
        reason: { type: 'string', description: 'Reason or evidence note.' },
        expectedRevision: { type: 'integer', description: 'Optional optimistic CAS revision.' },
        modelTier: { type: 'string', description: 'Optional model tier: efficient|capable.' },
        phase: { type: 'string', description: 'Optional execution phase: planning|executing|review|done.' },
        clearApproval: { type: 'boolean', description: 'Clear active approval badge.' },
      },
      output: { schema: schemaObj, render: renderJson },
      execute: async (args, exec) =>
        store.moveCard({
          cardId: String(args.cardId),
          toColumn: String(args.toColumn) as BoardColumn,
          actor: typeof args.actor === 'string' ? args.actor : 'worker',
          reason: typeof args.reason === 'string' ? args.reason : undefined,
          expectedRevision: typeof args.expectedRevision === 'number' ? args.expectedRevision : undefined,
          agentSessionId: exec.agent ? String(exec.agent.session.id) : undefined,
          modelTier: typeof args.modelTier === 'string' ? (args.modelTier as CardModelTier) : undefined,
          phase: typeof args.phase === 'string' ? (args.phase as CardExecPhase) : undefined,
          clearApproval: args.clearApproval === true,
        }) as never,
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'board_comment',
      description: 'Append an audit comment, review finding, or advisor note to a Kanban card.',
      parameters: {
        cardId: { type: 'string', required: true, description: 'Target card id.' },
        body: { type: 'string', required: true, description: 'Comment text.' },
        author: { type: 'string', description: 'Author name.' },
        role: { type: 'string', description: 'human|orchestrator|worker|advisor|reviewer|cuga|system.' },
        kind: { type: 'string', description: 'note|plan|review|approval|conflict|status.' },
      },
      output: { schema: schemaObj, render: renderJson },
      execute: async (args) =>
        store.addComment({
          cardId: String(args.cardId),
          body: String(args.body),
          author: typeof args.author === 'string' ? args.author : 'agent',
          role: typeof args.role === 'string' ? (args.role as BoardRole) : 'system',
          kind: typeof args.kind === 'string' ? (args.kind as CommentKind) : 'note',
        }) as never,
    }),
  );

  return;
}

export const defaultDbRelativePath = join('.ns-dsh', 'board.db');
