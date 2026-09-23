import { useCallback, useEffect, useRef, useState } from 'react';

import type { FolderListing } from '../../../core/src/messages.js';
import { OPEN_FILE_Z_INDEX } from '../constants.js';
import { fileBaseName, fileExtension } from '../docViewer.js';
import { formatSize, isOpenable, loadRecent, saveRecent, withRecent } from '../openFile.js';
import { transport } from '../transport/index.js';
import { Button } from './ui/Button.js';
import { Modal } from './ui/Modal.js';

interface OpenFileDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** Open a file on this computer by its path (the office pins it for you). */
  onOpenPath: (path: string) => void;
  /** Upload a file and open the copy; resolves with an error to show, or null. */
  onUpload: (file: File) => Promise<string | null>;
}

const fieldClass =
  'flex-1 min-w-0 px-8 py-4 bg-bg-dark text-text text-sm border-2 border-border rounded-none outline-none focus:border-accent';

/**
 * Open file: Word, PowerPoint, Excel, PDF, text and images, straight into the
 * document viewer. Files on this computer are browsed through the server
 * (`listFolder` with files, privileged) and opened in place — edits save to
 * the real file. An upload opens a copy the office keeps.
 */
export function OpenFileDialog({ isOpen, onClose, onOpenPath, onUpload }: OpenFileDialogProps) {
  const [tab, setTab] = useState<'computer' | 'upload'>('computer');
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [typed, setTyped] = useState('');
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const browse = useCallback((path?: string) => {
    setLoading(true);
    transport.send({ type: 'listFolder', path: path || undefined, files: true });
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const off = transport.onMessage((msg) => {
      if (msg.type !== 'folderListing') return;
      setLoading(false);
      setListing(msg);
    });
    // Start where the newest recent file lives, else home.
    const last = loadRecent()[0];
    browse(last ? last.replace(/[\\/][^\\/]*$/, '') : undefined);
    return off;
  }, [isOpen, browse]);

  const open = (path: string) => {
    const next = withRecent(recent, path);
    setRecent(next);
    saveRecent(next);
    onOpenPath(path);
    onClose();
  };

  const submitTyped = () => {
    const path = typed.trim();
    if (!path) return;
    if (isOpenable(path)) open(path);
    else browse(path);
  };

  const upload = async (files: File[]) => {
    const file = files[0];
    if (!file || uploading) return;
    setUploading(true);
    setUploadError(null);
    const error = await onUpload(file);
    setUploading(false);
    if (error) setUploadError(error);
    else onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Open file"
      zIndex={OPEN_FILE_Z_INDEX}
      className="w-[min(560px,calc(100vw-32px))]"
    >
      <div
        className="flex flex-col gap-8 p-8"
        data-testid="open-file"
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div role="tablist" className="flex border-b-2 border-border text-sm">
          {(
            [
              ['computer', 'This computer'],
              ['upload', 'Upload'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`px-12 py-4 border-0 border-b-4 rounded-none cursor-pointer ${
                tab === id
                  ? 'bg-bg text-text border-accent'
                  : 'bg-transparent text-text-muted border-transparent'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'computer' && (
          <>
            {recent.length > 0 && (
              <div className="flex flex-col gap-4">
                <span className="text-2xs text-text-muted">Recent</span>
                <div className="flex flex-wrap gap-4">
                  {recent.map((p) => (
                    <Button key={p} size="sm" title={p} onClick={() => open(p)}>
                      {fileBaseName(p)}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            <div className="flex gap-4 items-center">
              <Button
                size="sm"
                disabled={!listing?.parent}
                variant={listing?.parent ? 'default' : 'disabled'}
                onClick={() => browse(listing?.parent)}
              >
                Up
              </Button>
              <Button size="sm" onClick={() => browse()}>
                Home
              </Button>
              <span
                className="flex-1 min-w-0 truncate text-2xs text-text-muted"
                title={listing?.path}
              >
                {loading ? 'Loading…' : listing?.path}
              </span>
            </div>

            <div
              className="h-260 overflow-y-auto bg-bg-dark border-2 border-border flex flex-col"
              data-testid="open-file-list"
            >
              {listing?.error ? (
                <span className="px-8 py-4 text-sm text-danger">{listing.error}</span>
              ) : (
                <>
                  {listing?.entries.map((entry) => (
                    <button
                      key={entry.path}
                      className="flex items-center gap-6 px-8 py-2 text-left text-sm bg-transparent border-0 rounded-none cursor-pointer hover:bg-btn-hover"
                      onClick={() => browse(entry.path)}
                      title={entry.path}
                    >
                      <span className="text-text-muted">{'>'}</span>
                      <span className="flex-1 min-w-0 truncate">{entry.name}</span>
                    </button>
                  ))}
                  {listing?.files?.map((file) => (
                    <button
                      key={file.path}
                      className="flex items-center gap-6 px-8 py-2 text-left text-sm bg-transparent border-0 rounded-none cursor-pointer hover:bg-btn-hover"
                      onClick={() => open(file.path)}
                      title={file.path}
                      data-testid="open-file-item"
                    >
                      <span className="w-40 shrink-0 text-2xs uppercase text-accent-bright">
                        {fileExtension(file.name)}
                      </span>
                      <span className="flex-1 min-w-0 truncate">{file.name}</span>
                      <span className="text-2xs text-text-muted">{formatSize(file.size)}</span>
                    </button>
                  ))}
                  {listing &&
                    listing.entries.length === 0 &&
                    (listing.files?.length ?? 0) === 0 && (
                      <span className="px-8 py-4 text-sm text-text-muted">
                        No folders or documents here.
                      </span>
                    )}
                </>
              )}
            </div>

            <form
              className="flex gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                submitTyped();
              }}
            >
              <input
                className={fieldClass}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder="Paste a path: ~/Documents/report.docx"
                aria-label="File or folder path"
                data-testid="open-file-path"
              />
              <Button size="sm" type="submit">
                {isOpenable(typed) ? 'Open' : 'Go'}
              </Button>
            </form>
            <span className="text-2xs text-text-muted">
              Opens the file where it is: edits you save change that file (a backup is kept).
            </span>
          </>
        )}

        {tab === 'upload' && (
          <div
            className={`flex flex-col items-center gap-8 p-16 border-2 border-dashed ${
              dragOver ? 'border-accent bg-active-bg' : 'border-border'
            }`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              void upload(Array.from(e.dataTransfer.files));
            }}
          >
            <span className="text-sm">Drop a file here, or</span>
            <Button
              variant="accent"
              size="sm"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploading ? 'Uploading…' : 'Choose a file'}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept=".docx,.pptx,.xlsx,.csv,.pdf,.txt,.md,.json,.log,.png,.jpg,.jpeg,.gif,.webp"
              onChange={(e) => {
                void upload(Array.from(e.target.files ?? []));
                e.target.value = '';
              }}
            />
            {uploadError && <span className="text-sm text-danger">{uploadError}</span>}
            <span className="text-2xs text-text-muted text-center">
              The office keeps a copy in ~/.pixel-agents/files and opens that — edits change the
              copy, not your original. Use This computer to edit a file in place.
            </span>
          </div>
        )}
      </div>
    </Modal>
  );
}
