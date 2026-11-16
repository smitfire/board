import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { KanbanStore, type BoardStateSnapshot } from '../core/index.js';
export declare const name = "ns-board";
export declare const inject: readonly ["tools", "commands", "systemPrompt"];
export interface PluginConfig {
    dbPath: string;
}
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    dbPath: z<string, string, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    dbPath: z<string, string, "defined">;
}>>, "plain">;
declare module '@deepseek-ai/cordis' {
    interface Context {
        nsBoard?: KanbanStore;
    }
}
export declare function formatBoardText(snap: BoardStateSnapshot): string;
export declare function apply(ctx: Context, rawConfig?: Partial<PluginConfig>): void;
export declare const defaultDbRelativePath: string;
//# sourceMappingURL=index.d.ts.map