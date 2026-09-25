import { useEffect, useState } from 'react';

import type { BackupGroup, OfficeFile, Proposal } from '../../../core/src/messages.js';
import { FILES_CLOCK_TICK_MS } from '../constants.js';
import { fileBaseName, fileExtension } from '../docViewer.js';
import { ago, type FilesTab, filesTab } from '../filesView.js';
import { formatSize } from '../openFile.js';
import { tunable } from '../tunableStore.js';
import { Button } from './ui/Button.js';

interface FilesRailProps {
  files: OfficeFile[];
  backups: BackupGroup[];
  uploadsBytes: number;
  backupsBytes: number;
  /** Open suggestions (any file), for the Review tab. */
  suggestions: Proposal[];
  labelOf: (agentId: number) => string;
  /** This connection may pin, delete and clear (privileged). */
  canManage: boolean;
  onClose: () => void;
  onOpenFile: () => void;
  onOpen: (file: OfficeFile) => void;
  onReview: (proposal: Proposal) => void;
  onDiscard: (proposal: Proposal) => void;
  onPin: (file: OfficeFile, pinned: boolean) => void;
  onForget: (file: OfficeFile) => void;
  onDeleteUpload: (file: OfficeFile) => void;
  onClearBackups: (key?: string) => void;
}

const TAB_LABEL: Record<FilesTab, string> = {
  recent: 'Recent',
  review: 'Review',
  uploads: 'Uploads',
  backups: 'Backups',
};

const EXT_CLASS: Record<string, string> = {
  docx: 'text-accent-bright border-accent-bright',
  pptx: 'text-warning border-warning',
  xlsx: 'text-status-success border-status-success',
  pdf: 'text-danger border-danger',
};

function Ext({ name }: { name: string }) {
  const ext = fileExtension(name);
  return (
    <span
      className={`w-44 shrink-0 text-center py-2 text-2xs uppercase border ${
        EXT_CLASS[ext] ?? 'text-text-muted border-border'
      }`}
    >
      {ext || 'file'}
    </span>
  );
}

/**
 * Files: the documents the office opened — separate from the whiteboard, so
 * opening a file never shows it to agents (Pin to board does). Recent files,
 * suggestions waiting for review, the office's uploaded copies, and backups
 * with the space they take. Left rail, like the task desk.
 */
export function FilesRail({
  files,
  backups,
  uploadsBytes,
  backupsBytes,
  suggestions,
  labelOf,
  canManage,
  onClose,
  onOpenFile,
  onOpen,
  onReview,
  onDiscard,
  onPin,
  onForget,
  onDeleteUpload,
  onClearBackups,
}: FilesRailProps) {
  const [tab, setTab] = useState<FilesTab>('recent');
  const [selected, setSelected] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  // "5 min ago" labels: the clock ticks in state, never read during render.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), FILES_CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  const shown = filesTab(files, tab);
  const counts: Record<FilesTab, number> = {
    recent: files.length,
    review: suggestions.length,
    uploads: files.filter((f) => f.source === 'upload').length,
    backups: backups.reduce((sum, g) => sum + g.versions, 0),
  };
  const reviewing = (f: OfficeFile) => suggestions.filter((p) => p.path === f.path).length;

  return (
    <aside
      aria-label="Files"
      className="absolute left-0 top-0 bottom-0 z-30 flex flex-col bg-bg text-text border-r-4 border-border"
      style={{ width: `min(${tunable('taskDeskWidthPx')}px, 100%)` }}
      data-testid="files-rail"
      onMouseDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-8 px-10 py-6 border-b-2 border-border">
        <span className="flex-1 text-lg">Files</span>
        <Button size="sm" variant="accent" onClick={onOpenFile} data-testid="files-open">
          Open file…
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label="Close files"
          title="Close"
        >
          ×
        </Button>
      </div>

      <div role="tablist" className="flex border-b-2 border-border">
        {(Object.keys(TAB_LABEL) as FilesTab[]).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => {
              setTab(t);
              setConfirm(null);
            }}
            className={`flex-1 min-w-0 px-4 py-6 text-xs border-0 border-b-4 rounded-ui cursor-pointer whitespace-nowrap ${
              tab === t
                ? 'bg-bg text-text border-accent'
                : 'bg-bg-dark text-text-muted border-transparent'
            }`}
            data-testid={`files-tab-${t}`}
          >
            {TAB_LABEL[t]}
            <span
              className={`ml-4 px-4 text-2xs ${
                t === 'review' && counts.review > 0
                  ? 'bg-status-permission text-bg'
                  : 'bg-bg-thumb text-text'
              }`}
            >
              {counts[t]}
            </span>
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-6 p-8">
        {tab === 'review' &&
          (suggestions.length === 0 ? (
            <span className="text-sm text-text-muted p-8 text-center">
              Nothing waiting for review.
            </span>
          ) : (
            suggestions.map((p) => (
              <div
                key={p.proposalId}
                className="flex flex-col gap-4 p-8 border border-status-permission bg-bg-dark"
                data-testid="files-review-item"
              >
                <div className="flex items-center gap-8 min-w-0">
                  <Ext name={p.path} />
                  <span className="flex-1 min-w-0 truncate text-sm" title={p.path}>
                    {fileBaseName(p.path).replace(/^pin_[A-Za-z0-9]+-/, '')}
                  </span>
                </div>
                <span className="text-xs">
                  <span className="text-status-success">
                    {p.agentId !== undefined ? labelOf(p.agentId) : 'An agent'}
                  </span>{' '}
                  suggests {p.hunks.length} change{p.hunks.length === 1 ? '' : 's'}
                  {p.why ? <span className="text-text-muted"> — “{p.why}”</span> : null}
                </span>
                {canManage && (
                  <div className="flex gap-6">
                    <Button size="sm" variant="accent" onClick={() => onReview(p)}>
                      Review
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => onDiscard(p)}>
                      Discard
                    </Button>
                  </div>
                )}
              </div>
            ))
          ))}

        {tab === 'backups' && (
          <>
            {backups.length === 0 ? (
              <span className="text-sm text-text-muted p-8 text-center">
                No backups. The office keeps one each time it writes a file, so Undo can put it
                back.
              </span>
            ) : (
              backups.map((g) => (
                <div
                  key={g.key}
                  className="flex items-center gap-8 p-8 border border-border bg-bg-dark"
                  data-testid="files-backup-group"
                >
                  <Ext name={g.name} />
                  <span className="flex-1 min-w-0 flex flex-col">
                    <span className="text-sm truncate" title={g.name}>
                      {g.name}
                    </span>
                    <span className="text-2xs text-text-muted">
                      {g.versions} version{g.versions === 1 ? '' : 's'} · {formatSize(g.bytes)} ·
                      newest {ago(g.newestAt, now)}
                    </span>
                  </span>
                  {canManage && (
                    <Button size="sm" onClick={() => onClearBackups(g.key)}>
                      Clear
                    </Button>
                  )}
                </div>
              ))
            )}
            {canManage && backups.length > 0 && (
              <div className="flex items-center gap-8 flex-wrap">
                {confirm === 'all-backups' ? (
                  <>
                    <span className="text-xs text-danger">
                      Delete every backup? Undo stops working for past edits.
                    </span>
                    <Button
                      size="sm"
                      className="text-danger"
                      onClick={() => {
                        setConfirm(null);
                        onClearBackups();
                      }}
                    >
                      Clear all
                    </Button>
                    <Button size="sm" onClick={() => setConfirm(null)}>
                      Keep
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    className="text-danger"
                    onClick={() => setConfirm('all-backups')}
                  >
                    Clear all backups
                  </Button>
                )}
              </div>
            )}
            <span className="text-2xs text-text-muted">
              Kept automatically: the last 5 versions of each file, for 7 days.
            </span>
          </>
        )}

        {(tab === 'recent' || tab === 'uploads') &&
          (shown.length === 0 ? (
            <span className="text-sm text-text-muted p-8 text-center">
              {tab === 'uploads'
                ? 'No uploaded copies. Files opened from this computer are never copied.'
                : 'No files yet. Open one to start.'}
            </span>
          ) : (
            shown.map((f) => {
              const isOpen = selected === f.fileId;
              const pending = reviewing(f);
              return (
                <div
                  key={f.fileId}
                  className={`flex flex-col border ${isOpen ? 'border-accent bg-bg-dark' : 'border-transparent'}`}
                  data-testid="files-item"
                >
                  <button
                    className="flex items-center gap-8 p-6 text-left bg-transparent border-0 rounded-ui cursor-pointer text-text hover:bg-btn-hover min-w-0"
                    onClick={() => {
                      setSelected(isOpen ? null : f.fileId);
                      setConfirm(null);
                    }}
                    onDoubleClick={() => !f.missing && onOpen(f)}
                    title={f.path}
                  >
                    <Ext name={f.name} />
                    <span className="flex-1 min-w-0 flex flex-col">
                      <span
                        className={`text-sm truncate ${f.missing ? 'line-through text-text-muted' : ''}`}
                      >
                        {f.name}
                      </span>
                      <span className="text-2xs text-text-muted truncate">
                        {f.editedAt
                          ? `edited ${ago(f.editedAt, now)}`
                          : `opened ${ago(f.openedAt, now)}`}
                        {f.size !== undefined ? ` · ${formatSize(f.size)}` : ''}
                      </span>
                    </span>
                    <span className="flex flex-col items-end gap-2 shrink-0">
                      {pending > 0 && (
                        <span className="px-4 text-2xs border border-status-permission text-status-permission">
                          {pending} to review
                        </span>
                      )}
                      {f.pinned && (
                        <span className="px-4 text-2xs border border-pin-note text-pin-note">
                          pinned
                        </span>
                      )}
                      {f.source === 'upload' && (
                        <span className="px-4 text-2xs border border-border text-text-muted">
                          copy
                        </span>
                      )}
                      {f.missing && (
                        <span className="px-4 text-2xs border border-danger text-danger">
                          missing
                        </span>
                      )}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="flex flex-col gap-6 px-8 pb-8">
                      <span className="text-2xs text-text-muted break-all">{f.path}</span>
                      <span className="text-2xs text-text-muted">
                        {f.source === 'upload'
                          ? 'A copy the office stored when it was uploaded.'
                          : 'On this computer, opened in place: saving changes this file (a backup is kept).'}{' '}
                        {f.pinned ? 'Agents can see it (pinned).' : 'Only you see it.'}
                      </span>
                      <div className="flex gap-6 flex-wrap">
                        <Button
                          size="sm"
                          variant="accent"
                          disabled={f.missing}
                          onClick={() => onOpen(f)}
                          data-testid="files-item-open"
                        >
                          Open
                        </Button>
                        {canManage && !f.missing && (
                          <Button
                            size="sm"
                            onClick={() => onPin(f, !f.pinned)}
                            data-testid="files-item-pin"
                          >
                            {f.pinned ? 'Unpin from board' : 'Pin to board'}
                          </Button>
                        )}
                        {canManage &&
                          (f.source === 'upload' && !f.missing ? (
                            <Button
                              size="sm"
                              className="text-danger"
                              onClick={() => setConfirm(f.fileId)}
                              data-testid="files-item-delete"
                            >
                              Delete copy…
                            </Button>
                          ) : (
                            <Button size="sm" variant="ghost" onClick={() => onForget(f)}>
                              Remove from list
                            </Button>
                          ))}
                      </div>
                      {confirm === f.fileId && (
                        <div className="flex flex-col gap-4 p-6 border border-dashed border-danger text-xs">
                          <span>
                            Delete the office&apos;s copy of {f.name}? Your original is not touched.
                          </span>
                          <div className="flex gap-6">
                            <Button
                              size="sm"
                              className="text-danger"
                              onClick={() => {
                                setConfirm(null);
                                onDeleteUpload(f);
                              }}
                              data-testid="files-item-delete-yes"
                            >
                              Delete copy
                            </Button>
                            <Button size="sm" onClick={() => setConfirm(null)}>
                              Keep
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          ))}
      </div>

      <div className="flex flex-col gap-4 px-10 py-6 border-t-2 border-border text-2xs text-text-muted">
        <span>
          ~/.pixel-agents · uploads {formatSize(uploadsBytes)} · backups {formatSize(backupsBytes)}
        </span>
        <span>Opening a file never shows it to agents — Pin to board does.</span>
      </div>
    </aside>
  );
}
