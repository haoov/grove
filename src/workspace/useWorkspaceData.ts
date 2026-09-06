import { useEffect } from 'react';
import { invoke } from '../shared/ipc/invoke';
import { useStore, useSession } from '../shared/store';
import type { Annotation, DiffResult, Mr } from '../shared/ipc/ipc';

/**
 * Owns the per-task background data that several views depend on: git status,
 * merge requests + their threads, and annotations. Previously these lived inside
 * the Sidebar component, so they only ran while the sidebar was mounted / on the
 * right tab. Hosting them here (from WorkspaceLayout) makes them available to the
 * diff repo headers, the grouped sidebar, and the annotation gutter uniformly.
 */
export function useWorkspaceData() {
  const activeTask = useSession((s) => s.activeTask);
  const activeWorktrees = useSession((s) => s.activeWorktrees);
  const refreshStatus = useSession((s) => s.refreshStatus);
  const upsertMr = useSession((s) => s.upsertMr);
  const setMrThreadsForRepo = useSession((s) => s.setMrThreadsForRepo);
  const setAnnotations = useSession((s) => s.setAnnotations);
  const diffMode = useSession((s) => s.diffMode);
  const diffNonce = useSession((s) => s.diffNonce);
  const mrNonce = useSession((s) => s.mrNonce);
  const setDiff = useSession((s) => s.setDiff);
  const setLastError = useStore((s) => s.setLastError);

  // Git status for every active worktree (re-runs when the worktree set changes).
  useEffect(() => {
    if (activeTask) refreshStatus();
  }, [activeTask, activeWorktrees, refreshStatus]);

  // Diff summary (paths + counts) for the whole task. Centralized here so the
  // sidebar's changed-files list and the workspace diff tabs share it, regardless
  // of which main view is showing. Reloads on task / mode / manual-refresh change.
  useEffect(() => {
    if (!activeTask) return;
    // Ordering guard: a mode/nonce change can fire a new fetch before the previous
    // one resolves; ignore any resolution from a superseded (stale) run.
    let stale = false;
    invoke<DiffResult>('get_task_diff_summary', { taskId: activeTask.short_id, mode: diffMode })
      .then((d) => { if (!stale) setDiff(d); })
      .catch((e) => { if (!stale) setLastError(String(e)); });
    return () => { stale = true; };
  }, [activeTask, diffMode, diffNonce, setDiff, setLastError]);

  // MR + threads per repo. Re-runs when mrNonce bumps: after a push, an mr.* op
  // landing via the confirmation bridge, or the sidebar's refresh button.
  useEffect(() => {
    if (!activeTask || !activeWorktrees.length) return;
    let stale = false;
    activeWorktrees.forEach(async (wt) => {
      try {
        const mrs = await invoke<Mr[]>('get_mr', { worktreeId: wt.id });
        if (stale) return;
        const mr = mrs[0] ?? null;
        if (mr) {
          upsertMr(mr);
          try {
            const raw = await invoke<unknown>('get_mr_threads', { mrId: mr.id });
            if (!stale) setMrThreadsForRepo(wt.repo_id, Array.isArray(raw) ? raw : []);
          } catch (e) {
            console.error('[get_mr_threads]', e);
          }
        } else {
          setMrThreadsForRepo(wt.repo_id, []);
        }
      } catch {
        /* no MR for this worktree */
      }
    });
    return () => { stale = true; };
  }, [activeTask, activeWorktrees, mrNonce, upsertMr, setMrThreadsForRepo]);


  // All annotations for the task (every repo), so the diff gutter shows them
  // without first visiting the Notes tab.
  useEffect(() => {
    if (!activeTask) return;
    invoke<Annotation[]>('get_annotations', { sessionId: activeTask.short_id, repoId: null })
      .then(setAnnotations)
      .catch((e) => setLastError(String(e)));
  }, [activeTask, setAnnotations, setLastError]);
}
