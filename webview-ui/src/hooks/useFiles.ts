import { useCallback, useEffect, useRef, useState } from 'react';

import type { BackupGroup, OfficeFile } from '../../../core/src/messages.js';
import { transport } from '../transport/index.js';

export interface FilesState {
  files: OfficeFile[];
  backups: BackupGroup[];
  uploadsBytes: number;
  backupsBytes: number;
  /** Add a path to Files and get the id the viewer fetches it by (or why not). */
  open: (path: string) => Promise<{ fileId: string; path: string } | { error: string }>;
  forget: (fileId: string) => void;
  setPinned: (fileId: string, pinned: boolean) => void;
  deleteUpload: (fileId: string) => void;
  clearBackups: (key?: string) => void;
}

/** Files — the documents the office opened (server: officeFiles.ts). Own transport listener. */
export function useFiles(): FilesState {
  const [files, setFiles] = useState<OfficeFile[]>([]);
  const [backups, setBackups] = useState<BackupGroup[]>([]);
  const [uploadsBytes, setUploadsBytes] = useState(0);
  const [backupsBytes, setBackupsBytes] = useState(0);
  /** Waiting openers, by the path they asked for (a reply names that path). */
  const waiting = useRef(
    new Map<string, Array<(r: { fileId: string; path: string } | { error: string }) => void>>(),
  );

  useEffect(() => {
    return transport.onMessage((msg) => {
      if (msg.type === 'filesLoaded') {
        setFiles(msg.files);
        setBackups(msg.backups);
        setUploadsBytes(msg.uploadsBytes);
        setBackupsBytes(msg.backupsBytes);
      } else if (msg.type === 'fileOpened') {
        // The reply names the resolved path; the request may have used ~ — answer the oldest waiter.
        const [asked, resolvers] = waiting.current.entries().next().value ?? [];
        if (!asked || !resolvers) return;
        waiting.current.delete(asked);
        const result =
          msg.fileId !== undefined
            ? { fileId: msg.fileId, path: msg.path }
            : { error: msg.error ?? 'Could not open that file.' };
        for (const resolve of resolvers) resolve(result);
      }
    });
  }, []);

  const open = useCallback(
    (path: string) =>
      new Promise<{ fileId: string; path: string } | { error: string }>((resolve) => {
        const list = waiting.current.get(path) ?? [];
        list.push(resolve);
        waiting.current.set(path, list);
        if (list.length === 1) transport.send({ type: 'openOfficeFile', path });
      }),
    [],
  );
  const forget = useCallback((fileId: string) => {
    transport.send({ type: 'forgetOfficeFile', fileId });
  }, []);
  const setPinned = useCallback((fileId: string, pinned: boolean) => {
    transport.send({ type: 'pinOfficeFile', fileId, pinned });
  }, []);
  const deleteUpload = useCallback((fileId: string) => {
    transport.send({ type: 'deleteOfficeUpload', fileId });
  }, []);
  const clearBackups = useCallback((key?: string) => {
    transport.send({ type: 'clearBackups', ...(key ? { key } : {}) });
  }, []);

  return {
    files,
    backups,
    uploadsBytes,
    backupsBytes,
    open,
    forget,
    setPinned,
    deleteUpload,
    clearBackups,
  };
}
