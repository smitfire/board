import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const BOARD_COLUMNS = ['backlog', 'ready', 'in_progress', 'review', 'done', 'blocked'] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

export const CARD_MODEL_TIERS = ['efficient', 'capable'] as const;
export type CardModelTier = (typeof CARD_MODEL_TIERS)[number];

export const CARD_EXEC_PHASES = ['planning', 'executing', 'review', 'done'] as const;
export type CardExecPhase = (typeof CARD_EXEC_PHASES)[number];

export type BoardRole = 'human' | 'orchestrator' | 'worker' | 'advisor' | 'reviewer' | 'cuga' | 'system';
export type CommentKind = 'note' | 'plan' | 'review' | 'approval' | 'conflict' | 'status';

export interface ApprovalBadge {
  toolName: string;
  reason: string;
  requestedAt: number;
}

export interface BoardCard {
  id: string;
  title: string;
  description: string;
  column: BoardColumn;
  revision: number;
  owner: string;
  agentSessionId?: string;
  modelTier?: CardModelTier;
  phase?: CardExecPhase;
  writeScopes: string[];
  blockedBy: string[];
  approvalNeeded: ApprovalBadge | null;
  reviewFindings: number;
  createdAt: number;
  updatedAt: number;
}

export interface BoardComment {
  id: number;
  cardId: string;
  author: string;
  role: BoardRole;
  kind: CommentKind;
  body: string;
  createdAt: number;
}

export interface ScopeConflict {
  cardId: string;
  cardTitle: string;
  overlappingScopes: string[];
}

export interface BoardStateSnapshot {
  revision: number;
  updatedAt: number;
  counts: Record<BoardColumn, number>;
  cards: BoardCard[];
  recentComments: BoardComment[];
}

export interface ProposeCardInput {
  id?: string;
  title: string;
  description?: string;
  owner?: string;
  agentSessionId?: string;
  modelTier?: CardModelTier;
  phase?: CardExecPhase;
  writeScopes?: readonly string[];
  blockedBy?: readonly string[];
  initialColumn?: 'backlog' | 'ready';
}

export interface MoveCardInput {
  cardId: string;
  toColumn: BoardColumn;
  actor: string;
  role?: BoardRole;
  reason?: string;
  expectedRevision?: number;
  owner?: string;
  agentSessionId?: string;
  modelTier?: CardModelTier;
  phase?: CardExecPhase;
  reviewFindings?: number;
  clearApproval?: boolean;
}

export interface UpdateCardMetaInput {
  modelTier?: CardModelTier;
  phase?: CardExecPhase;
  owner?: string;
  agentSessionId?: string;
}

export interface MoveCardOutcome {
  ok: boolean;
  status: 'moved' | 'conflict' | 'not_found' | 'blocked_by_dependencies' | 'invalid';
  card?: BoardCard;
  unblockedIds?: string[];
  scopeConflicts?: ScopeConflict[];
  reason?: string;
}

function normalizeModelTier(raw: unknown): CardModelTier | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const val = String(raw).trim();
  if ((CARD_MODEL_TIERS as readonly string[]).includes(val)) return val as CardModelTier;
  throw new Error(`invalid modelTier "${val}"; expected efficient|capable`);
}

function normalizeExecPhase(raw: unknown): CardExecPhase | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const val = String(raw).trim();
  if ((CARD_EXEC_PHASES as readonly string[]).includes(val)) return val as CardExecPhase;
  throw new Error(`invalid phase "${val}"; expected planning|executing|review|done`);
}

function normalizeScope(raw: string): string {
  const s = posix.normalize(raw.replace(/\\/g, '/').trim()).replace(/^\.\//, '').replace(/\/+$/, '');
  if (!s || s === '.' || s === '..' || s.startsWith('../') || s.startsWith('/')) {
    throw new Error(`invalid relative writeScope: "${raw}"`);
  }
  return s;
}

export function scopesOverlap(aRaw: string, bRaw: string): boolean {
  try {
    const a = normalizeScope(aRaw);
    const b = normalizeScope(bRaw);
    return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  } catch {
    return false;
  }
}

export class KanbanStore {
  private readonly dbPath: string;
  private readonly db: DatabaseSync;
  private readonly listeners = new Set<(snapshot: BoardStateSnapshot) => void>();

  constructor(dbPath: string) {
    this.dbPath = dbPath === ':memory:' ? ':memory:' : resolve(dbPath);
    this.db = this.open();
  }

  private open(): DatabaseSync {
    if (this.dbPath !== ':memory:') {
      mkdirSync(dirname(this.dbPath), { recursive: true, mode: 0o700 });
      if (existsSync(this.dbPath) && lstatSync(this.dbPath).isSymbolicLink()) {
        throw new Error(`refusing symlinked board database: ${this.dbPath}`);
      }
    }
    const db = new DatabaseSync(this.dbPath);
    if (this.dbPath !== ':memory:') chmodSync(this.dbPath, 0o600);
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
        model_tier TEXT,
        phase TEXT,
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
    const existingCols = new Set(
      (db.prepare('PRAGMA table_info(cards)').all() as Array<{ name: unknown }>).map((r) => String(r.name)),
    );
    if (!existingCols.has('model_tier')) {
      db.exec('ALTER TABLE cards ADD COLUMN model_tier TEXT');
    }
    if (!existingCols.has('phase')) {
      db.exec('ALTER TABLE cards ADD COLUMN phase TEXT');
    }
    return db;
  }

  private safeJson<T>(raw: unknown, fallback: T): T {
    if (typeof raw !== 'string' || !raw.trim()) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  private rowToCard(row: Record<string, unknown>): BoardCard {
    const rawTier = typeof row.model_tier === 'string' && (CARD_MODEL_TIERS as readonly string[]).includes(row.model_tier)
      ? (row.model_tier as CardModelTier)
      : undefined;
    const rawPhase = typeof row.phase === 'string' && (CARD_EXEC_PHASES as readonly string[]).includes(row.phase)
      ? (row.phase as CardExecPhase)
      : undefined;
    return {
      id: String(row.id),
      title: String(row.title),
      description: String(row.description ?? ''),
      column: String(row.col) as BoardColumn,
      revision: Number(row.revision ?? 1),
      owner: String(row.owner ?? ''),
      agentSessionId: row.agent_session_id ? String(row.agent_session_id) : undefined,
      ...(rawTier ? { modelTier: rawTier } : {}),
      ...(rawPhase ? { phase: rawPhase } : {}),
      writeScopes: this.safeJson<string[]>(row.write_scopes_json, []),
      blockedBy: this.safeJson<string[]>(row.blocked_by_json, []),
      approvalNeeded: this.safeJson<ApprovalBadge | null>(row.approval_json, null),
      reviewFindings: Number(row.review_findings ?? 0),
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
    };
  }

  private rowToComment(row: Record<string, unknown>): BoardComment {
    return {
      id: Number(row.id),
      cardId: String(row.card_id),
      author: String(row.author),
      role: String(row.role) as BoardRole,
      kind: String(row.kind) as CommentKind,
      body: String(row.body),
      createdAt: Number(row.created_at),
    };
  }

  private withTx<T>(fn: () => T): { result: T; changed: boolean } {
    this.db.exec('BEGIN IMMEDIATE');
    let txOpen = true;
    try {
      const res = fn();
      txOpen = false;
      this.db.exec('COMMIT');
      return { result: res, changed: true };
    } catch (err) {
      if (txOpen) {
        try { this.db.exec('ROLLBACK'); } catch { /* preserve primary failure */ }
      }
      throw err;
    }
  }

  private bumpBoardRev(nowMs: number): void {
    this.db.prepare('UPDATE board_meta SET revision = revision + 1, updated_at = ? WHERE id = 1').run(nowMs);
  }

  private emitChange(): void {
    if (this.listeners.size === 0) return;
    const snap = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snap);
      } catch {
        /* isolate subscriber failures */
      }
    }
  }

  subscribe(listener: (snapshot: BoardStateSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private detectCycle(candidateId: string, blockedBy: readonly string[], existingCards: readonly BoardCard[]): boolean {
    const depsMap = new Map<string, string[]>();
    for (const c of existingCards) depsMap.set(c.id, c.blockedBy);
    depsMap.set(candidateId, [...blockedBy]);

    // Full-graph cycle detection so downstream->upstream edges cannot close a cycle either.
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const dfs = (node: string): boolean => {
      if (visiting.has(node)) return true;
      if (visited.has(node)) return false;
      visiting.add(node);
      for (const dep of depsMap.get(node) ?? []) {
        if (dfs(dep)) return true;
      }
      visiting.delete(node);
      visited.add(node);
      return false;
    };
    for (const node of depsMap.keys()) {
      if (dfs(node)) return true;
    }
    return false;
  }

  private computeConflicts(
    cardId: string,
    writeScopes: readonly string[],
    allCards: readonly BoardCard[],
  ): ScopeConflict[] {
    if (writeScopes.length === 0) return [];
    const conflicts: ScopeConflict[] = [];
    for (const other of allCards) {
      if (other.id === cardId || other.column !== 'in_progress') continue;
      const overlap = writeScopes.filter((s) => other.writeScopes.some((os) => scopesOverlap(s, os)));
      if (overlap.length > 0) {
        conflicts.push({ cardId: other.id, cardTitle: other.title, overlappingScopes: overlap });
      }
    }
    return conflicts;
  }

  proposeCard(input: ProposeCardInput): { card: BoardCard; scopeConflicts: ScopeConflict[] } {
    const title = input.title?.trim();
    if (!title) throw new Error('card title must be non-empty');
    const id = (input.id?.trim() || `card_${randomUUID().slice(0, 8)}`).replace(/[^A-Za-z0-9_.:-]/g, '_');
    const modelTier = normalizeModelTier(input.modelTier);
    const phase = normalizeExecPhase(input.phase);
    const writeScopes = [...new Set((input.writeScopes ?? []).map(normalizeScope))];
    const blockedBy = [...new Set((input.blockedBy ?? []).map((b) => b.trim()).filter(Boolean))];
    if (blockedBy.includes(id)) throw new Error(`DAG cycle rejected: card "${id}" cannot block itself`);

    let outCard!: BoardCard;
    let conflicts: ScopeConflict[] = [];

    this.withTx(() => {
      const existingRows = this.db.prepare('SELECT * FROM cards').all() as Array<Record<string, unknown>>;
      const allCards = existingRows.map((r) => this.rowToCard(r));
      const byId = new Map(allCards.map((c) => [c.id, c]));

      if (byId.has(id)) throw new Error(`card "${id}" already exists`);
      for (const depId of blockedBy) {
        if (!byId.has(depId)) throw new Error(`unknown blockedBy dependency "${depId}"`);
      }
      if (this.detectCycle(id, blockedBy, allCards)) {
        throw new Error(`DAG cycle rejected involving "${id}" -> [${blockedBy.join(', ')}]`);
      }

      const hasUnmetDeps = blockedBy.some((depId) => byId.get(depId)?.column !== 'done');
      const col: BoardColumn = hasUnmetDeps ? 'backlog' : (input.initialColumn ?? 'ready');
      const now = Date.now();
      this.db
        .prepare(
          `INSERT INTO cards (id, title, description, col, revision, owner, agent_session_id, model_tier, phase, write_scopes_json, blocked_by_json, approval_json, review_findings, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)`,
        )
        .run(
          id,
          title.slice(0, 160),
          (input.description ?? '').trim().slice(0, 4000),
          col,
          (input.owner ?? 'unassigned').slice(0, 80),
          input.agentSessionId ?? null,
          modelTier ?? null,
          phase ?? null,
          JSON.stringify(writeScopes),
          JSON.stringify(blockedBy),
          now,
          now,
        );
      this.bumpBoardRev(now);
      outCard = this.rowToCard(
        this.db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as Record<string, unknown>,
      );
      conflicts = this.computeConflicts(id, writeScopes, allCards);
    });

    this.emitChange();
    return { card: outCard, scopeConflicts: conflicts };
  }

  /**
   * Add a dependency between existing cards while enforcing DAG acyclicity.
   */
  addDependency(cardId: string, blockedByCardId: string): BoardCard {
    let updated!: BoardCard;
    this.withTx(() => {
      const allCards = (this.db.prepare('SELECT * FROM cards').all() as Array<Record<string, unknown>>).map((r) =>
        this.rowToCard(r),
      );
      const card = allCards.find((c) => c.id === cardId);
      const dep = allCards.find((c) => c.id === blockedByCardId);
      if (!card) throw new Error(`card "${cardId}" not found`);
      if (!dep) throw new Error(`dependency card "${blockedByCardId}" not found`);
      const nextDeps = [...new Set([...card.blockedBy, blockedByCardId])];
      if (this.detectCycle(cardId, nextDeps, allCards)) {
        throw new Error(`DAG cycle rejected: "${cardId}" cannot depend on "${blockedByCardId}"`);
      }
      const now = Date.now();
      const nextCol: BoardColumn =
        dep.column !== 'done' && (card.column === 'ready' || card.column === 'in_progress') ? 'backlog' : card.column;
      this.db
        .prepare('UPDATE cards SET blocked_by_json = ?, col = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(nextDeps), nextCol, now, cardId);
      this.bumpBoardRev(now);
      updated = this.rowToCard(
        this.db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId) as Record<string, unknown>,
      );
    });
    this.emitChange();
    return updated;
  }

  moveCard(input: MoveCardInput): MoveCardOutcome {
    if (!BOARD_COLUMNS.includes(input.toColumn)) {
      return { ok: false, status: 'invalid', reason: `invalid column "${String(input.toColumn)}"` };
    }
    let reqTier: CardModelTier | undefined;
    let reqPhase: CardExecPhase | undefined;
    try {
      reqTier = normalizeModelTier(input.modelTier);
      reqPhase = normalizeExecPhase(input.phase);
    } catch (err) {
      return { ok: false, status: 'invalid', reason: err instanceof Error ? err.message : String(err) };
    }

    let outcome!: MoveCardOutcome;
    let shouldEmit = false;

    this.withTx(() => {
      const row = this.db.prepare('SELECT * FROM cards WHERE id = ?').get(input.cardId) as
        | Record<string, unknown>
        | undefined;
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

      const allCards = (this.db.prepare('SELECT * FROM cards').all() as Array<Record<string, unknown>>).map((r) =>
        this.rowToCard(r),
      );
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
      const nextTier = input.modelTier !== undefined ? reqTier : card.modelTier;
      const nextPhase =
        input.phase !== undefined
          ? reqPhase
          : input.toColumn === 'done' && card.phase
            ? 'done'
            : input.toColumn === 'review' && card.phase
              ? 'review'
              : card.phase;
      this.db
        .prepare(
          `UPDATE cards
           SET col = ?, revision = revision + 1, owner = ?, agent_session_id = ?, model_tier = ?, phase = ?, approval_json = ?, review_findings = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.toColumn,
          input.owner ?? card.owner,
          input.agentSessionId !== undefined ? input.agentSessionId : card.agentSessionId ?? null,
          nextTier ?? null,
          nextPhase ?? null,
          nextApproval ? JSON.stringify(nextApproval) : null,
          nextFindings,
          now,
          card.id,
        );

      if (input.reason?.trim()) {
        this.db
          .prepare('INSERT INTO comments (card_id, author, role, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(card.id, input.actor, input.role ?? 'human', 'status', `[-> ${input.toColumn}] ${input.reason.trim()}`, now);
      }

      const unblockedIds: string[] = [];
      if (input.toColumn === 'done') {
        const refreshed = (this.db.prepare('SELECT * FROM cards').all() as Array<Record<string, unknown>>).map((r) =>
          this.rowToCard(r),
        );
        const doneSet = new Set(refreshed.filter((c) => c.column === 'done').map((c) => c.id));
        for (const candidate of refreshed) {
          if (candidate.column === 'backlog' && candidate.blockedBy.length > 0 && candidate.blockedBy.every((d) => doneSet.has(d))) {
            this.db.prepare('UPDATE cards SET col = ?, revision = revision + 1, updated_at = ? WHERE id = ?').run('ready', now, candidate.id);
            unblockedIds.push(candidate.id);
          }
        }
      }

      this.bumpBoardRev(now);
      const updated = this.rowToCard(this.db.prepare('SELECT * FROM cards WHERE id = ?').get(card.id) as Record<string, unknown>);
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

    if (shouldEmit) this.emitChange();
    return outcome;
  }

  /**
   * Update execution phase, modelTier, owner, or session binding without changing column.
   */
  updateCardMeta(cardId: string, patch: UpdateCardMetaInput): BoardCard | undefined {
    const nextTier = patch.modelTier !== undefined ? normalizeModelTier(patch.modelTier) : undefined;
    const nextPhase = patch.phase !== undefined ? normalizeExecPhase(patch.phase) : undefined;
    let updated: BoardCard | undefined;
    let changed = false;

    this.withTx(() => {
      const row = this.db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId) as Record<string, unknown> | undefined;
      if (!row) return;
      const card = this.rowToCard(row);
      const now = Date.now();
      this.db
        .prepare(
          `UPDATE cards
           SET model_tier = ?, phase = ?, owner = ?, agent_session_id = ?, revision = revision + 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          patch.modelTier !== undefined ? (nextTier ?? null) : (card.modelTier ?? null),
          patch.phase !== undefined ? (nextPhase ?? null) : (card.phase ?? null),
          patch.owner !== undefined ? patch.owner.slice(0, 80) : card.owner,
          patch.agentSessionId !== undefined ? patch.agentSessionId : (card.agentSessionId ?? null),
          now,
          card.id,
        );
      this.bumpBoardRev(now);
      updated = this.rowToCard(this.db.prepare('SELECT * FROM cards WHERE id = ?').get(card.id) as Record<string, unknown>);
      changed = true;
    });

    if (changed) this.emitChange();
    return updated;
  }

  addComment(input: { cardId: string; author: string; role?: BoardRole; kind?: CommentKind; body: string }): BoardComment {
    if (!input.body?.trim()) throw new Error('comment body must be non-empty');
    let comment!: BoardComment;
    this.withTx(() => {
      const exists = this.db.prepare('SELECT id FROM cards WHERE id = ?').get(input.cardId);
      if (!exists) throw new Error(`card "${input.cardId}" not found`);
      const now = Date.now();
      const info = this.db
        .prepare('INSERT INTO comments (card_id, author, role, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(input.cardId, input.author, input.role ?? 'system', input.kind ?? 'note', input.body.trim().slice(0, 4000), now);
      this.bumpBoardRev(now);
      const row = this.db.prepare('SELECT * FROM comments WHERE id = ?').get(Number(info.lastInsertRowid)) as Record<string, unknown>;
      comment = this.rowToComment(row);
    });
    this.emitChange();
    return comment;
  }

  flagApprovalNeeded(req: { cardId?: string; agentSessionId?: string; toolName: string; reason: string }): BoardCard {
    let updated!: BoardCard;
    this.withTx(() => {
      const rows = this.db.prepare('SELECT * FROM cards').all() as Array<Record<string, unknown>>;
      const cards = rows.map((r) => this.rowToCard(r));
      const target = req.cardId
        ? cards.find((c) => c.id === req.cardId)
        : req.agentSessionId
          ? cards.find((c) => c.agentSessionId === req.agentSessionId && c.column === 'in_progress')
          : undefined;

      const now = Date.now();
      const badge: ApprovalBadge = { toolName: req.toolName, reason: req.reason.slice(0, 500), requestedAt: now };

      if (target) {
        this.db
          .prepare('UPDATE cards SET col = ?, approval_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
          .run('blocked', JSON.stringify(badge), now, target.id);
        this.db
          .prepare('INSERT INTO comments (card_id, author, role, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(target.id, 'cuga', 'cuga', 'approval', `Approval needed (${req.toolName}): ${req.reason}`, now);
        this.bumpBoardRev(now);
        updated = this.rowToCard(this.db.prepare('SELECT * FROM cards WHERE id = ?').get(target.id) as Record<string, unknown>);
      } else {
        const id = `approval_${randomUUID().slice(0, 8)}`;
        this.db
          .prepare(
            `INSERT INTO cards (id, title, description, col, revision, owner, agent_session_id, write_scopes_json, blocked_by_json, approval_json, review_findings, created_at, updated_at)
             VALUES (?, ?, ?, 'blocked', 1, 'human', ?, '[]', '[]', ?, 0, ?, ?)`,
          )
          .run(id, `Approve: ${req.toolName}`, req.reason.slice(0, 1000), req.agentSessionId ?? null, JSON.stringify(badge), now, now);
        this.bumpBoardRev(now);
        updated = this.rowToCard(this.db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as Record<string, unknown>);
      }
    });
    this.emitChange();
    return updated;
  }

  activeWriteScopesForSession(sessionId: string): string[] | undefined {
    const rows = this.db
      .prepare("SELECT write_scopes_json FROM cards WHERE agent_session_id = ? AND col = 'in_progress'")
      .all(sessionId) as Array<{ write_scopes_json: string }>;
    if (rows.length === 0) return undefined;
    const scopes = rows.flatMap((r) => this.safeJson<string[]>(r.write_scopes_json, []));
    return scopes.length > 0 ? [...new Set(scopes)] : undefined;
  }

  getCard(id: string): BoardCard | undefined {
    const row = this.db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToCard(row) : undefined;
  }

  /**
   * Return all comments for a card in chronological order.
   */
  getComments(cardId: string): BoardComment[] {
    const rows = this.db
      .prepare('SELECT * FROM comments WHERE card_id = ? ORDER BY id ASC')
      .all(cardId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToComment(r));
  }

  snapshot(): BoardStateSnapshot {
    const meta = this.db.prepare('SELECT revision, updated_at FROM board_meta WHERE id = 1').get() as {
      revision: number;
      updated_at: number;
    };
    const cardRows = this.db.prepare('SELECT * FROM cards ORDER BY updated_at DESC').all() as Array<Record<string, unknown>>;
    const cards = cardRows.map((r) => this.rowToCard(r));
    const counts: Record<BoardColumn, number> = {
      backlog: 0,
      ready: 0,
      in_progress: 0,
      review: 0,
      done: 0,
      blocked: 0,
    };
    for (const c of cards) {
      if (c.column in counts) counts[c.column] += 1;
    }
    const commentRows = this.db
      .prepare('SELECT * FROM comments ORDER BY id DESC LIMIT 20')
      .all() as Array<Record<string, unknown>>;
    const recentComments: BoardComment[] = commentRows.map((r) => this.rowToComment(r));
    return {
      revision: Number(meta?.revision ?? 1),
      updatedAt: Number(meta?.updated_at ?? 0),
      counts,
      cards,
      recentComments,
    };
  }

  digest(): string {
    const snap = this.snapshot();
    if (snap.cards.length === 0) return '';
    const active = snap.cards
      .filter((c) => c.column === 'in_progress' || c.column === 'review')
      .slice(0, 3)
      .map((c) => `${c.id}(${c.column}${c.phase ? `/${c.phase}` : ''}${c.modelTier ? `:${c.modelTier}` : ''})`)
      .join(', ');
    const alerts = snap.cards
      .filter((c) => c.approvalNeeded || c.column === 'review' || c.column === 'blocked')
      .slice(0, 3)
      .map((c) => `${c.id}(${c.column}${c.approvalNeeded ? ':APPROVAL' : ''})`)
      .join(', ');
    const summary = `backlog:${snap.counts.backlog} ready:${snap.counts.ready} in_progress:${snap.counts.in_progress} review:${snap.counts.review} done:${snap.counts.done} blocked:${snap.counts.blocked}`;
    return `<ns-board rev="${snap.revision}" summary="${summary}"${active ? ` active="${active}"` : ''}${alerts ? ` attention="${alerts}"` : ''} />`;
  }

  close(): void {
    this.db.close();
  }
}
