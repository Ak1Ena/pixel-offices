import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TASK_MAX_SUBTASKS, TASK_TITLE_MAX_CHARS } from '../src/constants.js';
import { briefFromInput, sanitizeTask, TaskStore } from '../src/taskStore.js';

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-tasks-')));
  file = path.join(dir, 'tasks.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const folder = { root: '/work/repo', name: 'repo', isGit: true, branch: 'main' };
const input = { kind: 'issue', title: '  Broken thing  ', body: 'b', priority: 'p1', folder };

describe('TaskStore', () => {
  it('numbers cards, persists them, and never reuses a number', () => {
    const store = new TaskStore(() => {}, file);
    const a = store.create(input)!;
    const b = store.create(input)!;
    expect([a.num, b.num, a.title, a.state]).toEqual([1, 2, 'Broken thing', 'inbox']);
    store.remove(b.id);
    expect(store.create(input)!.num).toBe(3);
    store.dispose();

    const reopened = new TaskStore(() => {}, file);
    expect(reopened.getTasks().map((t) => t.num)).toEqual([1, 3]);
    expect(reopened.find('#3')?.num).toBe(3);
    expect(reopened.find(a.id)?.num).toBe(1);
    expect(fs.readFileSync(path.join(dir, 'tasks.md'), 'utf-8')).toContain('#1 Broken thing');
    reopened.dispose();
  });

  it('rejects malformed cards and drops junk from the file instead of loading it', () => {
    const store = new TaskStore(() => {}, file);
    expect(store.create({ ...input, title: '   ' })).toBeNull();
    expect(store.create({ ...input, kind: 'epic' })).toBeNull();
    expect(store.create({ ...input, folder: { ...folder, root: 'relative/path' } })).toBeNull();
    const good = store.create(input)!;
    store.dispose();

    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    data.tasks.push({ id: 'x', state: 'weird' }, null, { ...data.tasks[0] });
    fs.writeFileSync(file, JSON.stringify(data));
    const reopened = new TaskStore(() => {}, file);
    expect(reopened.getTasks().map((t) => t.id)).toEqual([good.id]);
    reopened.dispose();
  });

  it('picks up a change written by another window', () => {
    let changes = 0;
    const store = new TaskStore(() => changes++, file);
    const task = store.create(input)!;
    expect(changes).toBe(1);
    expect(store.replace({ ...task, state: 'done' })).toBe(true);
    expect(store.replace({ ...task, id: 't_unknown' })).toBe(false);
    expect(store.find(task.id)?.state).toBe('done');
    store.dispose();
  });
});

describe('sanitizers', () => {
  it('bounds text, strips control characters, and keeps unknown fields out', () => {
    const task = sanitizeTask({
      id: 't_1',
      num: 1,
      kind: 'task',
      priority: 'p2',
      state: 'inbox',
      folder,
      title: 'a\u0007b' + 'x'.repeat(500),
      body: 'line1\nline2\u001b[31m',
      allow: [1, 1, 'x', 2.5, 3],
      claimedBy: 'nope',
      evil: true,
      briefs: [{ understanding: 'u', subtasks: Array(50).fill('s') }],
      log: [{ kind: 'nope', text: 't' }],
    })!;
    expect(task.title.startsWith('ab')).toBe(true);
    expect(task.title).toHaveLength(TASK_TITLE_MAX_CHARS);
    expect(task.body).toBe('line1\nline2[31m');
    expect(task.allow).toEqual([1, 3]);
    expect(task.briefs[0].subtasks).toHaveLength(TASK_MAX_SUBTASKS);
    expect(task.log).toEqual([]);
    expect('claimedBy' in task || 'evil' in task).toBe(false);
  });

  it("an agent's brief must say what it understood and list steps; it can't forge authorship", () => {
    expect(briefFromInput({ subtasks: ['a'] }, 'Mina').ok).toBe(false);
    expect(briefFromInput({ understanding: 'u' }, 'Mina').ok).toBe(false);
    const r = briefFromInput(
      {
        understanding: 'u',
        by: 'You',
        subtasks: [{ title: 'a', done: true, skip: true, by: 'you' }],
      },
      'Mina',
    );
    expect(r.ok && r.brief).toMatchObject({
      by: 'Mina',
      subtasks: [{ title: 'a', done: false, skip: false, by: 'agent' }],
    });
  });
});
