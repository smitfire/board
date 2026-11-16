#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { KanbanStore, type BoardColumn, type BoardRole, type CommentKind } from '../core/index.js';

const MCP_TOOLS = [
  { name: 'board_view', description: 'Inspect current Kanban & DAG cards.', inputSchema: { type: 'object', properties: { column: { type: 'string' } } } },
  {
    name: 'board_propose',
    description: 'Create a DAG-checked Kanban card with writeScopes and blockedBy.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        owner: { type: 'string' },
        writeScopes: { type: 'array', items: { type: 'string' } },
        blockedBy: { type: 'array', items: { type: 'string' } },
      },
      required: ['title'],
    },
  },
  {
    name: 'board_move',
    description: 'Move card column with optimistic CAS expectedRevision.',
    inputSchema: {
      type: 'object',
      properties: {
        cardId: { type: 'string' },
        toColumn: { type: 'string' },
        actor: { type: 'string' },
        reason: { type: 'string' },
        expectedRevision: { type: 'integer' },
        clearApproval: { type: 'boolean' },
      },
      required: ['cardId', 'toColumn'],
    },
  },
  {
    name: 'board_comment',
    description: 'Append an audit comment to a Kanban card.',
    inputSchema: {
      type: 'object',
      properties: { cardId: { type: 'string' }, body: { type: 'string' }, author: { type: 'string' }, role: { type: 'string' }, kind: { type: 'string' } },
      required: ['cardId', 'body'],
    },
  },
];

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export async function startMcpServer(workspaceRoot = process.cwd()): Promise<void> {
  const store = new KanbanStore(join(workspaceRoot, '.ns-dsh', 'board.db'));
  const write = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let req: { id?: string | number | null; method?: string; params?: Record<string, unknown> };
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }
    if (req.id === undefined || req.method === undefined) continue;
    try {
      if (req.method === 'initialize') {
        write({
          jsonrpc: '2.0',
          id: req.id,
          result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'ns-board', version: '0.1.0' } },
        });
      } else if (req.method === 'tools/list') {
        write({ jsonrpc: '2.0', id: req.id, result: { tools: MCP_TOOLS } });
      } else if (req.method === 'tools/call') {
        const name = String(req.params?.name ?? '');
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new RpcError(-32602, 'arguments must be an object');
        let result: unknown;
        if (name === 'board_view') {
          const snap = store.snapshot();
          result = typeof args.column === 'string' && args.column
            ? { revision: snap.revision, counts: snap.counts, cards: snap.cards.filter((c) => c.column === args.column) }
            : snap;
        } else if (name === 'board_propose') {
          result = store.proposeCard({
            id: typeof args.id === 'string' ? args.id : undefined,
            title: String(args.title ?? ''),
            description: typeof args.description === 'string' ? args.description : undefined,
            owner: typeof args.owner === 'string' ? args.owner : 'mcp',
            writeScopes: Array.isArray(args.writeScopes) ? args.writeScopes.map(String) : undefined,
            blockedBy: Array.isArray(args.blockedBy) ? args.blockedBy.map(String) : undefined,
          });
        } else if (name === 'board_move') {
          result = store.moveCard({
            cardId: String(args.cardId ?? ''),
            toColumn: String(args.toColumn ?? '') as BoardColumn,
            actor: typeof args.actor === 'string' ? args.actor : 'mcp',
            reason: typeof args.reason === 'string' ? args.reason : undefined,
            expectedRevision: typeof args.expectedRevision === 'number' ? args.expectedRevision : undefined,
            clearApproval: args.clearApproval === true,
          });
        } else if (name === 'board_comment') {
          result = store.addComment({
            cardId: String(args.cardId ?? ''),
            body: String(args.body ?? ''),
            author: typeof args.author === 'string' ? args.author : 'mcp',
            role: typeof args.role === 'string' ? (args.role as BoardRole) : 'system',
            kind: typeof args.kind === 'string' ? (args.kind as CommentKind) : 'note',
          });
        } else {
          throw new RpcError(-32601, `unknown tool: ${name}`);
        }
        write({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
      } else {
        throw new RpcError(-32601, `method not found: ${req.method}`);
      }
    } catch (error) {
      write({ jsonrpc: '2.0', id: req.id, error: { code: error instanceof RpcError ? error.code : -32000, message: error instanceof Error ? error.message : String(error) } });
    }
  }
  store.close();
}

const isEntrypoint = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  await startMcpServer(process.argv[2] ?? process.cwd());
}
