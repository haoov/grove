import { useEffect } from 'react';
import { useStore, sessionActions, type GitSubTab, type SidebarTab } from '../../shared/store';
import { toggleTerminal } from '../../shared/lib/panes';
import { toggleAgentsSidebar } from '../../shared/lib/agentsSidebar';
import { DEFAULT_FONT_SIZE, FONT_MIN, FONT_MAX } from '../../shared/ipc/ipc';
import { COMMANDS, type CommandId } from '../../shared/lib/keybindings';
import { chordMatches, isModifierOnly, isTypingCharacter } from '../../shared/lib/keys';

/** True when DOM focus is inside the panel column. */
function isSidebarFocused(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return !!el?.closest('.sidebar-wrapper');
}

/** True when DOM focus is inside the agent's column. */
function isAgentFocused(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return !!el?.closest('.agent-pane');
}

/** Run a global command against the current store state. Returns false when the
 *  command was a no-op in this context (so the keystroke can fall through). */
export function runCommand(id: CommandId): boolean {
  const st = useStore.getState();
  const sid = st.activeSessionId;
  const sess = sid ? st.sessions[sid] : null;
  const inWorkspace = st.view === 'workspace';

  switch (id) {
    case 'palette.commands':
      st.setCommandPaletteOpen(true);
      return true;
    case 'settings.open':
      st.openSettings();
      return true;
    case 'view.tasks':
      st.setView('home');
      return true;
    case 'agents.sidebar':
      return toggleAgentsSidebar();
    case 'view.notifications':
      // The feed is the bell's popover now: the chord simply toggles it.
      st.setNotificationsOpen(!st.notificationsOpen);
      return true;
    case 'editor.toggleVim':
      st.setVimMode(!st.vimMode);
      return true;

    case 'files.quickOpen':
      if (!sess) return false;
      st.updateSession(sess.id, () => ({ sidebarTab: 'files' }));
      st.setView('workspace');
      st.requestFileSearchFocus();
      return true;
    case 'files.search':
      if (!sess) return false;
      st.updateSession(sess.id, () => ({ sidebarTab: 'files' }));
      st.setView('workspace');
      st.requestFileSearchFocus('text');
      return true;

    case 'session.next':
    case 'session.prev': {
      const order = st.sessionOrder;
      if (!order.length) return false;
      const idx = order.indexOf(st.activeSessionId ?? '');
      let target: string;
      if (idx === -1) {
        // No active session yet — next lands on the first, prev on the last.
        target = id === 'session.next' ? order[0] : order[order.length - 1];
      } else {
        const d = id === 'session.next' ? 1 : -1;
        target = order[(idx + d + order.length) % order.length];
      }
      st.focusSession(target);
      return true;
    }

    // The session's Overview MODE — the rail's own button, on a key. Pressing it
    // while already there goes back to the code view, so the key toggles rather
    // than dead-ends (the panel shortcuts fold the same way).
    case 'panel.overview': {
      if (!sess) return false;
      const a = sessionActions(sess.id);
      a.setWorkspaceMode(sess.workspaceMode === 'overview' && inWorkspace ? 'code' : 'overview');
      st.setView('workspace');
      return true;
    }

    // 3-state, matching the terminal: closed → open+focus; open but not focused →
    // focus; focused on the same panel → close. Pressing the shortcut you are
    // already in should put the space back, not do nothing.
    case 'panel.files':
    case 'panel.git':
    case 'panel.annotations': {
      if (!sess) return false;
      const tab: SidebarTab =
        id === 'panel.files' ? 'files' : id === 'panel.git' ? 'git' : 'annotations';
      const inCode = sess.workspaceMode === 'code';
      // Fold only when already looking at this panel; from Overview the same key
      // has to bring the panels back, which is what the rail's buttons do.
      if (inCode && !sess.sidebarCollapsed && sess.sidebarTab === tab && isSidebarFocused()) {
        sessionActions(sess.id).setSidebarCollapsed(true);
        // Hand the keyboard back to the editor, or focus lands nowhere.
        st.updateSession(sess.id, (x) => ({ editorFocusNonce: x.editorFocusNonce + 1 }));
        return true;
      }
      st.updateSession(sess.id, () => ({
        sidebarTab: tab,
        sidebarCollapsed: false,
        // Overview is a MODE, not a tab: without this the sidebar state changed
        // behind the overview and the keystroke looked dead.
        workspaceMode: 'code' as const,
        ...(tab === 'git' ? { gitSubTab: 'changes' as GitSubTab } : {}),
      }));
      st.setView('workspace');
      st.requestPanelFocus();
      return true;
    }

    // 3-state like every other surface: closed → open+focus; open but elsewhere →
    // focus; open AND focused → close. Escape belongs to Claude, so closing is
    // this chord's job.
    case 'agent.console':
      if (st.consoleOpen && isAgentFocused()) {
        st.setConsoleOpen(false);
        return true;
      }
      // Only navigate when there IS a workspace to navigate to.
      if (sess) st.setView('workspace');
      st.requestConsoleFocus();
      return true;
    case 'workspace.toggleTerminal':
      // On Home the terminal is an app-level dock (there are no panes to put one
      // in), so the same chord toggles that instead of navigating away.
      if (!inWorkspace) {
        const showing = st.terminalConsoleOpen;
        st.setTerminalConsoleOpen(!showing);
        if (!showing) st.requestTerminalFocus();
        return true;
      }
      if (!sess) return false;
      toggleTerminal();
      return true;

    case 'pane.splitRight':
    case 'pane.splitDown':
      if (!sess || !inWorkspace) return false;
      sessionActions(sess.id).splitPane(id === 'pane.splitRight' ? 'row' : 'col');
      return true;
    case 'pane.close': {
      if (!sess || !inWorkspace) return false;
      sessionActions(sess.id).closePane(sess.activePaneId);
      return true;
    }
    case 'pane.next':
      if (!sess || !inWorkspace) return false;
      sessionActions(sess.id).focusNextPane();
      return true;
    case 'pane.maximize':
      // The agent is a column rather than a workspace pane, so the same shortcut
      // has to mean "maximize the thing I am in".
      // Only in a workspace: on Home there are no panes to take the room from,
      // and shrinking Home to nothing is not a maximize.
      if (isAgentFocused() && inWorkspace) {
        st.setAgentMaximized(!st.agentMaximized);
        return true;
      }
      if (!sess || !inWorkspace) return false;
      sessionActions(sess.id).toggleMaximizePane();
      return true;

    // File tabs inside the focused pane. `pane.close` is deliberately left alone —
    // it never had a default binding, so there was nothing to replace.
    case 'tab.next':
    case 'tab.prev': {
      if (!sess || !inWorkspace) return false;
      const pane = sess.panes.find((p) => p.id === sess.activePaneId) ?? sess.panes[0];
      if (!pane || pane.tabs.length < 2) return false;
      const idx = pane.tabs.findIndex((t) => t.id === pane.activeTabId);
      const d = id === 'tab.next' ? 1 : -1;
      const next = pane.tabs[(idx + d + pane.tabs.length) % pane.tabs.length];
      sessionActions(sess.id).setActiveTab(pane.id, next.id);
      return true;
    }
    case 'tab.close': {
      if (!sess || !inWorkspace) return false;
      const pane = sess.panes.find((p) => p.id === sess.activePaneId) ?? sess.panes[0];
      if (!pane?.activeTabId) return false;
      sessionActions(sess.id).closeTab(pane.id, pane.activeTabId);
      return true;
    }

    // Alt+S: first press opens the session switcher; each further press moves the
    // highlight down (wrapping). Enter commits, Esc cancels — no live switching.
    case 'session.switcher': {
      const n = st.sessionOrder.length;
      if (n === 0) return false;
      if (st.openPicker !== 'session') { st.setOpenPicker('session'); return true; }
      st.setPickerCursor((st.pickerCursor + 1) % n);
      return true;
    }

    case 'git.commitFocus':
      // requestCommitFocus opens the git panel and un-collapses it, so the box
      // exists to receive the focus.
      if (!sess) return false;
      st.setView('workspace');
      st.requestCommitFocus();
      return true;

    // Alt+R: open the header repo switcher, then move the highlight. Enter commits.
    case 'repo.switch': {
      if (!sess || sess.repos.length === 0) return false;
      st.setView('workspace');
      if (st.openPicker !== 'repo') { st.setOpenPicker('repo'); return true; }
      st.setPickerCursor((st.pickerCursor + 1) % sess.repos.length);
      return true;
    }

    // Alt+W: open the header worktree switcher, then move the highlight.
    case 'worktree.switch': {
      if (!sess) return false;
      const wts = sess.worktrees.filter((w) => w.repo_id === sess.activeRepoId);
      if (wts.length === 0) return false;
      st.setView('workspace');
      if (st.openPicker !== 'worktree') { st.setOpenPicker('worktree'); return true; }
      st.setPickerCursor((st.pickerCursor + 1) % wts.length);
      return true;
    }

    case 'repo.add':
      if (!sess) return false;
      st.setView('workspace');
      st.setAddRepoOpen(true);
      return true;

    case 'editor.toggleBlame':
      if (!sess) return false;
      st.updateSession(sess.id, (s) => ({ blameOn: !s.blameOn }));
      return true;

    case 'font.increase':
    case 'font.decrease':
    case 'font.reset': {
      const current = st.config?.ui.font_size ?? DEFAULT_FONT_SIZE;
      const next =
        id === 'font.reset' ? DEFAULT_FONT_SIZE
        : id === 'font.increase' ? current + 1
        : current - 1;
      st.setFontSize(Math.max(FONT_MIN, Math.min(FONT_MAX, next)));
      return true;
    }

    case 'editor.focus':
      if (!sess) return false;
      st.updateSession(sess.id, (s) => ({ editorFocusNonce: s.editorFocusNonce + 1 }));
      st.setView('workspace');
      return true;

    case 'git.cycleSubTab': {
      if (!sess || !inWorkspace || sess.sidebarTab !== 'git') return false;
      const tabs: GitSubTab[] = ['changes', 'commits'];
      const idx = tabs.indexOf(sess.gitSubTab);
      const next = tabs[(idx + 1) % tabs.length];
      st.updateSession(sess.id, () => ({ gitSubTab: next }));
      return true;
    }
  }
  return false;
}

/**
 * Install the single global keydown listener. Runs in the capture phase so app
 * shortcuts win over CodeMirror/xterm. All bindings carry Alt or Ctrl, so they
 * never collide with plain typing — we only bail when the chord has no modifier
 * and focus is inside a text field.
 */
export function useKeybindings() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Capture phase runs before the focused element, so a keystroke that is
      // spelling a character has to be let through here or it never arrives.
      if (isModifierOnly(e) || isTypingCharacter(e)) return;
      const st = useStore.getState();
      if (st.capturingKey) return; // Settings is rebinding — let it grab the keystroke.
      const { keymap } = st;

      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      const inField = tag === 'INPUT' || tag === 'TEXTAREA' || !!el?.isContentEditable;

      // The file-search input owns Ctrl+J/K (next/prev result). Capture-phase
      // means stopPropagation can't help it, so exempt it here explicitly.
      if (el?.dataset?.fileSearch === '1' && (e.ctrlKey || e.metaKey) && (e.key === 'j' || e.key === 'k')) return;

      // Same for the repo picker's filter, which owns Ctrl+J/K (move) and
      // Ctrl+Tab (toggle) while the add-repo wizard is up.
      if (el?.dataset?.repoPicker === '1' && (e.ctrlKey || e.metaKey)) return;

      // A terminal owns copy and paste inside itself. Ctrl+Shift+C is also the
      // default `editor.focus` chord, and capture phase would run it before
      // xterm's handler — so copying out of a terminal focused the editor instead.
      if (
        (e.ctrlKey || e.metaKey) && e.shiftKey &&
        (e.code === 'KeyC' || e.code === 'KeyV') &&
        el?.closest('.pty-pane')
      ) return;

      for (const cmd of COMMANDS) {
        for (const c of keymap[cmd.id] ?? []) {
          if (!chordMatches(e, c)) continue;
          // Don't steal un-modified keys from text fields (none today, but future-proof).
          if (inField && !c.alt && !c.ctrl) return;
          e.preventDefault();
          e.stopPropagation();
          runCommand(cmd.id);
          return;
        }
      }
    };
    // Mouse back/forward (M4/M5) cycle the focused pane. preventDefault stops the
    // webview from treating them as history navigation.
    const onMouse = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      const st = useStore.getState();
      if (st.view !== 'workspace') return;
      const sess = st.activeSessionId ? st.sessions[st.activeSessionId] : null;
      if (!sess || sess.panes.length < 2) return;
      e.preventDefault();
      const order = sess.panes.map((p) => p.id);
      const idx = order.indexOf(sess.activePaneId);
      const dir = e.button === 3 ? -1 : 1;
      const target = order[(idx + dir + order.length) % order.length];
      sessionActions(sess.id).focusPane(target);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onMouse, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onMouse, true);
    };
  }, []);
}
