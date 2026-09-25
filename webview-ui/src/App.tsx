import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

// The office new users get (the server serves the same file as the default layout).
import originalOfficeLayout from '../public/assets/default-layout-1.json';
import { agentStatus } from './agentStatus.js';
import { isInFolder } from './askAgent.js';
import { toMajorMinor } from './changelogData.js';
import { AddAgentModal } from './components/AddAgentModal.js';
import { BottomToolbar } from './components/BottomToolbar.js';
import { BuildPanel } from './components/BuildPanel.js';
import { ChangelogModal } from './components/ChangelogModal.js';
import { ChatCard } from './components/ChatCard.js';
import { ChatPeekBubbles } from './components/ChatPeekBubbles.js';
import { ConnectionIndicator } from './components/ConnectionIndicator.js';
import { DebugView } from './components/DebugView.js';
import type { ViewerFile } from './components/DocViewer.js';
import { DocViewer } from './components/DocViewer.js';
import { EditActionBar } from './components/EditActionBar.js';
import { FilesRail } from './components/FilesRail.js';
import { FocusNotices } from './components/FocusNotices.js';
import { GroupChatPanel } from './components/GroupChatPanel.js';
import { IntroBubble } from './components/IntroBubble.js';
import { LookModal } from './components/LookModal.js';
import { MessengerPanel, type MessengerStatus } from './components/MessengerPanel.js';
import { MigrationNotice } from './components/MigrationNotice.js';
import { OfficeRoster } from './components/OfficeRoster.js';
import { OpenFileDialog } from './components/OpenFileDialog.js';
import { PermissionPrompts } from './components/PermissionPrompts.js';
import { ReviewPanel } from './components/ReviewPanel.js';
import { RoomToolOverlay } from './components/RoomToolOverlay.js';
import { SettingsModal } from './components/SettingsModal.js';
import { TaskDesk } from './components/TaskDesk.js';
import { TeamsPanel } from './components/TeamsPanel.js';
import { Tooltip } from './components/Tooltip.js';
import { Button } from './components/ui/Button.js';
import { Modal } from './components/ui/Modal.js';
import { VersionIndicator } from './components/VersionIndicator.js';
import { WhiteboardRail } from './components/WhiteboardRail.js';
import { WorkflowBadges } from './components/WorkflowBadges.js';
import { WorkflowRail } from './components/WorkflowRail.js';
import { ZoomControls } from './components/ZoomControls.js';
import {
  BOARD_FILE_API,
  DOC_UPLOAD_MAX_BYTES,
  INTRO_SEEN_KEY,
  OFFICE_VIEW_KEY,
  OFFICE3D_GROW_STEP,
} from './constants.js';
import { isDocProposal, openProposalFor } from './docSuggestions.js';
import type { DocRef } from './docViewer.js';
import { fileBaseName, refText, samePath, withRefs } from './docViewer.js';
import { canSendChatFiles } from './fileUpload.js';
import { lastEditKeyFor, useDocEdits } from './hooks/useDocEdits.js';
import { useEditorActions } from './hooks/useEditorActions.js';
import { useEditorKeyboard } from './hooks/useEditorKeyboard.js';
import { useExtensionMessages } from './hooks/useExtensionMessages.js';
import { useFiles } from './hooks/useFiles.js';
import { useFocusRequests } from './hooks/useFocusRequests.js';
import { useIntroTour } from './hooks/useIntroTour.js';
import { useOfficeChat } from './hooks/useOfficeChat.js';
import { usePermissionAsks } from './hooks/usePermissionAsks.js';
import { useProposals } from './hooks/useProposals.js';
import { useTaskDesk } from './hooks/useTaskDesk.js';
import { useTeams } from './hooks/useTeams.js';
import { useWorkflows } from './hooks/useWorkflows.js';
import { getActivityText } from './office/activityText.js';
import { OfficeCanvas } from './office/components/OfficeCanvas.js';
import { ToolOverlay } from './office/components/ToolOverlay.js';
import { EditorState } from './office/editor/editorState.js';
import { EditorToolbar } from './office/editor/EditorToolbar.js';
import { OfficeState } from './office/engine/officeState.js';
import { exportLayoutToFile } from './office/layout/exportLayout.js';
import { isRotatable } from './office/layout/furnitureCatalog.js';
import { migrateLayoutColors } from './office/layout/layoutSerializer.js';
import cityOfficeLayout from './office/layout/presets/cityOffice.json';
import softOfficeLayout from './office/layout/presets/softOffice.json';
import { getPetCount } from './office/sprites/petSpriteData.js';
import { EditTool, type OfficeLayout } from './office/types.js';
import {
  buildChannels,
  burnLevelFor,
  composeMessage,
  isStoredUploadPath,
  newPinId,
  pinsForAgent,
} from './officeChat.js';
import { isBrowserRuntime, isE2E } from './runtime.js';
import { deskGates, needsYou } from './taskDesk.js';
import { installTestHooks } from './testHooks.js';
import { transport } from './transport/index.js';
import { activeRun, openGates } from './workflows.js';

// Game state lives outside React — updated imperatively by message handlers
/** 3D is the office view unless this viewer chose pixel, the browser has no
 *  WebGL, or an e2e run is driving the pixel canvas. */
function defaultIs3DView(): boolean {
  try {
    const saved = localStorage.getItem(OFFICE_VIEW_KEY);
    if (saved === '3d') return hasWebGL();
    if (saved === 'pixel') return false;
  } catch {
    /* no storage: fall through to the default */
  }
  return !isE2E && hasWebGL();
}

function hasWebGL(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') ?? c.getContext('webgl'));
  } catch {
    return false;
  }
}

// Three.js only loads for viewers who use the 3D view.
const Office3DView = lazy(() => import('./office3d/Office3DView.js'));

const officeStateRef = { current: null as OfficeState | null };
const editorState = new EditorState();

// Test-only observability hooks (message/sound logs, addAgent wrapper, selectAgent).
// Installed only under the e2e harness so they never patch prototypes or grow
// unbounded logs in a real user's session.
if (isE2E) installTestHooks(officeStateRef);

function getOfficeState(): OfficeState {
  if (!officeStateRef.current) {
    officeStateRef.current = new OfficeState();
  }
  return officeStateRef.current;
}

/** How a session is named in its chat card, the whiteboard and pin scopes. */
function agentLabel(id: number): string {
  const ch = getOfficeState().characters.get(id);
  if (ch?.displayName) return ch.displayName;
  if (ch?.agentName) return ch.agentName;
  if (ch?.folderName) return `${ch.folderName} #${id}`;
  return `Agent #${id}`;
}

/** Upload a document to the whiteboard (standalone server). Resolves with an error message or null. */
async function uploadBoardFile(file: File): Promise<string | null> {
  const result = await uploadAsPin(file);
  return 'error' in result ? result.error : null;
}

/** Store a file with the office (a copy under ~/.pixel-agents/files) in Files, without pinning it. */
async function uploadToFiles(
  file: File,
): Promise<{ fileId: string; path: string } | { error: string }> {
  if (file.size > DOC_UPLOAD_MAX_BYTES) return { error: 'File is too large (limit 25 MB).' };
  const token = new URLSearchParams(window.location.search).get('token');
  if (!token) return { error: 'Open the office from your private link to upload files.' };
  try {
    const res = await fetch(`${BOARD_FILE_API}?name=${encodeURIComponent(file.name)}&pin=0`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    const body = (await res.json().catch(() => null)) as {
      error?: string;
      fileId?: string;
      path?: string;
    } | null;
    if (res.ok && body?.fileId && body.path) return { fileId: body.fileId, path: body.path };
    return { error: body?.error ?? `Upload failed (${res.status}).` };
  } catch {
    return { error: 'Upload failed. Is the office still running?' };
  }
}

/** Store a file with the office (a copy under ~/.pixel-agents/files) as a file pin. */
async function uploadAsPin(file: File): Promise<{ pinId: string } | { error: string }> {
  if (file.size > DOC_UPLOAD_MAX_BYTES) return { error: 'File is too large (limit 25 MB).' };
  const token = new URLSearchParams(window.location.search).get('token');
  if (!token) return { error: 'Open the office from your private link to upload files.' };
  try {
    const res = await fetch(`${BOARD_FILE_API}?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    const body = (await res.json().catch(() => null)) as {
      error?: string;
      pin?: { id: string };
    } | null;
    if (res.ok && body?.pin) return { pinId: body.pin.id };
    return { error: body?.error ?? `Upload failed (${res.status}).` };
  } catch {
    return { error: 'Upload failed. Is the office still running?' };
  }
}

/** Why the office can't type into this session, or null when it can. The
 *  server decides reach (agentChatSendable); this only words the refusal. */
function chatReadOnlyReason(id: number, sendable: boolean): string | null {
  if (sendable) return null;
  const ch = getOfficeState().characters.get(id);
  if (ch?.agentName && !ch.isTeamLead) return 'Teammates take their instructions from their lead.';
  return isBrowserRuntime
    ? 'Start Claude with `pixel-office claude` instead of `claude` to chat from here.'
    : 'Start Claude with + Agent, in a VS Code terminal, or with `pixel-office claude` to chat from here.';
}

function App() {
  // Browser runtime (dev or static dist): dispatch mock messages after the
  // useExtensionMessages listener has been registered.
  useEffect(() => {
    // browserMock is for Vite dev mode only (UI prototyping without a server).
    // In standalone server mode, the server sends all state over WebSocket.
    // In VS Code mode, the extension sends all state via postMessage.
    if (isBrowserRuntime && import.meta.env.DEV) {
      void import('./browserMock.js').then(({ dispatchMockMessages }) => dispatchMockMessages());
    }
  }, []);

  const editor = useEditorActions(getOfficeState, editorState);

  const isEditDirty = useCallback(
    () => editor.isEditMode && editor.isDirty,
    [editor.isEditMode, editor.isDirty],
  );

  // Office chat + whiteboard. Registered before useExtensionMessages so its
  // listener is in place when that hook sends webviewReady.
  const [chatAgentId, setChatAgentId] = useState<number | null>(null);
  const [isBoardOpen, setIsBoardOpen] = useState(false);
  const [attachedPinIds, setAttachedPinIds] = useState<Record<number, string[]>>({});
  // Screen questions the user hid (agentId → question key). Kept here, not in the
  // card, so the agent's chat card can bring a hidden question back.
  const [hiddenQuestions, setHiddenQuestions] = useState<Record<number, string>>({});
  const hideQuestion = (agentId: number, key: string, hidden: boolean) =>
    setHiddenQuestions((prev) => {
      if (hidden) return { ...prev, [agentId]: key };
      if (!(agentId in prev)) return prev;
      const next = { ...prev };
      delete next[agentId];
      return next;
    });
  const [viewedFile, setViewedFile] = useState<ViewerFile | null>(null);
  const files = useFiles();
  const [isFilesOpen, setIsFilesOpen] = useState(false);
  const [isAddAgentOpen, setIsAddAgentOpen] = useState(false);
  const [isOpenFileOpen, setIsOpenFileOpen] = useState(false);
  const [roomNameDraft, setRoomNameDraft] = useState<string | null>(null);
  const [isGroupChatOpen, setIsGroupChatOpen] = useState(false);
  const [groupChannelId, setGroupChannelId] = useState<string | undefined>(undefined);
  const [isMessengerOpen, setIsMessengerOpen] = useState(false);
  const [messengerDocked, setMessengerDocked] = useState(false);
  const [messengerAgentId, setMessengerAgentId] = useState<number | null>(null);
  const chat = useOfficeChat(chatAgentId);
  const desk = useTaskDesk();
  const [isDeskOpen, setIsDeskOpen] = useState(false);
  const workflows = useWorkflows();
  const [isWorkflowsOpen, setIsWorkflowsOpen] = useState(false);
  const teams = useTeams();
  const [isTeamsOpen, setIsTeamsOpen] = useState(false);
  const permissionAsks = usePermissionAsks();
  const focus = useFocusRequests();
  const proposals = useProposals();
  const docEdits = useDocEdits();
  const [docEditsSeen, setDocEditsSeen] = useState<ReadonlySet<string>>(() => new Set());
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [proposalsLater, setProposalsLater] = useState<ReadonlySet<string>>(() => new Set());
  const [viewedFocusId, setViewedFocusId] = useState<string | null>(null);
  // Any file opens in the viewer through Files (never by pinning it: the
  // whiteboard is what agents see). A pin opens the same way, by its path.
  const [fileOpenError, setFileOpenError] = useState<string | null>(null);
  const openFileInViewer = useCallback(
    (path: string, focusId: string | null = null) => {
      setFileOpenError(null);
      void files.open(path).then((result) => {
        if ('error' in result) {
          setFileOpenError(result.error);
          return;
        }
        setViewedFocusId(focusId);
        setViewedFile({
          id: result.fileId,
          path: result.path,
          title: fileBaseName(result.path).replace(/^pin_[A-Za-z0-9]+-/, ''),
        });
      });
    },
    [files],
  );
  const { pins: boardPins } = chat;
  const openPinInViewer = useCallback(
    (pinId: string, focusId: string | null = null) => {
      const pin = boardPins.find((p) => p.id === pinId && p.kind === 'file');
      if (pin) openFileInViewer(pin.value, focusId);
    },
    [boardPins, openFileInViewer],
  );
  /** Places picked in the viewer, waiting to be sent (the tray), and those attached per agent. */
  const [docTray, setDocTray] = useState<DocRef[]>([]);
  const [docRefsFor, setDocRefsFor] = useState<Record<number, DocRef[]>>({});
  const [focusLater, setFocusLater] = useState<ReadonlySet<string>>(() => new Set());

  const {
    agents,
    selectedAgent,
    agentTools,
    agentStatuses,
    subagentTools,
    subagentCharacters,
    layoutReady,
    layoutWasReset,
    loadedAssets,
    workspaceFolders,
    agentFolderNames,
    externalAssetDirectories,
    lastSeenVersion,
    extensionVersion,
    watchAllSessions,
    setWatchAllSessions,
    alwaysShowLabels,
    ghostHeadlessAgents,
    setGhostHeadlessAgents,
    hooksEnabled,
    hooksInstalled,
    hooksStatusSeq,
    hooksInfoShown,
    consentRequest,
    dismissConsentRequest,
    areaMappings,
    setAreaMappings,
    showAreas,
    setShowAreas,
  } = useExtensionMessages(getOfficeState, editor.setLastSavedLayout, isEditDirty);

  // Show migration notice once layout reset is detected
  const [migrationNoticeDismissed, setMigrationNoticeDismissed] = useState(false);
  const showMigrationNotice = layoutWasReset && !migrationNoticeDismissed;

  const [isChangelogOpen, setIsChangelogOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isHooksInfoOpen, setIsHooksInfoOpen] = useState(false);
  const [hooksTooltipDismissed, setHooksTooltipDismissed] = useState(false);
  const [isDebugMode, setIsDebugMode] = useState(false);
  /** The agent whose look the character studio is changing. */
  const [lookAgentId, setLookAgentId] = useState<number | null>(null);
  const [is3DView, setIs3DView] = useState(defaultIs3DView);
  const [alwaysShowOverlay, setAlwaysShowOverlay] = useState(false);

  const currentMajorMinor = toMajorMinor(extensionVersion);

  const handleWhatsNewDismiss = useCallback(() => {
    transport.send({ type: 'setLastSeenVersion', version: currentMajorMinor });
  }, [currentMajorMinor]);

  const handleOpenChangelog = useCallback(() => {
    setIsChangelogOpen(true);
    transport.send({ type: 'setLastSeenVersion', version: currentMajorMinor });
  }, [currentMajorMinor]);

  // Sync alwaysShowOverlay from persisted settings
  useEffect(() => {
    setAlwaysShowOverlay(alwaysShowLabels);
  }, [alwaysShowLabels]);

  const handleToggleDebugMode = useCallback(() => setIsDebugMode((prev) => !prev), []);
  const handleToggle3DView = useCallback(() => {
    setIs3DView((prev) => {
      try {
        localStorage.setItem(OFFICE_VIEW_KEY, prev ? 'pixel' : '3d');
      } catch {
        /* the choice just won't be remembered */
      }
      return !prev;
    });
  }, []);
  const handleToggleAlwaysShowOverlay = useCallback(() => {
    setAlwaysShowOverlay((prev) => {
      const newVal = !prev;
      transport.send({ type: 'setAlwaysShowLabels', enabled: newVal });
      return newVal;
    });
  }, []);

  // Toggle "Display headless as ghosts". setGhostHeadlessAgents also updates the
  // renderer's module copy, so the office redraws on the next frame.
  const handleToggleGhostHeadlessAgents = useCallback(() => {
    const next = !ghostHeadlessAgents;
    setGhostHeadlessAgents(next);
    transport.send({ type: 'setGhostHeadlessAgents', enabled: next });
  }, [ghostHeadlessAgents, setGhostHeadlessAgents]);

  const handleSelectAgent = useCallback((id: number) => {
    transport.send({ type: 'focusAgent', id });
  }, []);

  // The Intro's wire-facing state machine — which asks survive being mooted,
  // when a hooksStatus is this tour's install verdict — lives in useIntroTour
  // (pure reducer in introTourState.ts); the App only wires it to the bubble.
  const {
    intro,
    installFailed,
    installPending,
    onChoice: handleConsentChoice,
    onClose: handleIntroClose,
  } = useIntroTour({ consentRequest, hooksInstalled, hooksStatusSeq, dismissConsentRequest });

  // The tour shows by itself once per browser; after that only Settings →
  // Show Welcome Tour opens it. The consent ask stays answerable from the
  // Settings hooks checkbox, so an unanswered ask no longer reopens the tour.
  const [introSeenBefore] = useState(readIntroSeen);
  const [introReplay, setIntroReplay] = useState(false);
  const showIntro = introReplay || (intro !== null && !introSeenBefore);
  useEffect(() => {
    if (showIntro) markIntroSeen();
  }, [showIntro]);
  const closeIntro = useCallback(() => {
    setIntroReplay(false);
    if (intro) handleIntroClose();
  }, [intro, handleIntroClose]);

  // The Settings surface renders one provider today; its checkbox binds to
  // the Claude row of the per-provider install-state map.
  const claudeHooksInstalled = hooksInstalled['claude'] === true;

  // Mutate folder→Area mappings locally + send to server. Updates OfficeState in
  // the same tick so a follow-up agentCreated picks up the new mapping.
  const handleAreaMappingChange = useCallback(
    (folderName: string, areaLabel: string, action: 'add' | 'remove') => {
      const current = areaMappings[folderName] ?? [];
      let nextLabels: string[];
      if (action === 'add') {
        if (current.includes(areaLabel)) return;
        nextLabels = [...current, areaLabel];
      } else {
        nextLabels = current.filter((l) => l !== areaLabel);
      }
      const next = { ...areaMappings };
      if (nextLabels.length === 0) {
        delete next[folderName];
      } else {
        next[folderName] = nextLabels;
      }
      setAreaMappings(next);
      getOfficeState().setAreaMappings(next);
      transport.send({ type: 'saveAreaMappings', mappings: next });
    },
    [areaMappings, setAreaMappings],
  );

  // Toggle global Show Areas — persisted via setShowAreas message; runs server-
  // side through configPersistence.
  const onToggleShowAreas = useCallback(() => {
    const next = !showAreas;
    setShowAreas(next);
    transport.send({ type: 'setShowAreas', enabled: next });
  }, [showAreas, setShowAreas]);

  // When AREA_PAINT is active in the editor, force the overlay on even if the
  // user has toggled Show Areas off globally — they need to see what they're
  // editing. The selected area's overlay is alpha-bumped via activeAreaLabel.
  const isEditingAreas = editor.isEditMode && editorState.activeTool === EditTool.AREA_PAINT;
  const effectiveShowAreas = isEditingAreas || showAreas;
  const activeAreaLabel = isEditingAreas ? editor.selectedAreaLabel : null;

  // e2e: register the component-scoped editor-action drivers + the effective
  // show-areas gate on the test-hooks namespace (module-load installTestHooks
  // can't reach these React callbacks). Bypasses only canvas pixel→tile
  // geometry — the handlers still own undo/dirty/rebuild. Guarded on isE2E.
  const { handleEditorTileAction, handleEditorEraseAction } = editor;
  useEffect(() => {
    if (!isE2E || typeof window === 'undefined') return;
    const hooks = (window.__pixelAgentsTestHooks ??= {});
    hooks.editorTileAction = (col, row) => handleEditorTileAction(col, row);
    hooks.editorEraseAction = (col, row) => handleEditorEraseAction(col, row);
    hooks.getShowAreas = () => effectiveShowAreas;
  }, [handleEditorTileAction, handleEditorEraseAction, effectiveShowAreas]);

  const containerRef = useRef<HTMLDivElement>(null);

  const [editorTickForKeyboard, setEditorTickForKeyboard] = useState(0);
  useEditorKeyboard(
    editor.isEditMode,
    editorState,
    editor.handleDeleteSelected,
    editor.handleRotateSelected,
    editor.handleToggleState,
    editor.handleUndo,
    editor.handleRedo,
    useCallback(() => setEditorTickForKeyboard((n) => n + 1), []),
    editor.handleToggleEditMode,
  );

  const handleCloseAgent = useCallback((id: number) => {
    // Closed from the office: in 3D the character walks out the front door.
    getOfficeState().markLeaving(id);
    transport.send({ type: 'closeAgent', id });
  }, []);

  // Clicking a character opens its session's chat (a sub-agent's is its
  // parent's); clicking it again, which deselects it, closes the chat.
  const handleClick = useCallback((agentId: number) => {
    const os = getOfficeState();
    const meta = os.subagentMeta.get(agentId);
    const chatId = meta ? meta.parentAgentId : agentId;
    setChatAgentId(os.selectedAgentId === agentId ? chatId : null);
  }, []);

  const openChat = useCallback((agentId: number) => {
    const os = getOfficeState();
    os.selectedAgentId = agentId;
    os.cameraFollowId = agentId;
    setChatAgentId(agentId);
  }, []);

  const openMessenger = useCallback((agentId: number | null) => {
    if (agentId !== null) setMessengerAgentId(agentId);
    setIsMessengerOpen(true);
    setIsGroupChatOpen(false);
  }, []);

  // M opens Messages from anywhere in the office (not while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'm' && e.key !== 'M') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      setIsMessengerOpen((open) => {
        if (!open) setIsGroupChatOpen(false);
        return !open;
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const closeChat = useCallback(() => {
    const os = getOfficeState();
    os.selectedAgentId = null;
    os.cameraFollowId = null;
    setChatAgentId(null);
  }, []);

  // Names and burn levels live on the characters (label, flames, typing speed).
  // Re-applied when agents appear, since a message can land before its character.
  useEffect(() => {
    const os = getOfficeState();
    for (const id of agents) {
      os.setDisplayName(id, chat.names[id] ?? '');
      os.setBurnLevel(id, burnLevelFor(chat.usage[id]?.burnPerMinute ?? 0));
    }
  }, [agents, chat.names, chat.usage]);

  // An agent's open "show me" request puts a file bubble over its head.
  useEffect(() => {
    const os = getOfficeState();
    const asking = new Set([
      ...focus.requests.filter((r) => r.state === 'waiting').map((r) => r.agentId),
      ...proposals.proposals.filter((p) => p.state === 'open').map((p) => p.agentId),
    ]);
    for (const id of agents) os.setDocBubble(id, asking.has(id));
  }, [agents, focus.requests, proposals.proposals]);

  // Teams started from presets: members are linked to their lead (team room,
  // group-chat channel), named, and given the look the preset chose.
  useEffect(() => {
    const os = getOfficeState();
    for (const crew of teams.crews) {
      if (crew.state !== 'running') continue;
      const leadId = crew.members.find((m) => m.lead)?.agentId;
      for (const member of crew.members) {
        const id = member.agentId;
        if (id === undefined || !os.characters.has(id)) continue;
        const ch = os.characters.get(id);
        if (member.palette !== undefined) os.setLook(id, member.palette);
        const wantLead = member.lead === true;
        const wantLeadId = wantLead ? undefined : leadId;
        if (
          ch?.isTeamLead !== wantLead ||
          ch?.leadAgentId !== wantLeadId ||
          ch?.agentName !== member.name
        ) {
          os.setTeamInfo(id, ch?.teamName, member.name, wantLead || undefined, wantLeadId);
        }
      }
    }
  }, [agents, teams.crews]);

  // A closed agent takes its chat card with it.
  useEffect(() => {
    if (chatAgentId !== null && !agents.includes(chatAgentId)) setChatAgentId(null);
  }, [agents, chatAgentId]);

  const attachPin = useCallback((agentId: number, pinId: string) => {
    setAttachedPinIds((prev) => {
      const current = prev[agentId] ?? [];
      return current.includes(pinId) ? prev : { ...prev, [agentId]: [...current, pinId] };
    });
  }, []);

  const detachPin = useCallback((agentId: number, pinId: string) => {
    setAttachedPinIds((prev) => ({
      ...prev,
      [agentId]: (prev[agentId] ?? []).filter((id) => id !== pinId),
    }));
  }, []);

  // A pin dropped on a character opens its chat with the pin attached.
  const handlePinDrop = useCallback(
    (agentId: number, pinId: string) => {
      attachPin(agentId, pinId);
      openChat(agentId);
    },
    [attachPin, openChat],
  );

  const officeState = getOfficeState();

  // Merged set of folders the Areas dropdown can map: real workspace folders plus
  // every distinct folder an agent has run in this session (deduped by name; name
  // is the areaMappings key / seat-bias identity, path is only the React list key).
  const areaFolders = useMemo(() => {
    const byName = new Map<string, { name: string; path: string }>();
    for (const f of workspaceFolders) byName.set(f.name, f);
    for (const name of agentFolderNames) {
      if (!byName.has(name)) byName.set(name, { name, path: name });
    }
    return [...byName.values()];
  }, [workspaceFolders, agentFolderNames]);

  // Areas authoring is available when the layout already defines areas, or when
  // there is at least one mappable folder. Decouples the Areas UI from VS Code
  // multi-root workspaces (fixes single-root VS Code AND standalone, where
  // workspaceFolders is always empty).
  const areasAvailable = (officeState.getLayout().areas?.length ?? 0) > 0 || areaFolders.length > 0;

  const handleExportLayout = useCallback(() => {
    exportLayoutToFile(getOfficeState().getLayout());
  }, []);

  const handleImportLayout = useCallback(
    (file: File) => {
      // Browser-native import (standalone): read + validate + apply directly,
      // bypassing the layoutLoaded message whose dirty guard would skip it.
      if (
        isEditDirty() &&
        !window.confirm('Replace the current layout? Unsaved edits will be lost.')
      ) {
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const imported = JSON.parse(String(reader.result)) as Record<string, unknown>;
          // Match the VS Code guard, plus the furniture-array check VS Code omits
          // (migrate + rebuild iterate furniture and would throw on a non-array).
          if (
            imported.version !== 1 ||
            !Array.isArray(imported.tiles) ||
            !Array.isArray(imported.furniture)
          ) {
            window.alert('Invalid layout file.');
            return;
          }
          const migrated = migrateLayoutColors(imported as unknown as OfficeLayout);
          getOfficeState().rebuildFromLayout(migrated);
          editor.setLastSavedLayout(migrated);
          transport.send({
            type: 'saveLayout',
            layout: migrated as unknown as Record<string, unknown>,
          });
          editor.markClean();
        } catch {
          window.alert('Failed to read or parse layout file.');
        }
      };
      reader.readAsText(file);
    },
    [isEditDirty, editor],
  );

  // Force dependency on editorTickForKeyboard to propagate keyboard-triggered re-renders
  void editorTickForKeyboard;

  // Show "Press R to rotate" hint when a rotatable item is selected or being placed
  const showRotateHint =
    editor.isEditMode &&
    (() => {
      if (editorState.selectedFurnitureUid) {
        const item = officeState
          .getLayout()
          .furniture.find((f) => f.uid === editorState.selectedFurnitureUid);
        if (item && isRotatable(item.type)) return true;
      }
      if (
        editorState.activeTool === EditTool.FURNITURE_PLACE &&
        isRotatable(editorState.selectedFurnitureType)
      ) {
        return true;
      }
      return false;
    })();

  const handleWorkflowDrop =
    chat.privileged || !isBrowserRuntime
      ? (agentId: number, workflowId: string) => workflows.attach(agentId, workflowId)
      : undefined;
  const handleCardDrop =
    chat.privileged || !isBrowserRuntime
      ? (agentId: number, taskId: string) => {
          // Only this agent may take the card; a draft goes onto the desk with it.
          desk.setAllow(taskId, [agentId]);
          if (desk.tasks.find((t) => t.id === taskId)?.state === 'draft') {
            desk.call(taskId, 'publish');
          }
        }
      : undefined;
  const show3D = is3DView;

  if (!layoutReady) {
    return <div className="w-full h-full flex items-center justify-center ">Loading...</div>;
  }

  return (
    <div ref={containerRef} className="w-full h-full relative overflow-hidden">
      {show3D ? (
        <Suspense fallback={null}>
          <Office3DView
            officeState={officeState}
            onClick={handleClick}
            onPinDrop={handlePinDrop}
            onWorkflowDrop={handleWorkflowDrop}
            onCardDrop={handleCardDrop}
            tagOf={(id) => {
              const ch = officeState.characters.get(id);
              if (!ch || ch.isSubagent) return null;
              return {
                name: agentLabel(id),
                activity: getActivityText(
                  id,
                  agentTools,
                  ch.isActive,
                  ch.bubbleType,
                  !!ch.waitingAwaitingInput,
                ),
                status: agentStatus(officeState, id, agentTools).cls,
              };
            }}
            edit={{
              isEditMode: editor.isEditMode,
              editorState,
              onEditorTileAction: editor.handleEditorTileAction,
              onEditorEraseAction: editor.handleEditorEraseAction,
              onEditorSelectionChange: editor.handleEditorSelectionChange,
              onDragMove: editor.handleDragMove,
              onApplyLayout: editor.applyEdit,
              onRotateSelected: editor.handleRotateSelected,
              onDeleteSelected: editor.handleDeleteSelected,
              onGrow: (dir) => {
                if (!editor.handleGrowLayout(dir, OFFICE3D_GROW_STEP)) {
                  console.warn('[Webview] The map is as big as it gets on that side.');
                }
              },
            }}
          />
        </Suspense>
      ) : (
        <OfficeCanvas
          officeState={officeState}
          onClick={handleClick}
          isEditMode={editor.isEditMode}
          editorState={editorState}
          onEditorTileAction={editor.handleEditorTileAction}
          onEditorEraseAction={editor.handleEditorEraseAction}
          onEditorSelectionChange={editor.handleEditorSelectionChange}
          onDeleteSelected={editor.handleDeleteSelected}
          onRotateSelected={editor.handleRotateSelected}
          onDragMove={editor.handleDragMove}
          editorTick={editor.editorTick}
          zoom={editor.zoom}
          onZoomChange={editor.handleZoomChange}
          panRef={editor.panRef}
          showAreas={effectiveShowAreas}
          activeAreaLabel={activeAreaLabel}
          onPinDrop={handlePinDrop}
          onWorkflowDrop={handleWorkflowDrop}
          onCardDrop={handleCardDrop}
        />
      )}

      {!isDebugMode ? (
        <>
          {!show3D && <ZoomControls zoom={editor.zoom} onZoomChange={editor.handleZoomChange} />}

          {/* Vignette overlay */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{ background: 'var(--vignette)' }}
          />

          {editor.isEditMode && editor.isDirty && (
            <EditActionBar editor={editor} editorState={editorState} />
          )}

          {showRotateHint && (
            <div
              className="absolute left-1/2 -translate-x-1/2 z-11 bg-accent-bright text-white text-sm py-3 px-8 rounded-ui border border-accent shadow-pixel pointer-events-none whitespace-nowrap"
              style={{ top: editor.isDirty ? 64 : 8 }}
            >
              Rotate (R)
            </div>
          )}

          {show3D && editor.isEditMode && (
            <BuildPanel
              officeState={officeState}
              editorState={editorState}
              editor={editor}
              onDone={editor.handleToggleEditMode}
              areaFolders={areaFolders}
              areaMappings={areaMappings}
              onAreaMappingChange={handleAreaMappingChange}
              presets={[
                {
                  id: 'soft',
                  name: 'Soft Dollhouse office',
                  hint: 'Kitchen, two desk pods, a glass team room, a lounge.',
                  layout: () => migrateLayoutColors(softOfficeLayout as unknown as OfficeLayout),
                },
                {
                  id: 'city',
                  name: 'City office',
                  hint: 'A main floor and two team rooms.',
                  layout: () => migrateLayoutColors(cityOfficeLayout as unknown as OfficeLayout),
                },
                {
                  id: 'original',
                  name: 'Original office',
                  hint: 'The first Pixel Agents office.',
                  layout: () =>
                    migrateLayoutColors(originalOfficeLayout as unknown as OfficeLayout),
                },
              ]}
            />
          )}

          {!show3D && editor.isEditMode && editorState.activeTool === EditTool.ROOM && (
            <RoomToolOverlay
              officeState={officeState}
              containerRef={containerRef}
              zoom={editor.zoom}
              panRef={editor.panRef}
              applyEdit={editor.applyEdit}
              renameRoom={editor.handleRenameArea}
              removeRoom={editor.handleRemoveArea}
              onPaintCustom={() => setRoomNameDraft('')}
            />
          )}

          {editor.isEditMode &&
            // In 3D the Build panel has every tool; the classic panel is the pixel view's.
            !show3D &&
            (() => {
              const selUid = editorState.selectedFurnitureUid;
              const selColor = selUid
                ? (officeState.getLayout().furniture.find((f) => f.uid === selUid)?.color ?? null)
                : null;
              return (
                <EditorToolbar
                  activeTool={editorState.activeTool}
                  selectedTileType={editorState.selectedTileType}
                  selectedFurnitureType={editorState.selectedFurnitureType}
                  selectedFurnitureUid={selUid}
                  selectedFurnitureColor={selColor}
                  floorColor={editorState.floorColor}
                  wallColor={editorState.wallColor}
                  selectedWallSet={editorState.selectedWallSet}
                  onToolChange={editor.handleToolChange}
                  onTileTypeChange={editor.handleTileTypeChange}
                  onFloorColorChange={editor.handleFloorColorChange}
                  onWallColorChange={editor.handleWallColorChange}
                  onWallSetChange={editor.handleWallSetChange}
                  onSelectedFurnitureColorChange={editor.handleSelectedFurnitureColorChange}
                  pickedFurnitureColor={editorState.pickedFurnitureColor}
                  onPickedFurnitureColorChange={editor.handlePickedFurnitureColorChange}
                  onFurnitureTypeChange={editor.handleFurnitureTypeChange}
                  loadedAssets={loadedAssets}
                  activePetTypes={officeState.getActivePetTypes()}
                  petCount={getPetCount()}
                  onPetToggle={editor.handlePetToggle}
                  carpetVariant={editor.carpetVariant}
                  carpetColor={editor.carpetColor}
                  carpetAccentColor={editor.carpetAccentColor}
                  onCarpetVariantChange={editor.handleCarpetVariantChange}
                  onCarpetColorChange={editor.handleCarpetColorChange}
                  onCarpetAccentColorChange={editor.handleCarpetAccentColorChange}
                  areas={officeState.getLayout().areas ?? []}
                  selectedAreaLabel={editor.selectedAreaLabel}
                  workspaceFolders={areaFolders}
                  areasAvailable={areasAvailable}
                  areaMappings={areaMappings}
                  onSelectArea={editor.handleSelectArea}
                  onAddArea={editor.handleAddArea}
                  onRemoveArea={editor.handleRemoveArea}
                  onRenameArea={editor.handleRenameArea}
                  onAreaColorChange={editor.handleAreaColorChange}
                  onAreaMappingChange={handleAreaMappingChange}
                />
              );
            })()}

          {show3D && !editor.isEditMode && (
            <OfficeRoster
              officeState={officeState}
              agents={agents}
              agentTools={agentTools}
              subagentCharacters={subagentCharacters}
              labelOf={agentLabel}
              onOpen={openChat}
            />
          )}
          <ToolOverlay
            officeState={officeState}
            agents={agents}
            agentTools={agentTools}
            subagentTools={subagentTools}
            subagentCharacters={subagentCharacters}
            containerRef={containerRef}
            zoom={editor.zoom}
            panRef={editor.panRef}
            onCloseAgent={handleCloseAgent}
            alwaysShowOverlay={alwaysShowOverlay}
          />

          {!editor.isEditMode && (
            <ChatPeekBubbles
              officeState={officeState}
              agents={agents}
              chats={chat.chats}
              unread={chat.unread}
              openAgentId={chatAgentId}
              containerRef={containerRef}
              zoom={editor.zoom}
              panRef={editor.panRef}
              onOpen={openChat}
            />
          )}

          {!editor.isEditMode && (
            <WorkflowBadges
              officeState={officeState}
              agents={agents}
              runs={workflows.runs}
              containerRef={containerRef}
              zoom={editor.zoom}
              panRef={editor.panRef}
            />
          )}

          {chatAgentId !== null &&
            !editor.isEditMode &&
            (() => {
              const id = chatAgentId;
              const attached = (attachedPinIds[id] ?? [])
                .map((pinId) => chat.pins.find((p) => p.id === pinId))
                .filter((p) => p !== undefined);
              const needsApproval =
                chat.asking[id] === true ||
                (agentTools[id]?.some((t) => t.permissionWait && !t.done) ?? false) ||
                officeState.characters.get(id)?.bubbleType === 'permission';
              return (
                <ChatCard
                  key={id}
                  agentId={id}
                  title={agentLabel(id)}
                  officeState={officeState}
                  containerRef={containerRef}
                  zoom={editor.zoom}
                  panRef={editor.panRef}
                  entries={chat.chats[id] ?? []}
                  queue={chat.queues[id]}
                  readOnlyReason={chatReadOnlyReason(id, chat.sendable[id] === true)}
                  needsApproval={needsApproval}
                  attachedPins={attached}
                  onAttachPin={(pinId) => attachPin(id, pinId)}
                  onDetachPin={(pinId) => detachPin(id, pinId)}
                  onSend={(text) => {
                    const message = withRefs(composeMessage(text, attached), docRefsFor[id] ?? []);
                    if (!message) return;
                    chat.sendMessage(id, message);
                    setAttachedPinIds((prev) => ({ ...prev, [id]: [] }));
                    setDocRefsFor((prev) => ({ ...prev, [id]: [] }));
                  }}
                  docRefs={docRefsFor[id] ?? []}
                  onRemoveDocRef={(i) =>
                    setDocRefsFor((prev) => ({
                      ...prev,
                      [id]: (prev[id] ?? []).filter((_, j) => j !== i),
                    }))
                  }
                  onCancel={(queueId) => chat.cancelMessage(id, queueId)}
                  usage={chat.usage[id]}
                  customName={chat.names[id] ?? ''}
                  onRename={(name) => chat.renameAgent(id, name)}
                  onEditLook={is3DView ? () => setLookAgentId(id) : undefined}
                  screen={chat.screens[id]}
                  onKeys={(keys) => chat.sendKeys(id, keys)}
                  onStop={() => chat.interruptAgent(id)}
                  onClearContext={
                    (chat.privileged || !isBrowserRuntime) && chat.sendable[id] === true
                      ? (mode) => chat.clearAgent(id, mode)
                      : undefined
                  }
                  clearPolicy={chat.prefs[id]?.clearPolicy}
                  onSetClearPolicy={
                    chat.privileged || !isBrowserRuntime
                      ? (clearPolicy) => chat.setAgentPrefs(id, { clearPolicy })
                      : undefined
                  }
                  clearRequest={chat.clearRequests.find((r) => r.agentId === id)}
                  question={chat.questions[id]}
                  onShowQuestion={
                    chat.privileged && chat.questions[id]
                      ? () => hideQuestion(id, chat.questions[id].key, false)
                      : undefined
                  }
                  slashCommands={chat.slashCommands[id]}
                  onLoadSlashCommands={
                    chat.privileged && chat.sendable[id] === true
                      ? () => chat.loadSlashCommands(id)
                      : undefined
                  }
                  models={chat.models[id]}
                  onLoadModels={
                    chat.privileged && chat.screens[id] ? () => chat.loadModels(id) : undefined
                  }
                  onSetModel={
                    chat.privileged && chat.screens[id]
                      ? (label) => chat.setModel(id, label)
                      : undefined
                  }
                  docEditMode={chat.prefs[id]?.docEditMode}
                  docEditDefault={docEdits.defaultMode}
                  onSetDocEditMode={
                    chat.privileged || !isBrowserRuntime
                      ? (docEditMode) => chat.setAgentPrefs(id, { docEditMode })
                      : undefined
                  }
                  onAnswerClear={
                    chat.privileged || !isBrowserRuntime
                      ? (allow) => chat.answerClearRequest(id, allow)
                      : undefined
                  }
                  onRemove={() => {
                    handleCloseAgent(id);
                    closeChat();
                  }}
                  onClose={closeChat}
                  onOpenTerminal={
                    isBrowserRuntime ? undefined : () => transport.send({ type: 'focusAgent', id })
                  }
                  onExpand={() => {
                    openMessenger(id);
                    closeChat();
                  }}
                  workflows={
                    (chat.privileged || !isBrowserRuntime) && chat.sendable[id] === true
                      ? workflows.workflows.map((w) => ({
                          id: w.id,
                          title: w.title,
                          steps: w.steps.length,
                        }))
                      : undefined
                  }
                  onAttachWorkflow={(workflowId) => workflows.attach(id, workflowId)}
                  run={activeRun(workflows.runs, id)}
                  onStopRun={
                    chat.privileged || !isBrowserRuntime
                      ? () => {
                          const run = activeRun(workflows.runs, id);
                          if (run) workflows.stopRun(run.runId);
                        }
                      : undefined
                  }
                />
              );
            })()}

          {!editor.isEditMode && (
            <FocusNotices
              requests={focus.requests.filter(
                (r) => r.state === 'waiting' && !focusLater.has(r.requestId),
              )}
              labelOf={agentLabel}
              onOpen={isBrowserRuntime ? (r) => openPinInViewer(r.pinId, r.requestId) : undefined}
              onLater={(r) => setFocusLater((prev) => new Set(prev).add(r.requestId))}
              suggestions={proposals.proposals.filter(
                (p) => p.state === 'open' && !proposalsLater.has(p.proposalId),
              )}
              onReview={(p) =>
                // Office documents are reviewed in the document itself; text files keep the diff panel.
                isDocProposal(p) && isBrowserRuntime
                  ? openFileInViewer(p.path)
                  : setReviewingId(p.proposalId)
              }
              docEdits={docEdits.edits.filter(
                (e) => e.agentId !== undefined && !e.undone && !docEditsSeen.has(e.editId),
              )}
              onUndoDocEdit={
                chat.privileged || !isBrowserRuntime ? (e) => docEdits.undo(e.editId) : undefined
              }
              onDismissDocEdit={(e) => setDocEditsSeen((prev) => new Set(prev).add(e.editId))}
              onLaterSuggestion={(p) =>
                setProposalsLater((prev) => new Set(prev).add(p.proposalId))
              }
            />
          )}

          {!editor.isEditMode && (
            <PermissionPrompts
              asks={permissionAsks.asks}
              labelOf={agentLabel}
              onAnswer={permissionAsks.answer}
              onOpenAgent={openChat}
              questions={Object.entries(chat.questions).map(([id, question]) => ({
                agentId: Number(id),
                question,
              }))}
              gates={openGates(workflows.runs)}
              onAnswerGate={chat.privileged || !isBrowserRuntime ? workflows.answerGate : undefined}
              deskGates={deskGates(desk.tasks)}
              onAnswerDeskGate={chat.privileged || !isBrowserRuntime ? desk.answerGate : undefined}
              clearRequests={chat.clearRequests}
              onAnswerClear={
                chat.privileged || !isBrowserRuntime ? chat.answerClearRequest : undefined
              }
              hiddenQuestions={hiddenQuestions}
              onHideQuestion={hideQuestion}
              onChooseQuestion={
                chat.privileged
                  ? (agentId, key, option, followUp) => {
                      chat.answerQuestion(agentId, key, option);
                      // Typed once the question is gone: the queue holds during it.
                      if (followUp) chat.sendMessage(agentId, followUp);
                    }
                  : undefined
              }
            />
          )}

          {isMessengerOpen && !editor.isEditMode && (
            <MessengerPanel
              agents={agents
                .filter((id) => !officeState.characters.get(id)?.isSubagent)
                .map((id) => ({
                  id,
                  label: agentLabel(id),
                  status: (chat.asking[id]
                    ? 'asking'
                    : agentStatuses[id] === 'waiting'
                      ? 'idle'
                      : 'working') as MessengerStatus,
                }))}
              rooms={buildChannels(
                agents
                  .filter((id) => !officeState.characters.get(id)?.isSubagent)
                  .map((id) => {
                    const ch = officeState.characters.get(id);
                    return {
                      id,
                      label: agentLabel(id),
                      leadId: ch?.isTeamLead ? id : ch?.leadAgentId,
                      room: officeState.getTeamRoom(id),
                    };
                  }),
              ).map((c) => ({ id: c.id, name: c.name, members: c.members }))}
              selectedId={messengerAgentId}
              onSelect={(id) => {
                setMessengerAgentId(id);
                chat.markRead(id);
              }}
              chats={chat.chats}
              unread={chat.unread}
              queues={chat.queues}
              usage={chat.usage}
              contextOf={(id) => {
                const ch = officeState.characters.get(id);
                return ch && ch.maxContextTokens > 0 && ch.contextTokens > 0
                  ? { tokens: ch.contextTokens, max: ch.maxContextTokens }
                  : null;
              }}
              readOnlyReason={(id) => chatReadOnlyReason(id, chat.sendable[id] === true)}
              onSend={(id, text) => {
                const attached = (attachedPinIds[id] ?? [])
                  .map((pinId) => chat.pins.find((p) => p.id === pinId))
                  .filter((p): p is NonNullable<typeof p> => p !== undefined);
                const message = withRefs(composeMessage(text, attached), docRefsFor[id] ?? []);
                if (!message) return;
                chat.sendMessage(id, message);
                setAttachedPinIds((prev) => ({ ...prev, [id]: [] }));
                setDocRefsFor((prev) => ({ ...prev, [id]: [] }));
              }}
              onCancel={chat.cancelMessage}
              pinsFor={(id) => pinsForAgent(chat.pins, id)}
              attachedPins={(id) =>
                (attachedPinIds[id] ?? [])
                  .map((pinId) => chat.pins.find((p) => p.id === pinId))
                  .filter((p): p is NonNullable<typeof p> => p !== undefined)
              }
              onAttachPin={attachPin}
              onDetachPin={detachPin}
              requests={focus.requests}
              onOpenRequest={
                isBrowserRuntime ? (r) => openPinInViewer(r.pinId, r.requestId) : undefined
              }
              runOf={(id) => activeRun(workflows.runs, id)}
              slashCommandsOf={(id) => chat.slashCommands[id]}
              onLoadSlashCommands={chat.loadSlashCommands}
              slashEnabled={(id) => chat.privileged && chat.sendable[id] === true}
              onStopRun={chat.privileged || !isBrowserRuntime ? workflows.stopRun : undefined}
              onOpenRoom={(roomId) => {
                setIsMessengerOpen(false);
                setGroupChannelId(roomId);
                setIsGroupChatOpen(true);
              }}
              onOpenTerminal={
                isBrowserRuntime ? undefined : (id) => transport.send({ type: 'focusAgent', id })
              }
              onOpenFile={canSendChatFiles() ? openFileInViewer : undefined}
              docRefs={(id) => docRefsFor[id] ?? []}
              onRemoveDocRef={(id, i) =>
                setDocRefsFor((prev) => ({
                  ...prev,
                  [id]: (prev[id] ?? []).filter((_, j) => j !== i),
                }))
              }
              docked={messengerDocked}
              onToggleDock={() => setMessengerDocked((v) => !v)}
              onClose={() => setIsMessengerOpen(false)}
            />
          )}

          {isGroupChatOpen && !editor.isEditMode && (
            <GroupChatPanel
              initialChannelId={groupChannelId}
              channels={buildChannels(
                agents
                  .filter((id) => !officeState.characters.get(id)?.isSubagent)
                  .map((id) => {
                    const ch = officeState.characters.get(id);
                    return {
                      id,
                      label: agentLabel(id),
                      leadId: ch?.isTeamLead ? id : ch?.leadAgentId,
                      room: officeState.getTeamRoom(id),
                    };
                  }),
              )}
              chats={chat.chats}
              labelOf={agentLabel}
              usage={chat.usage}
              sendable={chat.sendable}
              relayEnabled={chat.relayEnabled}
              onSetRelay={chat.privileged || !isBrowserRuntime ? chat.setRelay : undefined}
              onSend={chat.sendMessage}
              onPin={(text, scope) =>
                chat.savePin({
                  id: newPinId(),
                  kind: 'note',
                  title: text.replace(/\s+/g, ' ').slice(0, 80),
                  value: text,
                  scope,
                  createdAt: new Date().toISOString(),
                })
              }
              onOpenAgent={openChat}
              onClose={() => setIsGroupChatOpen(false)}
            />
          )}

          {isTeamsOpen && !editor.isEditMode && (
            <TeamsPanel
              teams={teams}
              workflows={workflows.workflows}
              labelOf={agentLabel}
              canBrowseFolders={isBrowserRuntime && chat.privileged}
              folders={[
                ...chat.recentFolders,
                ...workspaceFolders
                  .map((f) => f.path)
                  .filter((p) => !chat.recentFolders.includes(p)),
              ]}
              canEdit={chat.privileged || !isBrowserRuntime}
              canStart={chat.canStartAgents}
              onOpenAgent={(id) => {
                setIsTeamsOpen(false);
                openChat(id);
              }}
              onClose={() => setIsTeamsOpen(false)}
            />
          )}

          {isWorkflowsOpen && !editor.isEditMode && (
            <WorkflowRail
              workflows={workflows.workflows}
              runs={workflows.runs}
              agents={agents
                .filter((id) => chat.sendable[id] === true)
                .map((id) => ({ id, label: agentLabel(id) }))}
              labelOf={agentLabel}
              onSave={chat.privileged || !isBrowserRuntime ? workflows.save : undefined}
              onDelete={chat.privileged || !isBrowserRuntime ? workflows.remove : undefined}
              onAttach={chat.privileged || !isBrowserRuntime ? workflows.attach : undefined}
              onStopRun={chat.privileged || !isBrowserRuntime ? workflows.stopRun : undefined}
              notice={workflows.notice}
              onClearNotice={workflows.clearNotice}
              onClose={() => setIsWorkflowsOpen(false)}
              onImport={chat.privileged || !isBrowserRuntime ? teams.importWorkflow : undefined}
              onDraft={chat.privileged || !isBrowserRuntime ? teams.draftWorkflow : undefined}
              drafts={teams.workflowDrafts}
              canBrowseFolders={isBrowserRuntime && chat.privileged}
              folders={[
                ...chat.recentFolders,
                ...workspaceFolders
                  .map((f) => f.path)
                  .filter((p) => !chat.recentFolders.includes(p)),
              ]}
            />
          )}

          {isFilesOpen && !editor.isEditMode && (
            <FilesRail
              files={files.files}
              backups={files.backups}
              uploadsBytes={files.uploadsBytes}
              backupsBytes={files.backupsBytes}
              suggestions={proposals.proposals.filter((p) => p.state === 'open')}
              labelOf={agentLabel}
              canManage={chat.privileged || !isBrowserRuntime}
              onClose={() => setIsFilesOpen(false)}
              onOpenFile={() => setIsOpenFileOpen(true)}
              onOpen={(f) => openFileInViewer(f.path)}
              onReview={(p) =>
                isDocProposal(p) ? openFileInViewer(p.path) : setReviewingId(p.proposalId)
              }
              onDiscard={(p) => proposals.discard(p.proposalId)}
              onPin={(f, pinned) => files.setPinned(f.fileId, pinned)}
              onForget={(f) => files.forget(f.fileId)}
              onDeleteUpload={(f) => files.deleteUpload(f.fileId)}
              onClearBackups={files.clearBackups}
            />
          )}

          {!editor.isEditMode && !isWorkflowsOpen && !isFilesOpen && (
            <TaskDesk
              isOpen={isDeskOpen}
              onToggle={() => {
                setIsDeskOpen((v) => !v);
                setIsWorkflowsOpen(false);
                setIsFilesOpen(false);
              }}
              desk={desk}
              labelOf={agentLabel}
              // Folders are browsed on the server's machine, which only the
              // standalone office can do; the VS Code panel offers its workspace.
              workflows={chat.privileged || !isBrowserRuntime ? workflows.workflows : undefined}
              onSaveWorkflow={chat.privileged || !isBrowserRuntime ? workflows.save : undefined}
              canBrowseFolders={isBrowserRuntime}
              recentFolders={chat.recentFolders}
              workspaceFolders={workspaceFolders}
              canStartAgents={chat.canStartAgents}
              teams={chat.canStartAgents ? teams.teams : undefined}
              modelOptions={chat.modelOptions.claude ?? []}
            />
          )}

          {!editor.isEditMode && !isGroupChatOpen && (
            <WhiteboardRail
              isOpen={isBoardOpen}
              onToggle={() => setIsBoardOpen((v) => !v)}
              pins={chatAgentId === null ? chat.pins : pinsForAgent(chat.pins, chatAgentId)}
              agents={agents
                .filter((id) => !officeState.characters.get(id)?.isSubagent)
                .map((id) => ({ id, label: agentLabel(id) }))}
              chatAgentLabel={
                chatAgentId !== null && chat.sendable[chatAgentId] === true
                  ? agentLabel(chatAgentId)
                  : null
              }
              onAttach={(pinId) => {
                if (chatAgentId !== null) attachPin(chatAgentId, pinId);
              }}
              onSave={chat.savePin}
              onRemove={chat.removePin}
              canDeleteFiles={chat.privileged || !isBrowserRuntime}
              // The viewer fetches files over HTTP from the standalone server;
              // the VS Code panel has no such route to call.
              onView={isBrowserRuntime ? (pinId) => openPinInViewer(pinId) : undefined}
              onUpload={isBrowserRuntime ? uploadBoardFile : undefined}
            />
          )}
        </>
      ) : (
        <DebugView
          agents={agents}
          selectedAgent={selectedAgent}
          agentTools={agentTools}
          agentStatuses={agentStatuses}
          subagentTools={subagentTools}
          officeState={officeState}
          onSelectAgent={handleSelectAgent}
        />
      )}

      {/* Hooks first-run tooltip. Gated on hooksInstalled (the hooksStatus
          message), NOT the hooksEnabled preference: hooksEnabled defaults true
          while first-run consent is still pending, and announcing "Instant
          Detection Active" before anything is installed would be a lie. */}
      {hooksEnabled && claudeHooksInstalled && !hooksInfoShown && !hooksTooltipDismissed && (
        <Tooltip
          title="Instant Detection Active"
          position="top-right"
          onDismiss={() => {
            setHooksTooltipDismissed(true);
            transport.send({ type: 'setHooksInfoShown' });
          }}
        >
          <span className="text-sm text-text leading-none">
            Your agents now respond in real-time.{' '}
            <span
              className="text-accent cursor-pointer underline"
              onClick={() => {
                setIsHooksInfoOpen(true);
                setHooksTooltipDismissed(true);
                transport.send({ type: 'setHooksInfoShown' });
              }}
            >
              View more
            </span>
          </span>
        </Tooltip>
      )}

      {/* Hooks info modal */}
      <Modal
        isOpen={isHooksInfoOpen}
        onClose={() => setIsHooksInfoOpen(false)}
        title="Instant Detection is ON"
        zIndex={52}
      >
        <div className="text-base text-text px-10" style={{ lineHeight: 1.4 }}>
          <p className="mb-8">Your Pixel Agents office now reacts in real-time:</p>
          <ul className="mb-8 pl-18 list-disc m-0">
            <li className="text-sm mb-2">Permission prompts appear instantly</li>
            <li className="text-sm mb-2">Turn completions detected the moment they happen</li>
            <li className="text-sm mb-2">Sound notifications play immediately</li>
          </ul>
          <p className="mb-12 text-text-muted">
            This works through Claude Code Hooks, small event listeners that notify Pixel Agents
            whenever something happens in your Claude sessions.
          </p>
          <div className="text-center">
            <button
              onClick={() => setIsHooksInfoOpen(false)}
              className="py-4 px-20 text-lg bg-accent text-white border border-accent rounded-ui cursor-pointer shadow-pixel"
            >
              Got it
            </button>
          </div>
          <p className="mt-8 text-xs text-text-muted text-center">
            To disable, go to Settings {'>'} Instant Detection
          </p>
        </div>
      </Modal>

      <BottomToolbar
        isEditMode={editor.isEditMode}
        layoutLabel={show3D ? 'Build' : 'Layout'}
        dockRight={editor.isEditMode && !show3D}
        onOpenClaude={editor.handleOpenClaude}
        onToggleEditMode={editor.handleToggleEditMode}
        isSettingsOpen={isSettingsOpen}
        onToggleSettings={() => setIsSettingsOpen((v) => !v)}
        isBoardOpen={isBoardOpen}
        onToggleBoard={() => {
          setIsBoardOpen((v) => !v);
          setIsGroupChatOpen(false);
        }}
        onAddAgent={chat.canStartAgents ? () => setIsAddAgentOpen(true) : undefined}
        onAddRoom={() => {
          if (!editor.isEditMode) editor.handleToggleEditMode();
          editor.handleToolChange(EditTool.ROOM);
        }}
        isDeskOpen={isDeskOpen}
        onToggleDesk={() => setIsDeskOpen((v) => !v)}
        deskWaiting={desk.tasks.filter(needsYou).length}
        isGroupChatOpen={isGroupChatOpen}
        onToggleGroupChat={() => {
          setGroupChannelId(undefined);
          setIsGroupChatOpen((v) => !v);
          setIsBoardOpen(false);
        }}
        isTeamsOpen={isTeamsOpen}
        onToggleTeams={() => setIsTeamsOpen((v) => !v)}
        isWorkflowsOpen={isWorkflowsOpen}
        onToggleWorkflows={() => {
          setIsWorkflowsOpen((v) => !v);
          setIsDeskOpen(false);
          setIsFilesOpen(false);
        }}
        isFilesOpen={isFilesOpen}
        filesWaiting={proposals.proposals.filter((p) => p.state === 'open').length}
        onToggleFiles={
          isBrowserRuntime && chat.privileged
            ? () => {
                setIsFilesOpen((v) => !v);
                setIsDeskOpen(false);
                setIsWorkflowsOpen(false);
              }
            : undefined
        }
        isMessengerOpen={isMessengerOpen}
        onToggleMessenger={() =>
          isMessengerOpen
            ? setIsMessengerOpen(false)
            : openMessenger(chatAgentId ?? messengerAgentId)
        }
        unreadChats={Object.values(chat.unread).filter(Boolean).length}
        workspaceFolders={workspaceFolders}
      />

      {fileOpenError && (
        <div
          role="alert"
          className="fixed left-1/2 -translate-x-1/2 bottom-80 z-70 pixel-panel flex items-center gap-8 px-10 py-6 text-sm border-danger"
        >
          <span className="text-danger">{fileOpenError}</span>
          <button
            className="bg-transparent border-0 text-text-muted cursor-pointer"
            onClick={() => setFileOpenError(null)}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}
      <OpenFileDialog
        isOpen={isOpenFileOpen}
        onClose={() => setIsOpenFileOpen(false)}
        onOpenPath={openFileInViewer}
        onUpload={async (file) => {
          const result = await uploadToFiles(file);
          if ('error' in result) return result.error;
          setViewedFocusId(null);
          setViewedFile({ id: result.fileId, path: result.path, title: file.name });
          return null;
        }}
      />
      <AddAgentModal
        isOpen={isAddAgentOpen}
        onClose={() => setIsAddAgentOpen(false)}
        recentFolders={chat.recentFolders}
        modelOptions={chat.modelOptions.claude ?? []}
        show3D={is3DView}
      />

      <LookModal
        agentName={lookAgentId === null ? null : agentLabel(lookAgentId)}
        current={lookAgentId === null ? undefined : officeState.agentLooks.get(lookAgentId)}
        onClose={() => setLookAgentId(null)}
        onSave={(look) => {
          if (lookAgentId === null) return;
          // Optimistic: the server echoes agentLook with the cleaned-up look.
          officeState.setCharacterLook(lookAgentId, look);
          transport.send({ type: 'setAgentLook', id: lookAgentId, look });
          setLookAgentId(null);
        }}
      />

      <Modal
        isOpen={roomNameDraft !== null}
        onClose={() => setRoomNameDraft(null)}
        title="Add team room"
        zIndex={54}
      >
        <form
          className="flex flex-col gap-8 px-10 pb-8"
          onKeyDown={(e) => e.stopPropagation()}
          onSubmit={(e) => {
            e.preventDefault();
            const name = (roomNameDraft ?? '').trim();
            if (!name) return;
            editor.handleAddTeamRoom(name);
            setRoomNameDraft(null);
          }}
        >
          <label className="flex flex-col gap-2 text-sm">
            Room name
            <input
              autoFocus
              value={roomNameDraft ?? ''}
              maxLength={32}
              placeholder="Team Payments"
              onChange={(e) => setRoomNameDraft(e.target.value)}
              className="px-8 py-4 bg-bg-dark text-text text-sm border border-border rounded-ui outline-none focus:border-accent"
              data-testid="room-name"
            />
          </label>
          <p className="m-0 text-2xs text-text-muted max-w-sm">
            Next, drag over the floor to paint the room, including the desks and chairs the team
            will use, then press Save. When a lead starts teammates, the whole team walks into the
            first free team room.
          </p>
          <div className="flex justify-end">
            <Button type="submit" size="md" variant="accent" data-testid="room-create">
              Create and paint
            </Button>
          </div>
        </form>
      </Modal>

      <VersionIndicator
        currentVersion={extensionVersion}
        lastSeenVersion={lastSeenVersion}
        onDismiss={handleWhatsNewDismiss}
        onOpenChangelog={handleOpenChangelog}
      />

      <ConnectionIndicator />

      <ChangelogModal
        isOpen={isChangelogOpen}
        onClose={() => setIsChangelogOpen(false)}
        currentVersion={extensionVersion}
      />

      <SettingsModal
        docEditDefault={chat.privileged || !isBrowserRuntime ? docEdits.defaultMode : undefined}
        onDocEditDefault={docEdits.setDefaultMode}
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        isDebugMode={isDebugMode}
        onToggleDebugMode={handleToggleDebugMode}
        is3DView={is3DView}
        onToggle3DView={handleToggle3DView}
        alwaysShowOverlay={alwaysShowOverlay}
        onToggleAlwaysShowOverlay={handleToggleAlwaysShowOverlay}
        ghostHeadlessAgents={ghostHeadlessAgents}
        onToggleGhostHeadlessAgents={handleToggleGhostHeadlessAgents}
        externalAssetDirectories={externalAssetDirectories}
        watchAllSessions={watchAllSessions}
        onToggleWatchAllSessions={() => {
          const newVal = !watchAllSessions;
          setWatchAllSessions(newVal);
          transport.send({ type: 'setWatchAllSessions', enabled: newVal });
        }}
        hooksInstalled={claudeHooksInstalled}
        onToggleHooksEnabled={() => {
          // Toggle the DISPLAYED state (actual install), not the preference: when the two disagree — preference on,
          // nothing installed while consent is pending — toggling the preference would turn hooks OFF for a user
          // asking for ON. No optimistic local update either; both backends answer with the truthful hooksStatus this
          // checkbox renders, so it lands correct instead of flickering when an install fails. The providerId is
          // ECHOED from that row (never originated here), so nothing sends until the row has arrived.
          const [rowProviderId] =
            Object.entries(hooksInstalled).find(([id]) => id === 'claude') ?? [];
          if (rowProviderId !== undefined) {
            transport.send({
              type: 'setHooksEnabled',
              providerId: rowProviderId,
              enabled: !claudeHooksInstalled,
            });
          }
        }}
        showAreas={showAreas}
        onToggleShowAreas={onToggleShowAreas}
        showAreasAvailable={areasAvailable}
        onExportLayout={handleExportLayout}
        onImportLayout={handleImportLayout}
        onShowIntro={() => setIntroReplay(true)}
        onUseCityOffice={() =>
          editor.applyPresetLayout(migrateLayoutColors(cityOfficeLayout as unknown as OfficeLayout))
        }
        onUseSoftOffice={() =>
          editor.applyPresetLayout(migrateLayoutColors(softOfficeLayout as unknown as OfficeLayout))
        }
        onUseOriginalOffice={() =>
          editor.applyPresetLayout(
            migrateLayoutColors(originalOfficeLayout as unknown as OfficeLayout),
          )
        }
      />

      {(() => {
        const viewed = viewedFile;
        if (!viewed) return null;
        const canAttach = chatAgentId !== null && chat.sendable[chatAgentId] === true;
        const viewedFocus = focus.requests.find(
          (r) => r.requestId === viewedFocusId && samePath(viewed.path, r.path),
        );
        // "Ask about this" goes to the chat on screen — Messages when it is open
        // (it covers the chat card), else the chat card — else the agent that
        // asked to look.
        const messengerTarget =
          isMessengerOpen && messengerAgentId !== null && agents.includes(messengerAgentId)
            ? messengerAgentId
            : null;
        const askTarget =
          messengerTarget ??
          chatAgentId ??
          viewedFocus?.agentId ??
          (messengerAgentId !== null && agents.includes(messengerAgentId)
            ? messengerAgentId
            : null);
        const labelOfRequest = (agentId?: number) =>
          agentId !== undefined ? agentLabel(agentId) : 'An agent';
        return (
          <DocViewer
            file={viewed}
            filePins={chat.pins.filter((p) => p.kind === 'file')}
            onSelect={(pinId) => openPinInViewer(pinId)}
            onClose={() => {
              setViewedFile(null);
              setViewedFocusId(null);
            }}
            focus={viewedFocus}
            focusAgent={labelOfRequest(viewedFocus?.agentId)}
            onAnswerFocus={
              viewedFocus && (chat.privileged || !isBrowserRuntime)
                ? (reply) => focus.answer(viewedFocus.requestId, reply)
                : undefined
            }
            requests={[...focus.requests]
              .reverse()
              .map((request) => ({ request, agent: labelOfRequest(request.agentId) }))}
            refs={docTray}
            onAddRef={(ref) =>
              setDocTray((prev) =>
                prev.some((r) => refText(r) === refText(ref)) ? prev : [...prev, ref],
              )
            }
            onRemoveRef={(i) => setDocTray((prev) => prev.filter((_, j) => j !== i))}
            askLabel={askTarget !== null ? agentLabel(askTarget) : undefined}
            lastEditKey={[
              lastEditKeyFor(docEdits.edits, viewed.path),
              // Applying (or undoing) a suggestion rewrites the file too.
              ...proposals.proposals
                .filter((p) => samePath(p.path, viewed.path) && p.state !== 'open')
                .map((p) => `${p.proposalId}:${p.state}:${p.canUndo ? 1 : 0}`),
            ].join('|')}
            appliedSuggestion={(() => {
              const done = [...proposals.proposals]
                .reverse()
                .find((p) => samePath(p.path, viewed.path) && p.state === 'applied' && p.canUndo);
              return done && (chat.privileged || !isBrowserRuntime)
                ? { note: done.note ?? 'Applied.', onUndo: () => proposals.undo(done.proposalId) }
                : undefined;
            })()}
            suggestion={(() => {
              const open = openProposalFor(proposals.proposals, viewed.path);
              return open
                ? {
                    proposal: open,
                    agentLabel: open.agentId !== undefined ? agentLabel(open.agentId) : 'An agent',
                    canDecide: chat.privileged || !isBrowserRuntime,
                    onDecide: (hunkId, decision) =>
                      proposals.decide(open.proposalId, hunkId, decision),
                    onApply: () => proposals.apply(open.proposalId),
                    onDiscard: () => proposals.discard(open.proposalId),
                  }
                : undefined;
            })()}
            onOpenFile={chat.privileged ? () => setIsOpenFileOpen(true) : undefined}
            ask={
              chat.privileged || !isBrowserRuntime
                ? {
                    agents: agents
                      .filter(
                        (id) =>
                          chat.sendable[id] === true && !officeState.characters.get(id)?.isSubagent,
                      )
                      .map((id) => ({
                        id,
                        label: agentLabel(id),
                        busy:
                          chat.asking[id] === true ||
                          officeState.characters.get(id)?.isActive === true,
                        inFolder: isInFolder(
                          viewed.path,
                          desk.agents.find((a) => a.id === id)?.root,
                        ),
                      })),
                    preferred: askTarget,
                    canStartAgent: chat.canStartAgents,
                    entriesFor: (id) => chat.chats[id] ?? [],
                    onSend: chat.sendMessage,
                    onOpenChat: (id) => {
                      setViewedFile(null);
                      setViewedFocusId(null);
                      openChat(id);
                    },
                    onClearRefs: () => setDocTray([]),
                  }
                : undefined
            }
            onDeleteFile={
              chat.privileged && isStoredUploadPath(viewed.path)
                ? () => {
                    files.deleteUpload(viewed.id);
                    setViewedFile(null);
                    setViewedFocusId(null);
                  }
                : undefined
            }
            onAskRefs={
              askTarget !== null
                ? () => {
                    const target = askTarget;
                    setDocRefsFor((prev) => {
                      const current = prev[target] ?? [];
                      const merged = [...current];
                      for (const ref of docTray) {
                        if (!merged.some((r) => refText(r) === refText(ref))) merged.push(ref);
                      }
                      return { ...prev, [target]: merged };
                    });
                    setDocTray([]);
                    setViewedFile(null);
                    setViewedFocusId(null);
                    if (isMessengerOpen) openMessenger(target);
                    else openChat(target);
                  }
                : undefined
            }
            onSelectRequest={(requestId) => {
              const request = focus.requests.find((r) => r.requestId === requestId);
              if (!request) return;
              openPinInViewer(request.pinId, requestId);
            }}
            onAttach={
              canAttach
                ? () => {
                    // A pinned file attaches as its pin; any other file as a reference.
                    const pin = chat.pins.find(
                      (p) => p.kind === 'file' && samePath(viewed.path, p.value),
                    );
                    if (pin) attachPin(chatAgentId, pin.id);
                    else
                      setDocRefsFor((prev) => ({
                        ...prev,
                        [chatAgentId]: [...(prev[chatAgentId] ?? []), { path: viewed.path }],
                      }));
                    setViewedFile(null);
                  }
                : undefined
            }
          />
        );
      })()}

      {(() => {
        const reviewing = reviewingId
          ? proposals.proposals.find((p) => p.proposalId === reviewingId)
          : undefined;
        if (!reviewing) return null;
        return (
          <ReviewPanel
            proposal={reviewing}
            agentLabel={
              reviewing.agentId !== undefined ? agentLabel(reviewing.agentId) : 'the agent'
            }
            proposals={proposals}
            canDecide={chat.privileged || !isBrowserRuntime}
            onClose={() => setReviewingId(null)}
            notice={teams.notice?.error ? teams.notice.message : null}
            onClearNotice={teams.clearNotice}
          />
        );
      })()}

      {showMigrationNotice && (
        <MigrationNotice onDismiss={() => setMigrationNoticeDismissed(true)} />
      )}

      {showIntro && (
        <IntroBubble
          officeState={officeState}
          headline={intro?.headline ?? ''}
          disclosure={intro?.disclosure ?? ''}
          hasConsent={intro !== null}
          containerRef={containerRef}
          zoom={editor.zoom}
          panRef={editor.panRef}
          installFailed={installFailed}
          installPending={installPending}
          onChoice={handleConsentChoice}
          onClose={closeIntro}
          escapeSuppressed={
            isSettingsOpen ||
            isChangelogOpen ||
            isHooksInfoOpen ||
            showMigrationNotice ||
            editor.isEditMode
          }
        />
      )}
    </div>
  );
}

export default App;

function readIntroSeen(): boolean {
  try {
    return window.localStorage.getItem(INTRO_SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

function markIntroSeen(): void {
  try {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
  } catch {
    // Storage blocked: the tour just shows again next time.
  }
}
