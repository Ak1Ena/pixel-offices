import { CHAT_FILE_ID_PREFIX, CHAT_IMAGE_EXTENSIONS, CHAT_UPLOAD_DIR_SUFFIX } from './constants.js';

/**
 * Pure helpers for files sent from the chat (no DOM, so the Node test runner
 * can load them). Uploading lives in fileUpload.ts.
 */

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
 * A pasted screenshot is always called "image.png", so it gets a name that
 * tells pastes apart; a copied file keeps its own.
 */
export function pastedFileName(name: string, type: string, now: number, index: number): string {
  if (name && name !== 'image.png') return name;
  const ext = type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `pasted-${stamp}${index ? `-${index}` : ''}.${ext}`;
}
