// Store contracts: the shapes every component and reducer agrees on.
//
// Split out of index.ts so the pure session logic (session.ts) can import them
// without a cycle through the store itself. index.ts re-exports everything here,
// so `import type { SessionState } from './'` keeps working.

import type {
  Task, Repo, Worktree, Mr, MrThread, Annotation, DiffResult, Hunk, CommitEntry,
  WorktreeStatus, BlameLine, AgentActivity, ConfirmationDto, Config, ThemeName,
  ReviewMr, HomeEntry, AgentSkill,
} from '../ipc/ipc';
import type { LayoutNode, SplitDir } from '../lib/layout';
import type { Chord } from '../lib/keys';
import type { CommandId, Keymap } from '../lib/keybindings';

/** Which header context picker is open, or none. */
export type PickerKind = 'session' | 'repo' | 'worktree' | null;

// ─── The app store's own contract ────────────────────────────────────────────

/** A content-search hit the editor should mark: the needle, and the 1-based line it
 *  was found on. The line is what keeps the preview to the selected row's match
 *  rather than every occurrence in the file. */
export interface GrepHighlight {
  query: string;
  line: number;
}

export interface UiSlice {
  // ── Navigation ────────────────────────────────────────────────────────────
  view: AppView;
  setView: (v: AppView) => void;

  // ── Sidebar list focus ──────────────────────────────────────────────────────
  // Bumped by the panel.* shortcuts so the focused list grabs DOM focus for
  // keyboard (vim) navigation.
  panelFocusNonce: number;
  requestPanelFocus: () => void;
  /** Bumped to pull DOM focus into the Source-control commit box. Also flips the
   *  active session's sidebar to the git tab so the commit box is mounted. */
  commitFocusNonce: number;
  requestCommitFocus: () => void;
  /** Bumped by Alt+F / Ctrl+Shift+F to focus the file-search input; `fileSearchMode`
   *  selects filename vs content search when it lands. */
  fileSearchFocusNonce: number;
  fileSearchMode: 'name' | 'text';
  requestFileSearchFocus: (mode?: 'name' | 'text') => void;

  // ── Grep match highlight ────────────────────────────────────────────────────
  // The ONE match the Files panel's text-search cursor sits on, highlighted in the
  // editor preview. Null = off.
  grepHighlight: GrepHighlight | null;
  setGrepHighlight: (h: GrepHighlight | null) => void;

  // ── Terminal focus ──────────────────────────────────────────────────────────
  // Bumped by the terminal keybinding to pull DOM focus into the active terminal
  // (read by PtyTabBody). A nonce, so repeat presses re-fire.
  terminalFocusReq: number | null;
  requestTerminalFocus: () => void;
  /** The bottom terminal dock on Home. A workspace has panes for this; Home does
   *  not, so the shell lives app-level there — like the agent console. */
  terminalConsoleOpen: boolean;
  setTerminalConsoleOpen: (v: boolean) => void;

  // ── Command palette / overlays ─────────────────────────────────────────────
  commandPaletteOpen: boolean;
  setCommandPaletteOpen: (v: boolean) => void;
  /** Ask the file tree to expand down to a directory (breadcrumb clicks). The
   *  nonce makes repeat requests for the same path fire again. */
  revealDir: { path: string; nonce: number } | null;
  revealInTree: (path: string) => void;
  /** Which header context picker is open (Alt+S / Alt+R / Alt+W), or none. Only
   *  one at a time. Pressing the same shortcut again moves the highlight. */
  openPicker: PickerKind;
  setOpenPicker: (p: PickerKind) => void;
  /** Highlighted row in the open picker. The shortcut advances it; Enter (or a
   *  click) commits. Shared because only one picker is open at a time. */
  pickerCursor: number;
  setPickerCursor: (n: number) => void;
  /** Alt+Shift+R add-repo wizard. One flag, so the two buttons that used to hold
   *  their own local state and the keybinding all open the same instance. */
  addRepoOpen: boolean;
  addWorktreeOpen: boolean;
  setAddRepoOpen: (v: boolean) => void;
  setAddWorktreeOpen: (v: boolean) => void;

  // ── Settings ──────────────────────────────────────────────────────────────
  /** Which view closing settings returns to — the one it was opened from. */
  settingsReturnTo: AppView;
  openSettings: () => void;
  closeSettings: () => void;

  // ── Editor: Vim mode (persisted to localStorage) ───────────────────────────
  vimMode: boolean;
  setVimMode: (v: boolean) => void;

  // ── Task open wizard ──────────────────────────────────────────────────────
}

export interface HomeSlice {
  // ── Review queue (Home + rail badge) ────────────────────────────────────────
  /** Open MRs where the user is a reviewer. Null until the first fetch lands. */
  reviewQueue: ReviewMr[] | null;
  /** Refetch the queue (silent-warn on failure — glab may be unavailable). */
  refreshReviewQueue: () => Promise<void>;

  // ── Home snapshot (local state of every live session) ───────────────────────
  /** Per-session repo/worktree/MR state. Null until the first fetch lands. */
  homeSnapshot: HomeEntry[] | null;
  /** True while a refresh is in flight (drives the refresh spinner). */
  homeLoading: boolean;
  /** Refetch. `forceMr` also bypasses the cached CI/thread counts (manual refresh). */
  refreshHome: (forceMr?: boolean) => Promise<void>;

  // ── Task list ─────────────────────────────────────────────────────────────
  tasks: Task[];
  setTasks: (tasks: Task[]) => void;
  /** Re-read the queue from every configured source. */
  refreshTasks: () => Promise<void>;
  upsertTask: (task: Task) => void;
}

export interface SessionsSlice {
  sessions: Record<string, SessionState>;
  sessionOrder: string[];
  activeSessionId: string | null;
  /** Open (or focus, for an already-open task) a session and make it active.
   *  `focus: false` registers it without navigating. */
  openSession: (input: { kind: SessionKind; task?: Task | null; worktrees?: Worktree[]; repos?: Repo[]; focus?: boolean }) => string;
  focusSession: (id: string) => void;
  /** Remove a session from the store (pure state — stop its PTYs first via endSession). */
  closeSession: (id: string) => void;
  /** Patch one session's state (object patch or recipe). Used by event handlers. */
  updateSession: (id: string, patch: Partial<SessionState> | ((s: SessionState) => Partial<SessionState>)) => void;
  /** Recompute a session's worktree git status (for non-hook event handlers). */
  refreshStatusFor: (id: string) => Promise<void>;
  /** Force a diff reload for a session: bump its diffNonce (re-fetches the
   *  summary) and clear cached hunks (re-fetches expanded files). Keeps the
   *  current diff visible until the refetch lands, so there's no flicker. */
  invalidateDiff: (id: string) => void;
  /** Force an MR + threads reload for a session (after mr.* ops land). */
  invalidateMrs: (id: string) => void;
}

export interface ConfirmationsSlice {
  pendingConfirmations: ConfirmationDto[];
  addConfirmation: (c: ConfirmationDto) => void;
  removeConfirmation: (id: string) => void;
  /** True while the approvals modal is deferred (Esc / "Later"). The queue stays
   *  pending and the statusbar badge stays lit; a NEW confirmation un-defers. */
  confirmationsMinimized: boolean;
  setConfirmationsMinimized: (v: boolean) => void;
}

export interface AgentSlice {
  /** What each agent is doing, keyed by TASK short id. Reported by Claude Code
   *  hooks (src-tauri/src/agent_hooks) — a task absent from the map has no agent
   *  running, or one that started before this build and never reported. */
  agentActivity: Record<string, AgentActivity>;
  setAgentActivity: (a: AgentActivity) => void;
  dropAgentActivity: (taskId: string) => void;
  hydrateAgentActivity: () => Promise<void>;
  /** The agent console is expanded. It always addresses the FOCUSED session — no
   *  picker, so "the agent I'm talking to" is whatever the window is showing. It
   *  is also the agent's ONLY surface: there is no agent tab. */
  consoleOpen: boolean;
  setConsoleOpen: (v: boolean) => void;
  /** Bumped by the keybinding to pull DOM focus into the console's terminal. */
  consoleFocusNonce: number;
  requestConsoleFocus: () => void;
  /** The agent column fills the body. `pane.maximize` toggles it when focus is
   *  inside the agent, so one shortcut maximizes whichever pane you are in. */
  agentMaximized: boolean;
  setAgentMaximized: (v: boolean) => void;
  /** The agent lives in its own OS window. The docked column is not rendered,
   *  so the main window keeps the width. Persisted across restarts. */
  agentDetached: boolean;
  setAgentDetached: (v: boolean) => void;
  /** The running-agents list is showing, as a column of the agent panel — in the
   *  docked console or in the window, whichever is the surface. Persisted. */
  agentsSidebarOpen: boolean;
  setAgentsSidebarOpen: (v: boolean) => void;
  /** Its width, dragged within a small range. Persisted. */
  agentsSidebarWidth: number;
  setAgentsSidebarWidth: (w: number) => void;
}

export interface KeybindingsSlice {
  // Defaults + user overrides, persisted to localStorage.
  keymap: Keymap;
  setBinding: (id: CommandId, chords: Chord[]) => void;
  /** Put one command back on this platform's default. */
  resetBinding: (id: CommandId) => void;
  resetKeymap: () => void;
  /** True while the Settings rebind UI is capturing a keystroke (suspends the
   *  global keymap so the captured chord isn't also run as a command). */
  capturingKey: boolean;
  setCapturingKey: (v: boolean) => void;
}

export interface ConfigSlice {
  config: Config | null;
  setConfig: (c: Config | null) => void;
  setTheme: (theme: ThemeName) => void;
  setFontSize: (px: number) => void;
  setFontFamily: (family: string) => void;
  setAgentFontFamily: (family: string) => void;
  setSuggestActions: (v: boolean) => void;

  // ── Status ────────────────────────────────────────────────────────────────
  syncStatus: 'idle' | 'syncing' | 'error';
  setSyncStatus: (s: 'idle' | 'syncing' | 'error') => void;
  lastError: string | null;
  setLastError: (e: string | null) => void;
}

export interface SkillsSlice {
  /** What the agent can be asked to do, core first. Loaded once at startup and
   *  after the user edits their own; the pill filters it by session kind. */
  skills: AgentSkill[];
  loadSkills: () => Promise<void>;
  /** A skill file changed since the agents started. They load skills with
   *  `--plugin-dir` at launch, so until one restarts the change is on disk only. */
  skillsStale: boolean;
  setSkillsStale: (stale: boolean) => void;
}

export interface NotificationsSlice {
  /** Newest first, capped. Two views: transient toasts + the notification centre. */
  notifications: AppNotification[];
  /** Ids currently showing as toasts. Dismissing a toast keeps the feed entry. */
  toastIds: string[];
  notify: (n: NotificationInput) => void;
  dismissToast: (id: string) => void;
  notificationsOpen: boolean;
  setNotificationsOpen: (v: boolean) => void;
  /** Mark ONE as seen. Merely opening the panel doesn't: the count should only
   *  drop for things actually looked at, so what's new stays identifiable. */
  markNotificationRead: (id: string) => void;
  markNotificationsRead: () => void;
  clearNotifications: () => void;
}

/** The composed store: every slice, one state. Slice creators are typed over the
 *  whole AppState (cross-slice writes go through the shared set/get). */
export type AppState = UiSlice & HomeSlice & SessionsSlice & ConfirmationsSlice &
  AgentSlice & KeybindingsSlice & ConfigSlice & NotificationsSlice & SkillsSlice;

/** Enough history to scroll back through a work session, not a log file. */

export type AppView = 'home' | 'workspace' | 'settings';
export type SidebarTab = 'files' | 'git' | 'annotations';

// ─── Notifications ────────────────────────────────────────────────────────────
// One record for everything worth telling the user about, whether it interrupts
// (a toast) or waits to be read (the notification centre). Both are views of the
// same feed, so nothing announced is ever unrecoverable — which is what the old
// single `lastError` slot got wrong: a second error erased the first.

export type NotificationKind = 'success' | 'error' | 'attention' | 'info';

/** Who produced it — drives the icon and lets the feed be scanned by subsystem. */
export type NotificationSource = 'agent' | 'mcp' | 'git' | 'mr' | 'task' | 'files' | 'app';

export interface NotificationInput {
  kind: NotificationKind;
  /** One line. The feed is scanned, not read. */
  title: string;
  /** The specifics: an error message, the tool being asked about, a file list. */
  detail?: string;
  source?: NotificationSource;
  /** Task short id this concerns — rendered as a chip, and used for grouping. */
  taskId?: string;
  /** Repo/project name, when the event belongs to one repo of a session. */
  repo?: string;
  /** Where clicking should take the user. */
  goTo?: { taskId?: string; agent?: boolean };
}

export interface AppNotification extends NotificationInput {
  id: string;
  at: number;
  read: boolean;
  /** Repeats of the same event collapse into one row with a count. */
  count: number;
  /** Shown once as a toast, then forgotten — never in the feed or the badge.
   *  Set for successes: "that worked" is an acknowledgement, not a record. */
  ephemeral?: boolean;
}
/** Sub-modes of the Source-control panel. */
export type GitSubTab = 'changes' | 'commits';
/** Diff comparison base: vs the default branch, vs this branch's remote, or uncommitted work. */
export type DiffMode = 'vs-main' | 'vs-remote' | 'working';

/** A workspace tab shows one file, viewed either as a diff or an editable buffer. */
export type TabView = 'diff' | 'edit';
export interface EditorTab {
  id: string;        // `${repoId}::${filePath}` — unique within a pane
  repoId: string;
  filePath: string;
  view: TabView;
  /** 'file' = a single file (default); 'changes' = the repo's whole "All changes"
   *  review; 'commit' = one commit's diff; 'terminal' = a shell. The Overview is
   *  a session MODE (workspaceMode), not a tab; MRs have no tab either — their
   *  links open the forge, and a review's MR overview lives in its Overview.
   *  The agent has no tab kind — it lives in the console (agent/AgentConsole). */
  kind?: 'file' | 'changes' | 'commit' | 'terminal';
  /** Commit sha for kind='commit'. */
  sha?: string;
  /** Bound PTY session for kind='terminal' (set once the session starts). */
  ptySessionId?: string;
  /** Tab-strip label for non-file kinds (short sha, "!42"/"#42"). */
  label?: string;
  /** Seed cursor line for an edit view (e.g. jumping from a grep result). */
  cursorLine?: number;
  /** Transient "preview" tab (≤ one per pane) — replaced in place by the next
   *  preview open, committed on Enter, discarded on Esc. */
  preview?: boolean;
}
/** A pane is one tab group; panes arrange in a recursive split tree (`layout`). */
export interface WorkspacePane {
  id: string;
  tabs: EditorTab[];
  activeTabId: string | null;
}

export interface PtySessionState {
  sessionId: string;
  taskId: string;
  ptyType: 'agent' | 'terminal';
  label: string;
}

// ─── Session layer ────────────────────────────────────────────────────────────
// A session is one open workspace, of one of three kinds: a real task, a scratch
// explorer, or an MR review. All per-session workspace state lives inside a
// SessionState so several can be open at once, each keeping its own tabs, diff,
// annotations, and agent terminals alive.

// The generated union — the desk is gone from the schema and the frontend.
import type { SessionKind } from '../ipc/ipc';
export type { SessionKind };

export type WorkspaceMode = 'overview' | 'code';

export interface SessionState {
  id: string;            // session id (distinct from the task short_id)
  kind: SessionKind;
  title: string;         // tab label
  /** Which surface the session shows: the Overview page (per kind: ticket /
   *  explorer / MR review) or the code panes. Opening any tab flips to code. */
  workspaceMode: WorkspaceMode;

  // ── task-kind payload (optional so future kinds can omit it) ──
  task: Task | null;
  worktrees: Worktree[];
  repos: Repo[];
  activeRepoId: string | null;
  /** The worktree git ops target. PRIMARY: `activeRepoId` is derived from it —
   *  a repo can hold several worktrees (unique key session+repo+branch). */
  activeWorktreeId: string | null;

  panes: WorkspacePane[];
  activePaneId: string;
  /** Recursive split arrangement over pane ids (leaf per pane). */
  layout: LayoutNode;
  /** When set, only this pane renders (others stay mounted, hidden). */
  maximizedPaneId: string | null;
  /** Bumped when a real (non-preview) tab is opened/committed, so the active
   *  editor grabs DOM focus. Preview opens never bump it (focus stays in the
   *  file-search input). */
  editorFocusNonce: number;
  sidebarTab: SidebarTab;
  /** The panel column is hidden. Its shortcut closes it when already focused. */
  sidebarCollapsed: boolean;
  gitSubTab: GitSubTab;

  diff: DiffResult | null;
  diffHunks: Record<string, Hunk[]>;
  diffMode: DiffMode;
  diffNonce: number;
  /** Which files are expanded in the "All changes" review, keyed `${repoId}/${path}`.
   *  Lives on the session so it survives switching tabs/panes and coming back. */
  expandedDiffFiles: Set<string>;

  /**
   * Approve this session's agent write ops without asking.
   *
   * In memory only and per session: it dies with the session and is never written
   * to the config, because "stop asking" is a decision about the next hour of work,
   * not a preference. The agent console shows a badge while it is on.
   */
  autoApprove: boolean;

  /** Show the per-line author gutter in the editor and diff views. */
  blameOn: boolean;
  /** Blame per file, keyed `${repoId}/${path}`. Cleared with the diff cache, since
   *  a commit or an external edit re-attributes lines. */
  blameByFile: Record<string, BlameLine[]>;

  worktreeStatus: Record<string, WorktreeStatus>;
  commits: CommitEntry[];
  /** How many commits the log asks for. Grows as the list is scrolled. */
  commitLimit: number;
  /** False once a fetch returns fewer commits than it asked for. */
  commitsHasMore: boolean;
  annotations: Annotation[];
  mrs: Mr[];
  mrThreadsByRepo: Record<string, MrThread[]>;
  /** Bumped to refetch MRs + their threads (after a push, an mr.* op, the sidebar refresh). */
  mrNonce: number;
  /** Active rebase-in-progress conflict for one of this session's worktrees
   *  (null when none). Set by the rebase_conflict event, cleared by rebase_done. */
  rebaseConflict: { worktreeId: string; files: string[] } | null;

  ptySessions: PtySessionState[];
  activePtySessionId: string | null;
}

/** The per-session actions a component reaches through `useSession`. */
export interface SessionActions {
  setWorkspaceMode: (m: WorkspaceMode) => void;
  setDiffMode: (m: DiffMode) => void;
  bumpDiff: () => void;
  refreshStatus: () => Promise<void>;
  /** Split the active pane (row = right, col = below); new pane takes focus. */
  splitPane: (dir: SplitDir) => void;
  /** Dock-style split: wrap the WHOLE layout so the new pane spans full
   *  height (row) / width (col). Used for the agent / terminal conventions. */
  splitRootPane: (dir: SplitDir, ratio?: number) => void;
  /** Close a pane; its tabs merge into the surviving sibling. */
  closePane: (paneId: string) => void;
  setSplitRatio: (splitId: string, ratio: number) => void;
  /** Maximize/restore the active pane (others stay mounted, hidden). */
  toggleMaximizePane: () => void;
  /** Cycle focus through panes in visual order. */
  focusNextPane: () => void;
  openTab: (input: OpenTabInput, opts?: { paneId?: string }) => void;
  /** Clear the preview flag on the pane's preview tab (Enter — keep it open). */
  commitPreview: (paneId: string) => void;
  /** Remove the pane's preview tab (Esc — cancel). */
  discardPreview: (paneId: string) => void;
  closeTab: (paneId: string, tabId: string) => void;
  setActiveTab: (paneId: string, tabId: string) => void;
  setTabView: (paneId: string, tabId: string, view: TabView) => void;
  /** Bind a terminal tab to its started PTY session. */
  setTabPty: (paneId: string, tabId: string, ptySessionId: string) => void;
  focusPane: (paneId: string) => void;
  /** Select a repo; targets that repo's first worktree (or keeps the current
   *  one when it already belongs to the repo). */
  setActiveRepoId: (id: string | null) => void;
  /** Select the exact worktree (multi-worktree repos); syncs activeRepoId. */
  setActiveWorktreeId: (id: string | null) => void;
  setSidebarTab: (t: SidebarTab) => void;
  setSidebarCollapsed: (v: boolean) => void;
  setGitSubTab: (t: GitSubTab) => void;
  setDiff: (d: DiffResult | null) => void;
  setDiffHunks: (key: string, hunks: Hunk[]) => void;
  /** Toggle a file's expanded state in the "All changes" review. */
  toggleDiffFile: (key: string) => void;
  setAutoApprove: (v: boolean) => void;
  setBlameOn: (v: boolean) => void;
  setBlame: (key: string, lines: BlameLine[]) => void;
  /** Replace the log. `hasMore` is false when git returned fewer than requested. */
  setCommits: (c: CommitEntry[], hasMore?: boolean) => void;
  /** Ask for another page of commits (the fetch effect reloads). */
  loadMoreCommits: () => void;
  setAnnotations: (a: Annotation[]) => void;
  /** Add one, ignoring a repeat id (the agent's event can echo a local insert). */
  addAnnotation: (a: Annotation) => void;
  /** Replace one annotation's body (after `update_annotation` lands). */
  updateAnnotation: (id: string, content: string) => void;
  resolveAnnotation: (id: string) => void;
  /** Drop an annotation entirely (after `delete_annotation` lands). */
  removeAnnotation: (id: string) => void;
  setMrs: (mrs: Mr[]) => void;
  upsertMr: (mr: Mr) => void;
  setMrThreadsForRepo: (repoId: string, threads: MrThread[]) => void;
  /** Refetch MRs + threads (bumps mrNonce; useWorkspaceData reloads). */
  bumpMrs: () => void;
  setWorktreeStatus: (m: Record<string, WorktreeStatus>) => void;
  setRebaseConflict: (rc: SessionState['rebaseConflict']) => void;
  removePtySession: (id: string) => void;
}

/** Convenience aliases so existing call-sites keep their `active*` field names. */
export interface SessionAliases {
  activeTask: Task | null;
  activeWorktrees: Worktree[];
  activeRepos: Repo[];
}

/** What `useSession`'s selector sees: a session merged with its bound actions. */
export type SessionView = SessionState & SessionActions & SessionAliases;
// ─── Per-session reducers (pure; operate on one SessionState) ───────────────────

export interface OpenTabInput {
  repoId: string;
  filePath: string;
  view: TabView;
  kind?: EditorTab['kind'];
  sha?: string;
  ptySessionId?: string;
  label?: string;
  cursorLine?: number;
  preview?: boolean;
}
