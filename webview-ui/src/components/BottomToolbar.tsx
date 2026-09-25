import type { ReactNode } from 'react';
import { Fragment, useEffect, useRef, useState } from 'react';

import { MOBILE_BREAKPOINT_PX } from '../constants.js';
import type { WorkspaceFolder } from '../hooks/useExtensionMessages.js';
import { isBrowserRuntime } from '../runtime.js';
import { transport } from '../transport/index.js';
import { Dropdown, DropdownItem } from './ui/Dropdown.js';

/** A toolbar action that can sit on the bar or, when rarely used or the window is narrow, in More. */
interface ToolbarItem {
  key: string;
  label: string;
  title: string;
  testId?: string;
  active?: boolean;
  /** Waiting count shown on the label; items that carry one never go into More. */
  badge?: number;
  className?: string;
  /** Always in More (rarely used). */
  inMore?: boolean;
  /** In More when the window is narrow. */
  narrowInMore?: boolean;
  onClick: () => void;
}

function isNarrowWindow(): boolean {
  return typeof window !== 'undefined' && window.innerWidth < MOBILE_BREAKPOINT_PX;
}

interface BottomToolbarProps {
  isEditMode: boolean;
  onOpenClaude: () => void;
  onToggleEditMode: () => void;
  isSettingsOpen: boolean;
  onToggleSettings: () => void;
  isBoardOpen: boolean;
  onToggleBoard: () => void;
  /** Standalone office: open the Add agent dialog (absent when it can't start agents). */
  onAddAgent?: () => void;
  onAddRoom: () => void;
  /** Standalone office, private link: open a document from this computer (absent otherwise). */
  onOpenFile?: () => void;
  /** Files rail (standalone, private link); absent otherwise. */
  isFilesOpen?: boolean;
  onToggleFiles?: () => void;
  /** Suggestions waiting for review, shown on the Files button. */
  filesWaiting?: number;
  isDeskOpen: boolean;
  onToggleDesk: () => void;
  /** Cards waiting on the human (a brief to judge, a result to check). */
  deskWaiting: number;
  isGroupChatOpen: boolean;
  onToggleGroupChat: () => void;
  isMessengerOpen: boolean;
  onToggleMessenger: () => void;
  isWorkflowsOpen: boolean;
  onToggleWorkflows: () => void;
  isTeamsOpen: boolean;
  onToggleTeams: () => void;
  /** Agents with replies the user hasn't read. */
  unreadChats: number;
  workspaceFolders: WorkspaceFolder[];
}

export function BottomToolbar({
  isEditMode,
  onOpenClaude,
  onToggleEditMode,
  isSettingsOpen,
  onToggleSettings,
  isBoardOpen,
  onToggleBoard,
  onAddAgent,
  onAddRoom,
  onOpenFile,
  isFilesOpen = false,
  onToggleFiles,
  filesWaiting = 0,
  isDeskOpen,
  onToggleDesk,
  deskWaiting,
  isGroupChatOpen,
  onToggleGroupChat,
  isMessengerOpen,
  onToggleMessenger,
  isWorkflowsOpen,
  onToggleWorkflows,
  isTeamsOpen,
  onToggleTeams,
  unreadChats,
  workspaceFolders,
}: BottomToolbarProps) {
  const [isFolderPickerOpen, setIsFolderPickerOpen] = useState(false);
  const [isBypassMenuOpen, setIsBypassMenuOpen] = useState(false);
  const folderPickerRef = useRef<HTMLDivElement>(null);
  const pendingBypassRef = useRef(false);
  const [isMoreOpen, setIsMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const [isNarrow, setIsNarrow] = useState(isNarrowWindow);
  useEffect(() => {
    const onResize = () => setIsNarrow(isNarrowWindow());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  // Close More on outside click
  useEffect(() => {
    if (!isMoreOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setIsMoreOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isMoreOpen]);
  // Close folder picker / bypass menu on outside click
  useEffect(() => {
    if (!isFolderPickerOpen && !isBypassMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (folderPickerRef.current && !folderPickerRef.current.contains(e.target as Node)) {
        setIsFolderPickerOpen(false);
        setIsBypassMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isFolderPickerOpen, isBypassMenuOpen]);

  const hasMultipleFolders = workspaceFolders.length > 1;

  const handleAgentClick = () => {
    setIsBypassMenuOpen(false);
    pendingBypassRef.current = false;
    if (hasMultipleFolders) {
      setIsFolderPickerOpen((v) => !v);
    } else {
      onOpenClaude();
    }
  };

  const handleAgentHover = () => {
    if (!isFolderPickerOpen) {
      setIsBypassMenuOpen(true);
    }
  };

  const handleAgentLeave = () => {
    if (!isFolderPickerOpen) {
      setIsBypassMenuOpen(false);
    }
  };

  const handleFolderSelect = (folder: WorkspaceFolder) => {
    setIsFolderPickerOpen(false);
    const bypassPermissions = pendingBypassRef.current;
    pendingBypassRef.current = false;
    transport.send({ type: 'launchAgent', folderPath: folder.path, bypassPermissions });
  };

  const handleBypassSelect = (bypassPermissions: boolean) => {
    setIsBypassMenuOpen(false);
    if (hasMultipleFolders) {
      pendingBypassRef.current = bypassPermissions;
      setIsFolderPickerOpen(true);
    } else {
      transport.send({ type: 'launchAgent', bypassPermissions });
    }
  };

  const withBadge = (label: string, n = 0) => (n > 0 ? `${label} · ${n}` : label);

  // Groups, left to right: talk to agents, give them work, shared resources, the office itself.
  const groups: ToolbarItem[][] = [
    [
      {
        key: 'messages',
        label: 'Messages',
        title: "Messages: read and answer each agent's chat (M)",
        testId: 'messenger-toggle',
        active: isMessengerOpen,
        badge: unreadChats,
        onClick: onToggleMessenger,
      },
      {
        key: 'chat',
        label: 'Chat',
        title: 'Group chat: everyone and each team',
        testId: 'group-chat-toggle',
        active: isGroupChatOpen,
        narrowInMore: true,
        onClick: onToggleGroupChat,
      },
    ],
    [
      {
        key: 'desk',
        label: 'Desk',
        title: 'Task desk: cards for free agents to look at, built when you say so',
        testId: 'desk-toggle',
        active: isDeskOpen,
        badge: deskWaiting,
        onClick: onToggleDesk,
      },
      {
        key: 'workflows',
        label: 'Workflows',
        title: 'Workflows: steps you write once and give to agents',
        testId: 'workflows-toggle',
        active: isWorkflowsOpen,
        narrowInMore: true,
        onClick: onToggleWorkflows,
      },
      {
        key: 'teams',
        label: 'Teams',
        title: 'Teams: presets you start in one go',
        testId: 'teams-toggle',
        active: isTeamsOpen,
        narrowInMore: true,
        onClick: onToggleTeams,
      },
    ],
    [
      ...(onToggleFiles
        ? [
            {
              key: 'files',
              label: 'Files',
              title: 'Files: documents you opened, suggestions to review, uploads, backups',
              testId: 'files-toggle',
              active: isFilesOpen,
              badge: filesWaiting,
              className: filesWaiting > 0 ? 'text-status-permission' : '',
              onClick: onToggleFiles,
            },
          ]
        : []),
      ...(onOpenFile
        ? [
            {
              key: 'open-file',
              label: 'Open file',
              title: 'Open a Word, PowerPoint, Excel, PDF, text or image file',
              testId: 'open-file-button',
              inMore: true,
              onClick: onOpenFile,
            },
          ]
        : []),
      {
        key: 'board',
        label: 'Board',
        title: 'Whiteboard: resources shared by every session',
        active: isBoardOpen,
        narrowInMore: true,
        onClick: onToggleBoard,
      },
    ],
    [
      {
        key: 'layout',
        label: 'Layout',
        title: 'Edit office layout',
        active: isEditMode,
        onClick: onToggleEditMode,
      },
      {
        key: 'room',
        label: '+ Room',
        title: 'Add a team room',
        testId: 'add-room',
        inMore: true,
        onClick: onAddRoom,
      },
    ],
  ];

  const hidden = (item: ToolbarItem) =>
    !item.badge && (item.inMore === true || (isNarrow && item.narrowInMore === true));
  const moreItems = groups.flat().filter(hidden);
  const barGroups = groups.map((g) => g.filter((item) => !hidden(item))).filter((g) => g.length);

  const renderButton = (item: ToolbarItem) => (
    <button
      key={item.key}
      type="button"
      onClick={item.onClick}
      title={item.title}
      data-testid={item.testId}
      aria-pressed={item.active ? true : undefined}
      className={`${DOCK_BTN} ${item.active ? 'bg-active-bg text-text' : 'text-text-muted'} ${item.className ?? ''}`}
    >
      <DockIcon name={item.key} />
      {withBadge(item.label, item.badge)}
    </button>
  );

  const separator = (key: string): ReactNode => (
    <span key={key} aria-hidden="true" className="w-1 self-stretch my-6 mx-2 bg-border" />
  );

  return (
    <div
      className={`absolute bottom-12 z-20 w-fit flex flex-wrap items-stretch justify-center gap-2 pixel-panel p-6 ${
        // Editing: the editor's tool panel takes the bottom-left, so the dock moves right.
        isEditMode ? 'right-12' : 'inset-x-0 mx-auto'
      }`}
      style={{ maxWidth: 'calc(100% - 24px)' }}
    >
      {/* Hide + Agent in standalone browser mode (no terminal to interact with) */}
      {!isBrowserRuntime && (
        <div
          ref={folderPickerRef}
          className="relative"
          onMouseEnter={handleAgentHover}
          onMouseLeave={handleAgentLeave}
        >
          <button
            type="button"
            onClick={handleAgentClick}
            className={`${DOCK_BTN} text-accent-ink ${
              isFolderPickerOpen || isBypassMenuOpen
                ? 'bg-accent-bright'
                : 'bg-accent hover:bg-accent-bright'
            }`}
          >
            <DockIcon name="agent" />+ Agent
          </button>
          <Dropdown isOpen={isBypassMenuOpen}>
            <DropdownItem onClick={() => handleBypassSelect(true)}>
              Skip permissions mode <span className="text-2xs text-warning">⚠</span>
            </DropdownItem>
          </Dropdown>
          <Dropdown isOpen={isFolderPickerOpen} className="min-w-128">
            {workspaceFolders.map((folder) => (
              <DropdownItem
                key={folder.path}
                onClick={() => handleFolderSelect(folder)}
                className="text-base"
              >
                {folder.name}
              </DropdownItem>
            ))}
          </Dropdown>
        </div>
      )}
      {isBrowserRuntime && onAddAgent && (
        <button
          type="button"
          onClick={onAddAgent}
          className={`${DOCK_BTN} text-accent-ink bg-accent hover:bg-accent-bright`}
          data-testid="add-agent"
        >
          <DockIcon name="agent" />+ Agent
        </button>
      )}
      {barGroups.map((group, i) => (
        <Fragment key={group[0].key}>
          {(i > 0 || !isBrowserRuntime || onAddAgent) && separator(`sep-${group[0].key}`)}
          {group.map(renderButton)}
        </Fragment>
      ))}
      {separator('sep-end')}
      {moreItems.length > 0 && (
        <div ref={moreRef} className="relative">
          <button
            type="button"
            onClick={() => setIsMoreOpen((v) => !v)}
            title="More: less used actions"
            aria-expanded={isMoreOpen}
            data-testid="toolbar-more"
            className={`${DOCK_BTN} ${
              isMoreOpen || moreItems.some((item) => item.active)
                ? 'bg-active-bg text-text'
                : 'text-text-muted'
            }`}
          >
            <DockIcon name="more" />
            More ▾
          </button>
          <Dropdown isOpen={isMoreOpen} className="min-w-128">
            {moreItems.map((item) => (
              <DropdownItem
                key={item.key}
                onClick={() => {
                  setIsMoreOpen(false);
                  item.onClick();
                }}
                title={item.title}
                data-testid={item.testId}
                className={`text-base ${item.active ? 'bg-active-bg' : ''}`}
              >
                {item.label}
              </DropdownItem>
            ))}
          </Dropdown>
        </div>
      )}
      <button
        type="button"
        onClick={onToggleSettings}
        title="Settings"
        className={`${DOCK_BTN} ${isSettingsOpen ? 'bg-active-bg text-text' : 'text-text-muted'}`}
      >
        <DockIcon name="settings" />
        Settings
      </button>
    </div>
  );
}

const DOCK_BTN =
  'flex flex-col items-center justify-center gap-3 min-w-60 px-8 pt-7 pb-5 border-0 rounded-ui cursor-pointer bg-transparent text-2xs font-medium hover:bg-btn-hover hover:text-text transition-colors';

/** Line icons for the dock (24-unit grid, drawn with currentColor). */
const DOCK_ICONS: Record<string, ReactNode> = {
  agent: <path d="M12 5v14M5 12h14" />,
  messages: <path d="M4 5h16v11H9l-5 4z" />,
  chat: (
    <>
      <path d="M3 6h12v8H8l-5 4z" />
      <path d="M17 9h4v8l-3-2h-6v-1" />
    </>
  ),
  desk: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M9 4v16M4 10h5" />
    </>
  ),
  workflows: (
    <>
      <circle cx="6" cy="6" r="2" />
      <circle cx="18" cy="12" r="2" />
      <circle cx="6" cy="18" r="2" />
      <path d="M8 6h4a4 4 0 0 1 4 4M8 18h4a4 4 0 0 0 4-4" />
    </>
  ),
  teams: (
    <>
      <circle cx="9" cy="8" r="3" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M15 14.5c3 0 6 1.8 6 5.5" />
    </>
  ),
  files: (
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4" />
    </>
  ),
  'open-file': (
    <>
      <path d="M3 7h6l2 2h10v10H3z" />
    </>
  ),
  board: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="1" />
      <path d="M8 20l4-4 4 4" />
    </>
  ),
  layout: <path d="M3 3h18v18H3zM3 12h9V3M12 12v9" />,
  room: <path d="M4 4h16v16H4zM12 20v-6" />,
  more: (
    <>
      <circle cx="6" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="18" cy="12" r="1.5" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1" />
    </>
  ),
};

function DockIcon({ name }: { name: string }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {DOCK_ICONS[name] ?? DOCK_ICONS.more}
    </svg>
  );
}
