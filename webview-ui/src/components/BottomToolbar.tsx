import type { ReactNode } from 'react';
import { Fragment, useEffect, useRef, useState } from 'react';

import { MOBILE_BREAKPOINT_PX } from '../constants.js';
import type { WorkspaceFolder } from '../hooks/useExtensionMessages.js';
import { isBrowserRuntime } from '../runtime.js';
import { transport } from '../transport/index.js';
import { Button } from './ui/Button.js';
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
    <Button
      key={item.key}
      variant={item.active ? 'active' : 'default'}
      onClick={item.onClick}
      title={item.title}
      data-testid={item.testId}
      className={item.className ?? ''}
    >
      {withBadge(item.label, item.badge)}
    </Button>
  );

  const separator = (key: string): ReactNode => (
    <span key={key} aria-hidden="true" className="w-2 self-stretch bg-border" />
  );

  return (
    <div
      className="absolute bottom-10 left-10 z-20 flex flex-wrap items-center gap-4 pixel-panel p-4"
      style={{ maxWidth: 'calc(100% - 20px)' }}
    >
      {/* Hide + Agent in standalone browser mode (no terminal to interact with) */}
      {!isBrowserRuntime && (
        <div
          ref={folderPickerRef}
          className="relative"
          onMouseEnter={handleAgentHover}
          onMouseLeave={handleAgentLeave}
        >
          <Button
            variant="accent"
            onClick={handleAgentClick}
            className={
              isFolderPickerOpen || isBypassMenuOpen
                ? 'bg-accent-bright'
                : 'bg-accent hover:bg-accent-bright'
            }
          >
            + Agent
          </Button>
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
        <Button
          variant="accent"
          onClick={onAddAgent}
          className="bg-accent hover:bg-accent-bright"
          data-testid="add-agent"
        >
          + Agent
        </Button>
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
          <Button
            variant={isMoreOpen || moreItems.some((item) => item.active) ? 'active' : 'default'}
            onClick={() => setIsMoreOpen((v) => !v)}
            title="More: less used actions"
            aria-expanded={isMoreOpen}
            data-testid="toolbar-more"
          >
            More ▾
          </Button>
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
      <Button
        variant={isSettingsOpen ? 'active' : 'default'}
        onClick={onToggleSettings}
        title="Settings"
      >
        Settings
      </Button>
    </div>
  );
}
