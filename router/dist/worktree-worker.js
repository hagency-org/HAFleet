import { WorktreeManager } from './worktree.js';
process.once('message', (message) => {
    try {
        const value = new WorktreeManager().ensure(message);
        process.send?.({ ok: true, value }, () => process.disconnect?.());
    }
    catch (error) {
        process.send?.({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        }, () => process.disconnect?.());
    }
});
