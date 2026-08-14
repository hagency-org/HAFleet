import { WorktreeManager, type WorktreeSpec } from './worktree.js';

process.once('message', (message: unknown) => {
  try {
    const value = new WorktreeManager().ensure(message as WorktreeSpec);
    process.send?.({ ok: true, value }, () => process.disconnect?.());
  } catch (error) {
    process.send?.({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }, () => process.disconnect?.());
  }
});
