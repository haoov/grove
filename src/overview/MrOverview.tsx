import { useEffect, useMemo, useState } from 'react';
import { forgeName, mrRef } from '../shared/lib/forge';
import { invoke } from '../shared/ipc/invoke';
import {
  GitPullRequest, GitMerge, GitPullRequestClosed, ExternalLink, GitBranch, ThumbsUp, Send, Check,
  Pencil, Loader2,
} from 'lucide-react';
import { useStore, useSession } from '../shared/store';
import type { MrDetails } from '../shared/ipc/ipc';
import { openExternal } from '../shared/lib/openExternal';
import { MrThreadsSection } from '../notes/MrThreads';
import { CiChip } from '../shared/ui/CiChip';
import { Markdown } from '../shared/ui/Markdown';

/** Full-page MR/PR overview — the task overview's layout applied to a merge
 *  request: id + title header, a details column, description, review threads. */
export function MrOverview({ repoId, mrId }: { repoId: string; mrId: string }) {
  const mrs = useSession((s) => s.mrs);
  const mrThreadsByRepo = useSession((s) => s.mrThreadsByRepo);
  const bumpMrs = useSession((s) => s.bumpMrs);
  const mrNonce = useSession((s) => s.mrNonce);
  const kind = useSession((s) => s.kind);
  const notify = useStore((s) => s.notify);

  const mr = useMemo(() => mrs.find((m) => m.id === mrId) ?? null, [mrs, mrId]);
  const threads = mrThreadsByRepo[repoId] ?? [];

  const [details, setDetails] = useState<MrDetails | null>(null);
  const [ci, setCi] = useState<{ status: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [comment, setComment] = useState('');
  const [posting, setPosting] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [draft, setDraft] = useState('');
  const [savingDesc, setSavingDesc] = useState(false);

  const saveDescription = async () => {
    if (savingDesc) return;
    setSavingDesc(true);
    try {
      await invoke('edit_mr_text', { mrId, description: draft });
      setEditingDesc(false);
      // Re-read so the rendered markdown matches what the forge now holds
      // (the backend re-appends the task footer, so it is not what we sent).
      bumpMrs();
    } catch (e) {
      setError(String(e));
    } finally {
      setSavingDesc(false);
    }
  };

  const approve = async () => {
    if (approving) return;
    setApproving(true);
    try {
      await invoke('approve_mr', { mrId });
      notify({ kind: 'success', source: 'mr', title: `Approved ${mrRef(mr?.platform ?? '', mr?.remote_id ?? '')}` });
      // Re-read details (and Home's cached signals were just invalidated), so the
      // approved badge appears without a manual refresh.
      bumpMrs();
    } catch (e) {
      notify({ kind: 'error', source: 'mr', title: `Approve failed: ${e}` });
    } finally {
      setApproving(false);
    }
  };

  const postComment = async () => {
    const body = comment.trim();
    if (!body || posting) return;
    setPosting(true);
    try {
      await invoke('post_mr_comment', { mrId, body, filePath: null, line: null });
      setComment('');
      bumpMrs(); // the new note shows up in Discussion
    } catch (e) {
      notify({ kind: 'error', source: 'mr', title: `Comment failed: ${e}` });
    } finally {
      setPosting(false);
    }
  };

  // Live-fetch the rich fields; refetch when the MR data is invalidated
  // (a push, an mr.* op, the sidebar's refresh button) so the overview tracks remote state.
  useEffect(() => {
    let stale = false;
    invoke<MrDetails>('get_mr_details', { mrId })
      .then((d) => { if (!stale) { setDetails(d); setError(null); } })
      .catch((e) => { if (!stale) setError(String(e)); });
    invoke<{ status: string; url: string } | null>('get_mr_ci', { mrId })
      .then((r) => { if (!stale) setCi(r ?? null); })
      .catch(() => { if (!stale) setCi(null); });
    return () => { stale = true; };
  }, [mrId, mrNonce]);

  if (!mr) {
    return (
      <div className="overview-view">
        <div className="overview-inner">
          <p className="overview-empty-body">This merge request is no longer tracked.</p>
        </div>
      </div>
    );
  }

  const isGithub = mr.platform === 'github';
  const shortKind = isGithub ? 'PR' : 'MR';
  const num = mrRef(mr.platform, mr.remote_id);
  const state = details?.state ?? mr.state;
  const url = details?.web_url || mr.url;
  const StateIcon = state === 'merged' ? GitMerge : state === 'closed' ? GitPullRequestClosed : GitPullRequest;

  return (
    <div className="overview-view">
      <div className="overview-inner">
        <header className="overview-header">
          <span className="overview-task-id">
            <StateIcon size={13} strokeWidth={1.75} style={{ marginRight: 6, verticalAlign: 'middle' }} />
            {shortKind} {num}
          </span>
          <h1 className="overview-title">{details?.title || `${shortKind} ${num}`}</h1>
          <span className="overview-spring" />
          <div className="mr-header-actions">
            {kind === 'review' && state === 'open' && (
              <button
                className="finish-task-btn mr-approve-btn"
                onClick={approve}
                disabled={approving || details?.approved_by_me === true}
                title={
                  details?.approved_by_me
                    ? 'You already approved this'
                    : `Approve this ${shortKind} as reviewer`
                }
              >
                <ThumbsUp size={13} strokeWidth={1.75} style={{ marginRight: 6 }} />
                {approving ? 'Approving…' : details?.approved_by_me ? 'Approved' : 'Approve'}
              </button>
            )}
            <button className="finish-task-btn ov-update mr-open-btn" onClick={() => openExternal(url)}>
              <ExternalLink size={13} strokeWidth={1.75} style={{ marginRight: 6 }} />
              Open in {forgeName(mr.platform)}
            </button>
          </div>
        </header>

        {/* State / draft / approval / CI as a badge row under the title. */}
        <div className="mr-badges">
          <span className={`overview-badge mr-state-${state}`}>{state}</span>
          {details?.draft && <span className="overview-badge">draft</span>}
          {details?.approved && (
            <span className="overview-badge mr-approved" title={
              details.approved_by?.length
                ? `Approved by ${details.approved_by.join(', ')}`
                : 'Approved'
            }>
              <Check size={11} strokeWidth={2.5} />
              {details.approved_by_me ? 'approved by you' : 'approved'}
            </span>
          )}
          {ci && (
            <CiChip status={ci.status} url={ci.url || url} platform={mr.platform} className="overview-badge overview-ci">
              <span className="forge-ci-dot" />
              CI · {ci.status.replace(/_/g, ' ')}
            </CiChip>
          )}
        </div>

        <div className="overview-grid">
          <main className="overview-main">
            <section className="overview-section">
              <h3 className="overview-section-title">
                Description
                {details !== null && !editingDesc && (
                  <button
                    className="home-link overview-section-action"
                    onClick={() => { setDraft(details.description ?? ''); setEditingDesc(true); }}
                  >
                    <Pencil size={11} strokeWidth={2} />
                    edit
                  </button>
                )}
              </h3>
              {error ? (
                <p className="overview-empty-body">{error}</p>
              ) : details === null ? (
                <p className="overview-empty-body">Loading…</p>
              ) : editingDesc ? (
                <div className="mr-desc-editor">
                  <textarea
                    className="composer-body"
                    autoFocus
                    spellCheck={false}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="Markdown — ## What then ## Why"
                  />
                  <div className="mr-desc-actions">
                    {/* The task link is re-appended by the backend, so it survives
                        an edit even though it is not in the box. */}
                    <span className="composer-note">Saved straight to the merge request.</span>
                    <button className="btn-secondary" onClick={() => setEditingDesc(false)} disabled={savingDesc}>
                      Cancel
                    </button>
                    <button className="btn-primary" onClick={saveDescription} disabled={savingDesc}>
                      {savingDesc ? <Loader2 size={11} className="spin" /> : null}
                      Save
                    </button>
                  </div>
                </div>
              ) : details.description ? (
                <Markdown text={details.description} />
              ) : (
                <p className="overview-empty-body">No description.</p>
              )}
            </section>

            <section className="overview-section">
              <h3 className="overview-section-title">Discussion</h3>
              {threads.length === 0 ? (
                <p className="overview-empty-body">No review threads.</p>
              ) : (
                <MrThreadsSection threads={threads} mr={mr} onResolved={bumpMrs} />
              )}
              <div className="mr-comment-composer">
                <textarea
                  className="mr-comment-input"
                  placeholder={`Comment on this ${shortKind}…`}
                  rows={2}
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  disabled={posting}
                />
                <button
                  className="btn-secondary mr-comment-post"
                  onClick={postComment}
                  disabled={posting || !comment.trim()}
                >
                  <Send size={12} strokeWidth={1.75} style={{ marginRight: 5 }} />
                  {posting ? 'Posting…' : 'Post to MR'}
                </button>
              </div>
            </section>
          </main>

          <aside className="overview-side">
            <section className="overview-section">
              <h3 className="overview-section-title">Details</h3>
              <dl className="mr-facts">
                {details?.author && (
                  <div className="mr-fact">
                    <dt>Author</dt>
                    <dd>{details.author}</dd>
                  </div>
                )}
                {details?.source_branch && (
                  <div className="mr-fact">
                    <dt>Branch</dt>
                    <dd className="mr-fact-branches">
                      <GitBranch size={11} strokeWidth={1.75} />
                      <span className="overview-repo-branch">{details.source_branch}</span>
                      <span className="mr-meta-arrow">→</span>
                      <span className="overview-repo-branch">{details.target_branch}</span>
                    </dd>
                  </div>
                )}
                <div className="mr-fact">
                  <dt>Platform</dt>
                  <dd>{forgeName(mr.platform)}</dd>
                </div>
              </dl>
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
