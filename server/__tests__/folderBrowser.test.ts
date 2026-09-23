import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FOLDER_LIST_MAX_ENTRIES } from '../src/constants.js';
import { listFolder } from '../src/folderBrowser.js';

let dir: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-folders-')));
  for (const d of ['beta', 'Alpha', 'gamma', '.hidden', 'node_modules', 'proj-git', 'proj-py']) {
    fs.mkdirSync(path.join(dir, d));
  }
  fs.mkdirSync(path.join(dir, 'proj-git', '.git'));
  fs.writeFileSync(path.join(dir, 'proj-py', 'pyproject.toml'), '');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('listFolder', () => {
  it('with files: also lists the files the viewer opens, never others or dot-files', async () => {
    fs.writeFileSync(path.join(dir, 'Report.docx'), 'ab');
    fs.writeFileSync(path.join(dir, 'deck.pptx'), 'abc');
    fs.writeFileSync(path.join(dir, 'tool.exe'), 'x');
    fs.writeFileSync(path.join(dir, '.secret.txt'), 'x');
    fs.symlinkSync(path.join(dir, 'missing.xlsx'), path.join(dir, 'dangling.xlsx'));
    const res = await listFolder(dir, undefined, { files: true });
    expect(res.files?.map((f) => [f.name, f.size])).toEqual([
      ['deck.pptx', 3],
      ['notes.txt', 1],
      ['Report.docx', 2],
    ]);
    expect(res.entries.map((e) => e.name)).toContain('Alpha');
    expect((await listFolder(dir)).files).toBeUndefined();
  });

  it('lists sub-folders only, sorted case-insensitively, skipping dot-folders and node_modules', async () => {
    const res = await listFolder(dir);
    expect(res.type).toBe('folderListing');
    expect(res.error).toBeUndefined();
    expect(res.path).toBe(dir);
    expect(res.parent).toBe(path.dirname(dir));
    expect(res.entries.map((e) => e.name)).toEqual([
      'Alpha',
      'beta',
      'gamma',
      'proj-git',
      'proj-py',
    ]);
    expect(res.entries[0].path).toBe(path.join(dir, 'Alpha'));
  });

  it('marks project folders', async () => {
    const res = await listFolder(dir);
    const byName = Object.fromEntries(res.entries.map((e) => [e.name, e.isProject === true]));
    expect(byName).toMatchObject({ 'proj-git': true, 'proj-py': true, beta: false });
  });

  it('defaults to home and expands ~', async () => {
    expect((await listFolder(undefined, dir)).path).toBe(dir);
    const res = await listFolder('~/beta', dir);
    expect(res.path).toBe(path.join(dir, 'beta'));
    expect(res.home).toBe(dir);
  });

  it('follows symlinks to folders', async () => {
    fs.symlinkSync(path.join(dir, 'beta'), path.join(dir, 'link'));
    const res = await listFolder(dir);
    expect(res.entries.map((e) => e.name)).toContain('link');
    expect((await listFolder(path.join(dir, 'link'))).path).toBe(path.join(dir, 'beta'));
  });

  it('reports errors instead of throwing', async () => {
    expect((await listFolder('relative/path')).error).toMatch(/absolute/);
    expect((await listFolder(path.join(dir, 'missing'))).error).toBe('Folder not found.');
    const file = await listFolder(path.join(dir, 'notes.txt'));
    expect(file.error).toBe('Not a folder.');
    expect(file.entries).toEqual([]);
  });

  it('caps the number of entries', async () => {
    for (let i = 0; i < FOLDER_LIST_MAX_ENTRIES + 5; i++) {
      fs.mkdirSync(path.join(dir, 'gamma', `d${String(i).padStart(4, '0')}`));
    }
    const res = await listFolder(path.join(dir, 'gamma'));
    expect(res.entries).toHaveLength(FOLDER_LIST_MAX_ENTRIES);
  });
});
