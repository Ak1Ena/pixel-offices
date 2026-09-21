import { useCallback, useState } from 'react';

import { CHAT_FILE_MAX_COUNT } from '../constants.js';
import { uploadChatFiles } from '../fileUpload.js';

export interface FileAttachments {
  files: File[];
  error: string | null;
  uploading: boolean;
  add: (incoming: FileList | File[] | null | undefined) => void;
  remove: (index: number) => void;
  /** Upload everything attached; resolves with the stored paths, or null on failure (error set). */
  upload: () => Promise<string[] | null>;
}

/** Files waiting to go out with the next chat message. */
export function useFileAttachments(): FileAttachments {
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const add = useCallback((incoming: FileList | File[] | null | undefined) => {
    const list = incoming ? Array.from(incoming) : [];
    if (list.length === 0) return;
    setError(null);
    setFiles((prev) => {
      const next = [...prev, ...list];
      if (next.length > CHAT_FILE_MAX_COUNT) {
        setError(`Up to ${CHAT_FILE_MAX_COUNT} files per message.`);
        return next.slice(0, CHAT_FILE_MAX_COUNT);
      }
      return next;
    });
  }, []);

  const remove = useCallback((index: number) => {
    setError(null);
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const upload = useCallback(async () => {
    if (files.length === 0) return [];
    setUploading(true);
    setError(null);
    const result = await uploadChatFiles(files);
    setUploading(false);
    if (!result.ok) {
      setError(result.error);
      return null;
    }
    setFiles([]);
    return result.paths;
  }, [files]);

  return { files, error, uploading, add, remove, upload };
}
