import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { Proposals } from '../src/proposals.js';
import { parseProposeArgs } from '../src/proposeCli.js';

const ORIGINAL = [
  '# App',
  '',
  'npm install -g pixel-agents',
  'a',
  'b',
  'c',
  'd',
  'e',
  'f',
  'Node 18 or newer.',
  '',
].join('\n');
const PROPOSED = [
  '# App',
  '',
  'npx @ak1ena/pixel-office',
  'a',
  'b',
  'c',
  'd',
  'e',
  'f',
  'Node 20 or newer.',
  '',
].join('\n');

describe('review changes', () => {
  let dir: string;
  let file: string;
  let proposed: string;
  let store: AgentStateStore;
  let delivered: Array<[number, string]>;
  let proposals: Proposals;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prop-'));
    file = path.join(dir, 'README.md');
    proposed = path.join(dir, 'README.new.md');
    fs.writeFileSync(file, ORIGINAL);
    fs.writeFileSync(proposed, PROPOSED);
    store = new AgentStateStore();
    delivered = [];
    proposals = new Proposals(store, (id, t) => delivered.push([id, t]), path.join(dir, 'backups'));
  });
  afterEach(() => {
    proposals.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('splits the suggestion into hunks and writes nothing yet', () => {
    const r = proposals.open({ path: file, from: proposed });
    expect(r.ok && r.proposal.hunks.length).toBe(2);
    expect(fs.readFileSync(file, 'utf-8')).toBe(ORIGINAL);
  });

  it('writes only the accepted change, keeps a backup, and can undo', async () => {
    const r = proposals.open({ path: file, from: proposed, why: 'v1.5' });
    if (!r.ok) throw new Error(r.error);
    const [first, second] = r.proposal.hunks;
    const poll = proposals.wait(r.proposal.proposalId, 5_000);
    proposals.decide(r.proposal.proposalId, first.hunkId, 'accepted');
    proposals.decide(r.proposal.proposalId, second.hunkId, 'rejected', 'keep 18');
    const applied = proposals.apply(r.proposal.proposalId);
    expect(applied.ok).toBe(true);
    const written = fs.readFileSync(file, 'utf-8');
    expect(written).toContain('npx @ak1ena/pixel-office');
    expect(written).toContain('Node 18 or newer.');
    const result = await poll;
    expect(result.state).toBe('applied');
    expect(result.state === 'applied' && result.summary).toContain('"keep 18"');
    expect(proposals.undo(r.proposal.proposalId).ok).toBe(true);
    expect(fs.readFileSync(file, 'utf-8')).toBe(ORIGINAL);
  });

  it('refuses to apply over a file that changed, and shows the changes again', () => {
    const r = proposals.open({ path: file, from: proposed });
    if (!r.ok) throw new Error(r.error);
    proposals.decide(r.proposal.proposalId, '*', 'accepted');
    fs.writeFileSync(file, ORIGINAL.replace('# App', '# App!'));
    const applied = proposals.apply(r.proposal.proposalId);
    expect(applied.ok).toBe(false);
    const again = proposals.snapshot().proposals[0];
    expect(again.hunks.every((h) => h.decision === 'pending')).toBe(true);
    expect(fs.readFileSync(file, 'utf-8')).toContain('# App!');
  });

  it('tells a waiting-free agent what happened', () => {
    store.set(3, { id: 3, cwd: dir, activeToolIds: new Set(['t']) } as never);
    const r = proposals.open({ path: file, from: proposed, cwd: dir });
    if (!r.ok) throw new Error(r.error);
    proposals.discard(r.proposal.proposalId);
    expect(delivered[0][0]).toBe(3);
    expect(delivered[0][1]).toContain('discarded');
  });

  it('refuses binary formats and identical versions', () => {
    fs.writeFileSync(path.join(dir, 'a.docx'), 'x');
    expect(proposals.open({ path: path.join(dir, 'a.docx'), from: proposed }).ok).toBe(false);
    expect(proposals.open({ path: file, from: file }).ok).toBe(false);
  });

  it('parses the CLI', () => {
    expect(parseProposeArgs(['README.md', '--from', '/tmp/x.md', '--wait'])).toMatchObject({
      path: 'README.md',
      from: '/tmp/x.md',
      wait: true,
    });
    expect(() => parseProposeArgs(['README.md'])).toThrow();
  });
});
