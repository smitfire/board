export declare const BOARD_COLUMNS: readonly ["backlog", "ready", "in_progress", "review", "done", "blocked"];
export type BoardColumn = (typeof BOARD_COLUMNS)[number];
export declare const CARD_MODEL_TIERS: readonly ["efficient", "capable"];
export type CardModelTier = (typeof CARD_MODEL_TIERS)[number];
export declare const CARD_EXEC_PHASES: readonly ["planning", "executing", "review", "done"];
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
export declare function scopesOverlap(aRaw: string, bRaw: string): boolean;
export declare class KanbanStore {
    private readonly dbPath;
    private readonly db;
    private readonly listeners;
    constructor(dbPath: string);
    private open;
    private safeJson;
    private rowToCard;
    private rowToComment;
    private withTx;
    private bumpBoardRev;
    private emitChange;
    subscribe(listener: (snapshot: BoardStateSnapshot) => void): () => void;
    private detectCycle;
    private computeConflicts;
    proposeCard(input: ProposeCardInput): {
        card: BoardCard;
        scopeConflicts: ScopeConflict[];
    };
    /**
     * Add a dependency between existing cards while enforcing DAG acyclicity.
     */
    addDependency(cardId: string, blockedByCardId: string): BoardCard;
    moveCard(input: MoveCardInput): MoveCardOutcome;
    /**
     * Update execution phase, modelTier, owner, or session binding without changing column.
     */
    updateCardMeta(cardId: string, patch: UpdateCardMetaInput): BoardCard | undefined;
    addComment(input: {
        cardId: string;
        author: string;
        role?: BoardRole;
        kind?: CommentKind;
        body: string;
    }): BoardComment;
    flagApprovalNeeded(req: {
        cardId?: string;
        agentSessionId?: string;
        toolName: string;
        reason: string;
    }): BoardCard;
    activeWriteScopesForSession(sessionId: string): string[] | undefined;
    getCard(id: string): BoardCard | undefined;
    /**
     * Return all comments for a card in chronological order.
     */
    getComments(cardId: string): BoardComment[];
    snapshot(): BoardStateSnapshot;
    digest(): string;
    close(): void;
}
//# sourceMappingURL=kanban-store.d.ts.map