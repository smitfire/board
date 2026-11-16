import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
export const BOARD_COLUMNS = ['backlog', 'ready', 'in_progress', 'review', 'done', 'blocked'];
function normalizeScope(raw) {
    const s = posix.normalize(raw.replace(/\\/g, '/').trim()).replace(/^\.\//, '').replace(/\/+$/, '');
    if (!s || s === '.' || s === '..' || s.startsWith('../') || s.startsWith('/')) {
        throw new Error(`invalid relative writeScope: "${raw}"`);
    }
    return s;
}
export function scopesOverlap(aRaw, bRaw) {
    const a = aRaw.replace(/\/+$/, '');
    const b = bRaw.replace(/\/+$/, '');
    return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
export class KanbanStore {
    dbPath;
    db;
    listeners = new Set();
    constructor(dbPath) {
        this.dbPath = dbPath === ':memory:' ? ':memory:' : resolve(dbPath);
        this.db = this.open();
    }
    open() {
        if (this.dbPath !== ':memory:') {
            mkdirSync(dirname(this.dbPath), { recursive: true, mode: 0o700 });
            if (existsSync(this.dbPath) && lstatSync(this.dbPath).isSymbolicLink()) {
                throw new Error(`refusing symlinked board database: ${this.dbPath}`);
            }
        }
        const db = new DatabaseSync(this.dbPath);
        if (this.dbPath !== ':memory:')
            chmodSync(this.dbPath, 0o600);
        db.exec(`
      PRAGMA busy_timeout = 3000;
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS board_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO board_meta (id, revision, updated_at) VALUES (1, 1, unixepoch());
      CREATE TABLE IF NOT EXISTS cards (
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
      CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
        author TEXT NOT NULL,
        role TEXT NOT NULL,
        kind TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
        return db;
    }
    safeJson(raw, fallback) {
        if (typeof raw !== 'string' || !raw.trim())
            return fallback;
        try {
            return JSON.parse(raw);
        }
        catch {
            return fallback;
        }
    }
    rowToCard(row) {
        return {
            id: String(row.id),
            title: String(row.title),
            description: String(row.description ?? ''),
            column: String(row.col),
            revision: Number(row.revision ?? 1),
            owner: String(row.owner ?? ''),
            agentSessionId: row.agent_session_id ? String(row.agent_session_id) : undefined,
            writeScopes: this.safeJson(row.write_scopes_json, []),
            blockedBy: this.safeJson(row.blocked_by_json, []),
            approvalNeeded: this.safeJson(row.approval_json, null),
            reviewFindings: Number(row.review_findings ?? 0),
            createdAt: Number(row.created_at ?? 0),
            updatedAt: Number(row.updated_at ?? 0),
        };
    }
    withTx(fn) {
        this.db.exec('BEGIN IMMEDIATE');
        let txOpen = true;
        try {
            const res = fn();
            txOpen = false;
            this.db.exec('COMMIT');
            return { result: res, changed: true };
        }
        catch (err) {
            if (txOpen) {
                try {
                    this.db.exec('ROLLBACK');
                }
                catch { /* preserve primary failure */ }
            }
            throw err;
        }
    }
    bumpBoardRev(nowMs) {
        this.db.prepare('UPDATE board_meta SET revision = revision + 1, updated_at = ? WHERE id = 1').run(nowMs);
    }
    emitChange() {
        if (this.listeners.size === 0)
            return;
        const snap = this.snapshot();
        for (const listener of this.listeners) {
            try {
                listener(snap);
            }
            catch {
                /* isolate subscriber failures */
            }
        }
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    detectCycle(candidateId, blockedBy, existingCards) {
        const depsMap = new Map();
        for (const c of existingCards)
            depsMap.set(c.id, c.blockedBy);
        depsMap.set(candidateId, [...blockedBy]);
        // Check whether following outgoing blockedBy edges from candidateId reaches candidateId again.
        const visiting = new Set();
        const visited = new Set();
        const dfs = (node) => {
            if (visiting.has(node))
                return true;
            if (visited.has(node))
                return false;
            visiting.add(node);
            for (const dep of depsMap.get(node) ?? []) {
                if (dfs(dep))
                    return true;
            }
            visiting.delete(node);
            visited.add(node);
            return false;
        };
        return dfs(candidateId);
    }
    computeConflicts(cardId, writeScopes, allCards) {
        if (writeScopes.length === 0)
            return [];
        const conflicts = [];
        for (const other of allCards) {
            if (other.id === cardId || other.column !== 'in_progress')
                continue;
            const overlap = writeScopes.filter((s) => other.writeScopes.some((os) => scopesOverlap(s, os)));
            if (overlap.length > 0) {
                conflicts.push({ cardId: other.id, cardTitle: other.title, overlappingScopes: overlap });
            }
        }
        return conflicts;
    }
    proposeCard(input) {
        const title = input.title?.trim();
        if (!title)
            throw new Error('card title must be non-empty');
        const id = (input.id?.trim() || `card_${randomUUID().slice(0, 8)}`).replace(/[^A-Za-z0-9_.:-]/g, '_');
        const writeScopes = [...new Set((input.writeScopes ?? []).map(normalizeScope))];
        const blockedBy = [...new Set((input.blockedBy ?? []).map((b) => b.trim()).filter(Boolean))];
        if (blockedBy.includes(id))
            throw new Error(`DAG cycle rejected: card "${id}" cannot block itself`);
        let outCard;
        let conflicts = [];
        this.withTx(() => {
            const existingRows = this.db.prepare('SELECT * FROM cards').all();
            const allCards = existingRows.map((r) => this.rowToCard(r));
            const byId = new Map(allCards.map((c) => [c.id, c]));
            if (byId.has(id))
                throw new Error(`card "${id}" already exists`);
            for (const depId of blockedBy) {
                if (!byId.has(depId))
                    throw new Error(`unknown blockedBy dependency "${depId}"`);
            }
            if (this.detectCycle(id, blockedBy, allCards)) {
                throw new Error(`DAG cycle rejected involving "${id}" -> [${blockedBy.join(', ')}]`);
            }
            const hasUnmetDeps = blockedBy.some((depId) => byId.get(depId)?.column !== 'done');
            const col = hasUnmetDeps ? 'backlog' : (input.initialColumn ?? 'ready');
            const now = Date.now();
            this.db
                .prepare(`INSERT INTO cards (id, title, description, col, revision, owner, agent_session_id, write_scopes_json, blocked_by_json, approval_json, review_findings, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, 0, ?, ?)`)
                .run(id, title.slice(0, 160), (input.description ?? '').trim().slice(0, 4000), col, (input.owner ?? 'unassigned').slice(0, 80), input.agentSessionId ?? null, JSON.stringify(writeScopes), JSON.stringify(blockedBy), now, now);
            this.bumpBoardRev(now);
            outCard = this.rowToCard(this.db.prepare('SELECT * FROM cards WHERE id = ?').get(id));
            conflicts = this.computeConflicts(id, writeScopes, allCards);
        });
        this.emitChange();
        return { card: outCard, scopeConflicts: conflicts };
    }
    /**
     * Add a dependency between existing cards while enforcing DAG acyclicity.
     */
    addDependency(cardId, blockedByCardId) {
        let updated;
        this.withTx(() => {
            const allCards = this.db.prepare('SELECT * FROM cards').all().map((r) => this.rowToCard(r));
            const card = allCards.find((c) => c.id === cardId);
            const dep = allCards.find((c) => c.id === blockedByCardId);
            if (!card)
                throw new Error(`card "${cardId}" not found`);
            if (!dep)
                throw new Error(`dependency card "${blockedByCardId}" not found`);
            const nextDeps = [...new Set([...card.blockedBy, blockedByCardId])];
            if (this.detectCycle(cardId, nextDeps, allCards)) {
                throw new Error(`DAG cycle rejected: "${cardId}" cannot depend on "${blockedByCardId}"`);
            }
            const now = Date.now();
            const nextCol = dep.column !== 'done' && (card.column === 'ready' || card.column === 'in_progress') ? 'backlog' : card.column;
            this.db
                .prepare('UPDATE cards SET blocked_by_json = ?, col = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
                .run(JSON.stringify(nextDeps), nextCol, now, cardId);
            this.bumpBoardRev(now);
            updated = this.rowToCard(this.db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId));
        });
        this.emitChange();
        return updated;
    }
    moveCard(input) {
        if (!BOARD_COLUMNS.includes(input.toColumn)) {
            return { ok: false, status: 'invalid', reason: `invalid column "${String(input.toColumn)}"` };
        }
        let outcome;
        let shouldEmit = false;
        this.withTx(() => {
            const row = this.db.prepare('SELECT * FROM cards WHERE id = ?').get(input.cardId);
            if (!row) {
                outcome = { ok: false, status: 'not_found', reason: `card "${input.cardId}" not found` };
                return;
            }
            const card = this.rowToCard(row);
            if (input.expectedRevision !== undefined && input.expectedRevision !== card.revision) {
                outcome = {
                    ok: false,
                    status: 'conflict',
                    card,
                    reason: `revision conflict: expected ${input.expectedRevision}, actual ${card.revision}`,
                };
                return;
            }
            const allCards = this.db.prepare('SELECT * FROM cards').all().map((r) => this.rowToCard(r));
            const byId = new Map(allCards.map((c) => [c.id, c]));
            if (input.toColumn === 'in_progress' || input.toColumn === 'done') {
                const incomplete = card.blockedBy.filter((depId) => byId.get(depId)?.column !== 'done');
                if (incomplete.length > 0) {
                    outcome = {
                        ok: false,
                        status: 'blocked_by_dependencies',
                        card,
                        reason: `blocked by incomplete dependencies: ${incomplete.join(', ')}`,
                    };
                    return;
                }
            }
            const now = Date.now();
            const nextApproval = input.clearApproval ? null : card.approvalNeeded;
            const nextFindings = input.reviewFindings ?? card.reviewFindings;
            this.db
                .prepare(`UPDATE cards
           SET col = ?, revision = revision + 1, owner = ?, agent_session_id = ?, approval_json = ?, review_findings = ?, updated_at = ?
           WHERE id = ?`)
                .run(input.toColumn, input.owner ?? card.owner, input.agentSessionId !== undefined ? input.agentSessionId : card.agentSessionId ?? null, nextApproval ? JSON.stringify(nextApproval) : null, nextFindings, now, card.id);
            if (input.reason?.trim()) {
                this.db
                    .prepare('INSERT INTO comments (card_id, author, role, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
                    .run(card.id, input.actor, input.role ?? 'human', 'status', `[-> ${input.toColumn}] ${input.reason.trim()}`, now);
            }
            const unblockedIds = [];
            if (input.toColumn === 'done') {
                const refreshed = this.db.prepare('SELECT * FROM cards').all().map((r) => this.rowToCard(r));
                const doneSet = new Set(refreshed.filter((c) => c.column === 'done').map((c) => c.id));
                for (const candidate of refreshed) {
                    if (candidate.column === 'backlog' && candidate.blockedBy.length > 0 && candidate.blockedBy.every((d) => doneSet.has(d))) {
                        this.db.prepare('UPDATE cards SET col = ?, revision = revision + 1, updated_at = ? WHERE id = ?').run('ready', now, candidate.id);
                        unblockedIds.push(candidate.id);
                    }
                }
            }
            this.bumpBoardRev(now);
            const updated = this.rowToCard(this.db.prepare('SELECT * FROM cards WHERE id = ?').get(card.id));
            const conflicts = input.toColumn === 'in_progress' ? this.computeConflicts(card.id, updated.writeScopes, allCards) : [];
            shouldEmit = true;
            outcome = {
                ok: true,
                status: 'moved',
                card: updated,
                unblockedIds,
                scopeConflicts: conflicts,
            };
        });
        if (shouldEmit)
            this.emitChange();
        return outcome;
    }
    addComment(input) {
        if (!input.body?.trim())
            throw new Error('comment body must be non-empty');
        let comment;
        this.withTx(() => {
            const exists = this.db.prepare('SELECT id FROM cards WHERE id = ?').get(input.cardId);
            if (!exists)
                throw new Error(`card "${input.cardId}" not found`);
            const now = Date.now();
            const info = this.db
                .prepare('INSERT INTO comments (card_id, author, role, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
                .run(input.cardId, input.author, input.role ?? 'system', input.kind ?? 'note', input.body.trim().slice(0, 4000), now);
            this.bumpBoardRev(now);
            const row = this.db.prepare('SELECT * FROM comments WHERE id = ?').get(Number(info.lastInsertRowid));
            comment = {
                id: Number(row.id),
                cardId: String(row.card_id),
                author: String(row.author),
                role: String(row.role),
                kind: String(row.kind),
                body: String(row.body),
                createdAt: Number(row.created_at),
            };
        });
        this.emitChange();
        return comment;
    }
    flagApprovalNeeded(req) {
        let updated;
        this.withTx(() => {
            const rows = this.db.prepare('SELECT * FROM cards').all();
            const cards = rows.map((r) => this.rowToCard(r));
            const target = (req.cardId ? cards.find((c) => c.id === req.cardId) : undefined) ??
                (req.agentSessionId ? cards.find((c) => c.agentSessionId === req.agentSessionId && c.column === 'in_progress') : undefined) ??
                cards.find((c) => c.column === 'in_progress');
            const now = Date.now();
            const badge = { toolName: req.toolName, reason: req.reason.slice(0, 500), requestedAt: now };
            if (target) {
                this.db
                    .prepare('UPDATE cards SET col = ?, approval_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
                    .run('blocked', JSON.stringify(badge), now, target.id);
                this.db
                    .prepare('INSERT INTO comments (card_id, author, role, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
                    .run(target.id, 'cuga', 'cuga', 'approval', `Approval needed (${req.toolName}): ${req.reason}`, now);
                this.bumpBoardRev(now);
                updated = this.rowToCard(this.db.prepare('SELECT * FROM cards WHERE id = ?').get(target.id));
            }
            else {
                const id = `approval_${randomUUID().slice(0, 8)}`;
                this.db
                    .prepare(`INSERT INTO cards (id, title, description, col, revision, owner, agent_session_id, write_scopes_json, blocked_by_json, approval_json, review_findings, created_at, updated_at)
             VALUES (?, ?, ?, 'blocked', 1, 'human', ?, '[]', '[]', ?, 0, ?, ?)`)
                    .run(id, `Approve: ${req.toolName}`, req.reason.slice(0, 1000), req.agentSessionId ?? null, JSON.stringify(badge), now, now);
                this.bumpBoardRev(now);
                updated = this.rowToCard(this.db.prepare('SELECT * FROM cards WHERE id = ?').get(id));
            }
        });
        this.emitChange();
        return updated;
    }
    activeWriteScopesForSession(sessionId) {
        const rows = this.db
            .prepare("SELECT write_scopes_json FROM cards WHERE agent_session_id = ? AND col = 'in_progress'")
            .all(sessionId);
        if (rows.length === 0)
            return undefined;
        const scopes = rows.flatMap((r) => this.safeJson(r.write_scopes_json, []));
        return scopes.length > 0 ? [...new Set(scopes)] : undefined;
    }
    getCard(id) {
        const row = this.db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
        return row ? this.rowToCard(row) : undefined;
    }
    snapshot() {
        const meta = this.db.prepare('SELECT revision, updated_at FROM board_meta WHERE id = 1').get();
        const cardRows = this.db.prepare('SELECT * FROM cards ORDER BY updated_at DESC').all();
        const cards = cardRows.map((r) => this.rowToCard(r));
        const counts = {
            backlog: 0,
            ready: 0,
            in_progress: 0,
            review: 0,
            done: 0,
            blocked: 0,
        };
        for (const c of cards) {
            if (c.column in counts)
                counts[c.column] += 1;
        }
        const commentRows = this.db
            .prepare('SELECT * FROM comments ORDER BY id DESC LIMIT 20')
            .all();
        const recentComments = commentRows.map((r) => ({
            id: Number(r.id),
            cardId: String(r.card_id),
            author: String(r.author),
            role: String(r.role),
            kind: String(r.kind),
            body: String(r.body),
            createdAt: Number(r.created_at),
        }));
        return {
            revision: Number(meta?.revision ?? 1),
            updatedAt: Number(meta?.updated_at ?? 0),
            counts,
            cards,
            recentComments,
        };
    }
    digest() {
        const snap = this.snapshot();
        if (snap.cards.length === 0)
            return '';
        const alerts = snap.cards
            .filter((c) => c.approvalNeeded || c.column === 'review' || c.column === 'blocked')
            .slice(0, 3)
            .map((c) => `${c.id}(${c.column}${c.approvalNeeded ? ':APPROVAL' : ''})`)
            .join(', ');
        const summary = `backlog:${snap.counts.backlog} ready:${snap.counts.ready} in_progress:${snap.counts.in_progress} review:${snap.counts.review} done:${snap.counts.done} blocked:${snap.counts.blocked}`;
        return `<ns-board rev="${snap.revision}" summary="${summary}"${alerts ? ` attention="${alerts}"` : ''} />`;
    }
    close() {
        this.db.close();
    }
}
//# sourceMappingURL=kanban-store.js.map