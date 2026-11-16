import { join, resolve } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { isLoopbackHost } from '@deepseek-ai/dsh-host-webserver';
import { BOARD_COLUMNS, KanbanStore, } from '../core/index.js';
export const name = 'ns-board';
export const inject = ['tools', 'commands', 'systemPrompt'];
export const Config = z.object({
    dbPath: z.string().default('.ns-dsh/board.db'),
});
function renderJson(_args, value) {
    return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }];
}
const LOOPBACK_ORIGIN_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;
const LOOPBACK_HOST_RE = /^(?:127\.\d+\.\d+\.\d+|localhost|\[::1\]|::1)(?::\d+)?$/i;
function isLoopbackRequest(req) {
    const host = String(req.headers.host ?? '');
    if (host && !LOOPBACK_HOST_RE.test(host))
        return false;
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin.length > 0 && !LOOPBACK_ORIGIN_RE.test(origin)) {
        return false;
    }
    return true;
}
function sendJson(res, statusCode, body) {
    const payload = JSON.stringify(body);
    res.writeHead(statusCode, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
    });
    res.end(payload);
}
async function readJsonBody(req, limitBytes = 65_536) {
    return new Promise((resolveBody, rejectBody) => {
        const chunks = [];
        let total = 0;
        let settled = false;
        const fail = (err) => {
            if (settled)
                return;
            settled = true;
            rejectBody(err);
        };
        req.on('data', (chunk) => {
            if (settled)
                return;
            total += chunk.length;
            if (total > limitBytes) {
                fail(Object.assign(new Error('request body exceeds 64KB limit'), { statusCode: 413 }));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (settled)
                return;
            settled = true;
            try {
                const raw = Buffer.concat(chunks).toString('utf8').trim();
                resolveBody(raw ? JSON.parse(raw) : {});
            }
            catch {
                rejectBody(Object.assign(new Error('invalid JSON body'), { statusCode: 400 }));
            }
        });
        req.on('error', fail);
        req.on('aborted', () => fail(Object.assign(new Error('request aborted'), { statusCode: 400 })));
    });
}
export function formatBoardText(snap) {
    if (snap.cards.length === 0)
        return 'NS-Board (empty): 0 cards.';
    const lines = [`NS-Board rev=${snap.revision} (${JSON.stringify(snap.counts)})`];
    for (const col of BOARD_COLUMNS) {
        const items = snap.cards.filter((c) => c.column === col);
        if (items.length === 0)
            continue;
        lines.push(`[${col.toUpperCase()}]`);
        for (const c of items) {
            const deps = c.blockedBy.length > 0 ? ` blockedBy=[${c.blockedBy.join(',')}]` : '';
            const scopes = c.writeScopes.length > 0 ? ` scopes=[${c.writeScopes.join(',')}]` : '';
            const hitl = c.approvalNeeded ? ` APPROVAL(${c.approvalNeeded.toolName})` : '';
            lines.push(`  - ${c.id}@r${c.revision} (${c.owner})${hitl}: ${c.title}${deps}${scopes}`);
        }
    }
    return lines.join('\n');
}
export function apply(ctx, rawConfig = {}) {
    const configuredPath = rawConfig.dbPath ?? '.ns-dsh/board.db';
    const resolvedDbPath = configuredPath === ':memory:' ? ':memory:' : resolve(process.cwd(), configuredPath);
    const store = new KanbanStore(resolvedDbPath);
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
        const sseClients = new Set();
        const unsubscribe = store.subscribe((snap) => {
            const msg = `event: board\ndata: ${JSON.stringify(snap)}\n\n`;
            for (const client of sseClients) {
                try {
                    client.write(msg);
                }
                catch {
                    sseClients.delete(client);
                }
            }
        });
        const keepalive = setInterval(() => {
            for (const client of sseClients) {
                try {
                    client.write(':keepalive\n\n');
                }
                catch {
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
                    if (req.method !== 'GET')
                        return sendJson(res, 405, { error: 'method not allowed' });
                    if (!isLoopbackRequest(req))
                        return sendJson(res, 403, { error: 'loopback required' });
                    sendJson(res, 200, store.snapshot());
                },
            }),
            server.register({
                kind: 'exact',
                path: '/ns-board/api/events',
                handler: (req, res) => {
                    if (req.method !== 'GET')
                        return sendJson(res, 405, { error: 'method not allowed' });
                    if (!isLoopbackRequest(req))
                        return sendJson(res, 403, { error: 'loopback required' });
                    res.writeHead(200, {
                        'content-type': 'text/event-stream; charset=utf-8',
                        'cache-control': 'no-cache, no-transform',
                        connection: 'keep-alive',
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
                    if (req.method !== 'POST')
                        return sendJson(res, 405, { error: 'method not allowed' });
                    if (!isLoopbackRequest(req))
                        return sendJson(res, 403, { error: 'loopback required' });
                    try {
                        const body = await readJsonBody(req);
                        const resPropose = store.proposeCard({
                            id: typeof body.id === 'string' ? body.id : undefined,
                            title: String(body.title ?? ''),
                            description: typeof body.description === 'string' ? body.description : undefined,
                            owner: typeof body.owner === 'string' ? body.owner : 'human',
                            writeScopes: Array.isArray(body.writeScopes) ? body.writeScopes.map(String) : undefined,
                            blockedBy: Array.isArray(body.blockedBy) ? body.blockedBy.map(String) : undefined,
                        });
                        sendJson(res, 201, resPropose);
                    }
                    catch (err) {
                        const status = err.statusCode ?? 400;
                        sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
                    }
                },
            }),
            server.register({
                kind: 'exact',
                path: '/ns-board/api/move',
                handler: async (req, res) => {
                    if (req.method !== 'POST')
                        return sendJson(res, 405, { error: 'method not allowed' });
                    if (!isLoopbackRequest(req))
                        return sendJson(res, 403, { error: 'loopback required' });
                    try {
                        const body = await readJsonBody(req);
                        const outcome = store.moveCard({
                            cardId: String(body.cardId ?? ''),
                            toColumn: String(body.toColumn ?? ''),
                            actor: typeof body.actor === 'string' ? body.actor : 'human',
                            role: typeof body.role === 'string' ? body.role : 'human',
                            reason: typeof body.reason === 'string' ? body.reason : undefined,
                            expectedRevision: typeof body.expectedRevision === 'number' ? body.expectedRevision : undefined,
                            clearApproval: body.clearApproval === true,
                        });
                        sendJson(res, outcome.ok ? 200 : outcome.status === 'conflict' ? 409 : 400, outcome);
                    }
                    catch (err) {
                        const status = err.statusCode ?? 400;
                        sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
                    }
                },
            }),
        ];
        webCtx.effect(() => () => {
            clearInterval(keepalive);
            unsubscribe();
            for (const client of sseClients) {
                try {
                    client.end();
                }
                catch { /* ignore */ }
            }
            sseClients.clear();
            for (const d of disposers)
                d();
        });
    });
    const schemaObj = { type: 'object', properties: {}, additionalProperties: true };
    ctx.tools.register(defineTool({
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
                return {
                    revision: snap.revision,
                    counts: snap.counts,
                    cards: snap.cards.filter((c) => c.column === col),
                };
            }
            return snap;
        },
    }));
    ctx.tools.register(defineTool({
        name: 'board_propose',
        description: 'Propose a Kanban task card with optional writeScopes and cycle-checked blockedBy dependencies.',
        parameters: {
            id: { type: 'string', description: 'Optional stable card id.' },
            title: { type: 'string', required: true, description: 'Short task title.' },
            description: { type: 'string', description: 'Acceptance criteria & context.' },
            owner: { type: 'string', description: 'Assigned worker/role.' },
            writeScopes: { type: 'json', description: 'Relative files/directories the card may modify.' },
            blockedBy: { type: 'json', description: 'Array of prerequisite card ids.' },
        },
        output: { schema: schemaObj, render: renderJson },
        execute: async (args, exec) => store.proposeCard({
            id: typeof args.id === 'string' ? args.id : undefined,
            title: String(args.title),
            description: typeof args.description === 'string' ? args.description : undefined,
            owner: typeof args.owner === 'string' ? args.owner : 'orchestrator',
            agentSessionId: exec.agent ? String(exec.agent.session.id) : undefined,
            writeScopes: Array.isArray(args.writeScopes) ? args.writeScopes.map(String) : undefined,
            blockedBy: Array.isArray(args.blockedBy) ? args.blockedBy.map(String) : undefined,
        }),
    }));
    ctx.tools.register(defineTool({
        name: 'board_move',
        description: 'Move a card across columns with CAS revision check and automatic dependency unblocking.',
        parameters: {
            cardId: { type: 'string', required: true, description: 'Target card id.' },
            toColumn: { type: 'string', required: true, description: 'backlog|ready|in_progress|review|done|blocked.' },
            actor: { type: 'string', description: 'Actor identifier (default worker).' },
            reason: { type: 'string', description: 'Reason or evidence note.' },
            expectedRevision: { type: 'integer', description: 'Optional optimistic CAS revision.' },
            clearApproval: { type: 'boolean', description: 'Clear active approval badge.' },
        },
        output: { schema: schemaObj, render: renderJson },
        execute: async (args, exec) => store.moveCard({
            cardId: String(args.cardId),
            toColumn: String(args.toColumn),
            actor: typeof args.actor === 'string' ? args.actor : 'worker',
            reason: typeof args.reason === 'string' ? args.reason : undefined,
            expectedRevision: typeof args.expectedRevision === 'number' ? args.expectedRevision : undefined,
            agentSessionId: exec.agent ? String(exec.agent.session.id) : undefined,
            clearApproval: args.clearApproval === true,
        }),
    }));
    ctx.tools.register(defineTool({
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
        execute: async (args) => store.addComment({
            cardId: String(args.cardId),
            body: String(args.body),
            author: typeof args.author === 'string' ? args.author : 'agent',
            role: typeof args.role === 'string' ? args.role : 'system',
            kind: typeof args.kind === 'string' ? args.kind : 'note',
        }),
    }));
    ctx.effect(() => () => {
        store.close();
    });
}
export const defaultDbRelativePath = join('.ns-dsh', 'board.db');
//# sourceMappingURL=index.js.map