import {
  CHAT_FILE_API,
  CHAT_FILE_ID_PREFIX,
  CHAT_IMAGE_EXTENSIONS,
  CHAT_UPLOAD_DIR_SUFFIX,
  DOC_UPLOAD_MAX_BYTES,
} from './constants.js';
import { isBrowserRuntime } from './runtime.js';

/**
 * Sending files to agents from the office chat (standalone only). A file is
 * uploaded to the office server, stored under ~/.pixel-agents/files, and the
 * message names it as `@<path>` so Claude reads it. The VS Code panel has no
 * HTTP route to call, and an untokened page may not upload, so both hide it.
 */

function pageToken(): string | null {
  try {
    return new URLSearchParams(window.location.search).get('token');
  } catch {
    return null;
  }
}

/** Whether this page can send files to agents. */
export function canSendChatFiles(): boolean {
  return isBrowserRuntime && !!pageToken();
}

export type ChatFileUpload = { ok: true; path: string } | { ok: false; error: string };

/** Upload one file for an agent; resolves with its stored path or why not. */
export async function uploadChatFile(file: File): Promise<ChatFileUpload> {
  if (file.size === 0) return { ok: false, error: `${file.name} is empty.` };
  if (file.size > DOC_UPLOAD_MAX_BYTES) {
    return { ok: false, error: `${file.name} is too large (limit 25 MB).` };
  }
  const token = pageToken();
  if (!token) return { ok: false, error: 'Open the office from your private link to send files.' };
  try {
    const res = await fetch(`${CHAT_FILE_API}?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    const body = (await res.json().catch(() => null)) as { path?: string; error?: string } | null;
    if (res.ok && body?.path) return { ok: true, path: body.path };
    return { ok: false, error: `${file.name}: ${body?.error ?? `upload failed (${res.status})`}` };
  } catch {
    return { ok: false, error: 'Upload failed. Is the office still running?' };
  }
}

/** Upload every file, stopping at the first failure. */
export async function uploadChatFiles(
  files: File[],
): Promise<{ ok: true; paths: string[] } | { ok: false; error: string }> {
  const paths: string[] = [];
  for (const file of files) {
    const result = await uploadChatFile(file);
    if (!result.ok) return result;
    paths.push(result.path);
  }
  return { ok: true, paths };
}

/** The message text with the uploaded files named first: `@<path> @<path2>\n<text>`. */
export function withFileMentions(paths: string[], text: string): string {
  if (paths.length === 0) return text;
  const mentions = paths.map((p) => `@${p}`).join(' ');
  return text.trim() ? `${mentions}\n${text}` : mentions;
}

/** Whether a drag carries files from the operating system. */
export function dragHasFiles(e: { dataTransfer: DataTransfer | null }): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
}

/** Whether a local file is an image the chat can preview. */
export function isImageFile(file: File): boolean {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return (CHAT_IMAGE_EXTENSIONS as readonly string[]).includes(ext);
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const UPLOADED_MENTION = new RegExp(
  `@\\S*[\\\\/]${CHAT_UPLOAD_DIR_SUFFIX.split('/').map(escapeRegExp).join('[\\\\/]')}` +
    `[\\\\/](${CHAT_FILE_ID_PREFIX}[A-Za-z0-9]+-[A-Za-z0-9._-]+)(?=\\s|$)`,
  'gi',
);
const STORED_ID_RE = new RegExp(`^${CHAT_FILE_ID_PREFIX}[A-Za-z0-9]+-`, 'i');

/** Whether a stored upload name is an image the chat can preview. */
function isImageName(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return (CHAT_IMAGE_EXTENSIONS as readonly string[]).includes(ext);
}

/** The name the user picked, without the store's `chat_<id>-` prefix. */
export function uploadDisplayName(stored: string): string {
  return stored.replace(STORED_ID_RE, '');
}

/**
 * Pull `@<path>` mentions of files uploaded from the chat out of a message:
 * the stored names of images (to show inline) and of other files (to show as
 * file cards), and the text that is left.
 */
export function splitUploadMentions(text: string): {
  images: string[];
  files: string[];
  text: string;
} {
  const images: string[] = [];
  const files: string[] = [];
  const rest = text.replace(UPLOADED_MENTION, (_m, name: string) => {
    (isImageName(name) ? images : files).push(name);
    return '';
  });
  if (images.length === 0 && files.length === 0) return { images, files, text };
  return {
    images,
    files,
    text: rest
      .replace(/^[ \t]*\n/, '')
      .replace(/[ \t]{2,}/g, ' ')
      .trim(),
  };
}

/**
 * Files on the clipboard (a copied file, or a screenshot). A pasted screenshot
 * is always called "image.png", so it gets a name that tells pastes apart.
 */
export function pastedFiles(data: DataTransfer | null, now = Date.now()): File[] {
  if (!data) return [];
  return Array.from(data.files).map((file, i) => {
    if (file.name && file.name !== 'image.png') return file;
    const ext = file.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return new File([file], `pasted-${stamp}${i ? `-${i}` : ''}.${ext}`, { type: file.type });
  });
}

const imageUrls = new Map<string, Promise<string | null>>();

/** A blob URL for an uploaded image (fetched once with the page token), or null. */
export function chatImageUrl(name: string): Promise<string | null> {
  let url = imageUrls.get(name);
  if (!url) {
    const token = pageToken();
    url = !token
      ? Promise.resolve(null)
      : fetch(`${CHAT_FILE_API}/${encodeURIComponent(name)}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
          .then(async (res) => (res.ok ? URL.createObjectURL(await res.blob()) : null))
          .catch(() => null)
          .then((result) => {
            if (!result) imageUrls.delete(name); // let a later render try again
            return result;
          });
    imageUrls.set(name, url);
  }
  return url;
}
