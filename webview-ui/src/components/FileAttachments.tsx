import { useContext, useEffect, useRef, useState } from 'react';

import { OpenFileContext, splitFilePaths } from '../fileLinks.js';
import {
  canSendChatFiles,
  chatImageUrl,
  isImageFile,
  splitUploadMentions,
  uploadDisplayName,
} from '../fileUpload.js';
import type { FileAttachments } from '../hooks/useFileAttachments.js';
import { Button } from './ui/Button.js';

/** Pending files as removable chips, plus an inline upload error. */
export function FileChips({ attachments }: { attachments: FileAttachments }) {
  const { files, error, remove } = attachments;
  if (files.length === 0 && !error) return null;
  return (
    <>
      {files.length > 0 && (
        <div className="flex flex-wrap gap-4">
          {files.map((file, i) => (
            <span
              key={`${file.name}-${i}`}
              className="flex items-center gap-4 px-4 border border-border bg-bg text-2xs max-w-full"
              data-testid="chat-attached-file"
            >
              <FileThumb file={file} />
              <span className="overflow-hidden text-ellipsis whitespace-nowrap">{file.name}</span>
              <button
                className="bg-transparent border-0 p-0 text-text-muted cursor-pointer"
                aria-label={`Remove ${file.name}`}
                onClick={() => remove(i)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {error && (
        <div className="text-2xs text-danger" data-testid="chat-file-error">
          {error}
        </div>
      )}
    </>
  );
}

/** A small preview for an image about to be sent; a FILE tag otherwise. */
function FileThumb({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!isImageFile(file)) return;
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  if (!url) return <span className="text-text-muted">FILE</span>;
  return <img src={url} alt="" className="w-24 h-24 object-cover" data-testid="chat-file-thumb" />;
}

/** One uploaded image, fetched with the page token; click opens it full size. */
function ChatImage({ name }: { name: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    void chatImageUrl(name).then((result) => {
      if (!live) return;
      if (result) setUrl(result);
      else setFailed(true);
    });
    return () => {
      live = false;
    };
  }, [name]);
  if (failed) return <span className="text-2xs text-text-muted">[image: {name}]</span>;
  if (!url) return <span className="text-2xs text-text-muted">loading image…</span>;
  return (
    <button
      className="bg-transparent border-0 p-0 cursor-zoom-in"
      title="Open full size"
      onClick={() => window.open(url, '_blank', 'noopener')}
    >
      <img
        src={url}
        alt={name}
        className="block max-w-full max-h-160 object-contain"
        data-testid="chat-image"
      />
    </button>
  );
}

/** A file sent from the chat that isn't an image: its name, as a card. */
function ChatFileCard({ name }: { name: string }) {
  const shown = uploadDisplayName(name);
  const ext = shown.includes('.') ? shown.split('.').pop()!.toUpperCase() : 'FILE';
  return (
    <span
      className="inline-flex items-center gap-6 self-start max-w-full px-6 py-4 bg-bg-dark border-2 border-border text-sm"
      title={shown}
      data-testid="chat-file-card"
    >
      <span className="shrink-0 px-4 border-2 border-border text-2xs font-pixel">
        {ext.slice(0, 5)}
      </span>
      <span className="overflow-hidden text-ellipsis whitespace-nowrap">{shown}</span>
    </span>
  );
}

/**
 * A chat message's text with the files uploaded from the chat shown instead
 * of their `@path`: images inline, other files as cards. Plain text where
 * uploads can't be fetched (VS Code panel, untokened page).
 */
export function MessageText({ text }: { text: string }) {
  if (!canSendChatFiles()) return <>{text}</>;
  const { images, files, text: rest } = splitUploadMentions(text);
  if (images.length === 0 && files.length === 0) return <LinkedText text={text} />;
  return (
    <span className="flex flex-col gap-4">
      {images.map((name, i) => (
        <ChatImage key={`${name}-${i}`} name={name} />
      ))}
      {files.map((name, i) => (
        <ChatFileCard key={`${name}-${i}`} name={name} />
      ))}
      {rest && (
        <span>
          <LinkedText text={rest} />
        </span>
      )}
    </span>
  );
}

/** A path the viewer can open, as a link; plain text where files can't be viewed. */
export function FileLink({ path, text }: { path: string; text?: string }) {
  const open = useContext(OpenFileContext);
  if (!open) return <>{text ?? path}</>;
  return (
    <button
      type="button"
      className="inline bg-transparent border-0 p-0 [font:inherit] text-accent-bright underline cursor-pointer break-all text-left"
      title={`Open ${path}`}
      onClick={(e) => {
        // Inside an edit card's <summary>: open the file, don't fold the card.
        e.preventDefault();
        e.stopPropagation();
        open(path);
      }}
      data-testid="chat-file-link"
    >
      {text ?? path}
    </button>
  );
}

/** Text with its absolute and ~ file paths as links. */
export function LinkedText({ text }: { text: string }) {
  return (
    <>
      {splitFilePaths(text).map((part, i) =>
        part.kind === 'file' ? (
          <FileLink key={i} path={part.path} text={part.text} />
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

/** "File" button that opens the system file picker (several files at once). */
export function AttachFileButton({ attachments }: { attachments: FileAttachments }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          attachments.add(e.target.files);
          e.target.value = '';
        }}
        data-testid="chat-file-input"
      />
      <Button
        size="md"
        disabled={attachments.uploading}
        onClick={() => inputRef.current?.click()}
        title="Send files to the agent (it gets their paths)"
        data-testid="chat-attach-file"
      >
        File
      </Button>
    </>
  );
}
