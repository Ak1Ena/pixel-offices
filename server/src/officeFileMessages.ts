import * as crypto from 'crypto';
import * as path from 'path';

import type { AgentRuntime } from './agentRuntime.js';
import { clearBackups } from './backups.js';
import { deleteStoredUpload, isStoredUpload } from './boardFiles.js';
import { expandPath } from './officeFiles.js';

/**
 * Files client messages, shared by both surfaces. Every one is privileged:
 * they name paths on this computer, pin files for agents, or delete data.
 * Returns true when `msg` was one of them.
 */
export function handleOfficeFileMessage(
  msg: Record<string, unknown>,
  send: (message: Record<string, unknown>) => void,
  runtime: AgentRuntime | undefined,
  privileged: boolean,
): boolean {
  const type = msg.type;
  if (
    type !== 'openOfficeFile' &&
    type !== 'forgetOfficeFile' &&
    type !== 'pinOfficeFile' &&
    type !== 'deleteOfficeUpload' &&
    type !== 'clearBackups'
  ) {
    return false;
  }
  const notice = (message: string) => send({ type: 'teamNotice', message, error: true });
  if (!runtime || !privileged) {
    if (type === 'openOfficeFile') {
      send({
        type: 'fileOpened',
        path: typeof msg.path === 'string' ? msg.path : '',
        error: 'Open the office from your private link to open files.',
      });
    }
    return true;
  }
  const files = runtime.files;
  const board = runtime.board;
  /** Whiteboard pins that point at this path. */
  const pinsFor = (filePath: string) =>
    board.getPins().filter((p) => p.kind === 'file' && expandPath(p.value) === filePath);

  switch (type) {
    case 'openOfficeFile': {
      const result = files.open(msg.path);
      const asked = typeof msg.path === 'string' ? msg.path : '';
      send(
        result.ok
          ? { type: 'fileOpened', path: result.path, fileId: result.fileId }
          : { type: 'fileOpened', path: asked, error: result.error },
      );
      break;
    }
    case 'forgetOfficeFile':
      files.forget(msg.fileId);
      break;
    case 'pinOfficeFile': {
      const filePath = files.pathOf(msg.fileId);
      if (!filePath) break;
      if (msg.pinned === true) {
        if (pinsFor(filePath).length > 0) break;
        const ok = board.savePin({
          id: `pin_${crypto.randomUUID().replace(/-/g, '')}`,
          kind: 'file',
          title: path.basename(filePath).replace(/^pin_[A-Za-z0-9]+-/, ''),
          value: filePath,
          scope: [],
          createdAt: new Date().toISOString(),
        });
        if (!ok) notice('The whiteboard is full.');
      } else {
        for (const pin of pinsFor(filePath)) board.removePin(pin.id);
      }
      break;
    }
    case 'deleteOfficeUpload': {
      const filePath = files.pathOf(msg.fileId);
      if (!filePath) break;
      if (!isStoredUpload(filePath)) {
        notice(
          'Only the office’s own uploaded copies can be deleted here. Your files are not touched.',
        );
        break;
      }
      for (const pin of pinsFor(filePath)) board.removePin(pin.id);
      if (!deleteStoredUpload(filePath)) {
        notice('Could not delete that copy.');
        break;
      }
      files.forget(msg.fileId);
      break;
    }
    case 'clearBackups':
      clearBackups(typeof msg.key === 'string' ? msg.key : undefined);
      runtime.publishFiles();
      break;
  }
  return true;
}
