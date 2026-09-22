import { useEffect, useMemo, useState } from 'react';

import type { TeamMember, TeamPreset, TeamRun, Workflow } from '../../../core/src/messages.js';
import { downloadText } from '../download.js';
import type { TeamsState } from '../hooks/useTeams.js';
import { getLoadedCharacterCount } from '../office/sprites/spriteData.js';
import type { TeamBundle } from '../teams.js';
import { encodeShareCode, exportBundle, fileSlug, readBundle } from '../teams.js';
import { CharacterPortrait } from './CharacterPortrait.js';
import { Button } from './ui/Button.js';

interface TeamsPanelProps {
  teams: TeamsState;
  workflows: Workflow[];
  labelOf: (agentId: number) => string;
  /** Folders to offer when starting a team (recent + workspace). */
  folders: string[];
  /** Absent when this connection may not change anything. */
  canEdit: boolean;
  /** Only the standalone office can start agents. */
  canStart: boolean;
  onOpenAgent: (agentId: number) => void;
  onClose: () => void;
}

type View =
  | { kind: 'library' }
  | { kind: 'edit'; team: TeamPreset; draftWorkflows?: Workflow[] }
  | { kind: 'start'; team: TeamPreset }
  | { kind: 'export'; team: TeamPreset }
  | { kind: 'import' }
  | { kind: 'ai' };

const EMPTY_MEMBER: TeamMember = { name: '', role: '', instructions: '', command: '' };

function newRequestId(): string {
  return `r${Math.random().toString(36).slice(2, 10)}`;
}

function Crew({ members }: { members: Array<{ palette?: number; name: string }> }) {
  return (
    <div className="flex gap-4 items-end min-h-52 px-8 py-4 bg-bg-thumb border-2 border-border overflow-hidden">
      {members.map((m, i) => (
        <CharacterPortrait key={i} palette={m.palette ?? i} title={m.name} />
      ))}
    </div>
  );
}

function MemberEditor({
  member,
  index,
  workflows,
  onChange,
  onRemove,
  onMakeLead,
}: {
  member: TeamMember;
  index: number;
  workflows: Workflow[];
  onChange: (patch: Partial<TeamMember>) => void;
  onRemove: () => void;
  onMakeLead: () => void;
}) {
  const [open, setOpen] = useState(index === 0);
  const looks = Math.max(1, getLoadedCharacterCount());
  return (
    <div
      className={`flex flex-col gap-6 p-8 border-2 ${open ? 'bg-active-bg border-accent' : 'bg-bg-thumb border-border'}`}
      data-testid="team-member"
    >
      <div className="flex items-center gap-8">
        <CharacterPortrait palette={member.palette ?? index} />
        <button
          className="flex-1 min-w-0 text-left bg-transparent border-0 text-text cursor-pointer"
          onClick={() => setOpen((v) => !v)}
        >
          <span className="text-sm">{member.name || 'New member'}</span>
          {member.lead && (
            <span className="ml-6 px-4 text-2xs border-2 border-pin-note text-pin-note">
              ★ lead
            </span>
          )}
          <span className="block text-2xs text-text-muted font-mono overflow-hidden text-ellipsis whitespace-nowrap">
            {member.command || 'claude'} · {member.role || 'no role yet'}
          </span>
        </button>
        {!member.lead && (
          <Button size="sm" variant="ghost" onClick={onMakeLead} title="Make this member the lead">
            ★
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onRemove} aria-label="Remove member">
          ✕
        </Button>
      </div>
      {open && (
        <div className="grid grid-cols-2 max-sm:grid-cols-1 gap-6">
          <label className="flex flex-col gap-2 text-2xs text-text-muted">
            Name (how teammates @mention it)
            <input
              value={member.name}
              onChange={(e) => onChange({ name: e.target.value.replace(/\s+/g, '-') })}
              className="bg-bg-dark border-2 border-border px-6 py-2 text-sm text-text"
            />
          </label>
          <label className="flex flex-col gap-2 text-2xs text-text-muted">
            Role
            <input
              value={member.role}
              onChange={(e) => onChange({ role: e.target.value })}
              className="bg-bg-dark border-2 border-border px-6 py-2 text-sm text-text"
            />
          </label>
          <label className="col-span-2 max-sm:col-span-1 flex flex-col gap-2 text-2xs text-text-muted">
            Instructions (what it does and who it hands work to)
            <textarea
              value={member.instructions}
              onChange={(e) => onChange({ instructions: e.target.value })}
              rows={3}
              className="bg-bg-dark border-2 border-border px-6 py-2 text-sm text-text font-reading resize-y"
            />
          </label>
          <label className="flex flex-col gap-2 text-2xs text-text-muted">
            Start command
            <input
              value={member.command}
              onChange={(e) => onChange({ command: e.target.value })}
              placeholder="claude --model claude-sonnet-5"
              className="bg-bg-dark border-2 border-border px-6 py-2 text-xs text-text font-mono"
            />
          </label>
          <label className="flex flex-col gap-2 text-2xs text-text-muted">
            Workflow
            <select
              value={member.workflowId ?? ''}
              onChange={(e) => onChange({ workflowId: e.target.value || undefined })}
              className="bg-bg-dark border-2 border-border px-6 py-2 text-sm text-text"
            >
              <option value="">None</option>
              {workflows.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.title}
                </option>
              ))}
            </select>
          </label>
          <div className="col-span-2 max-sm:col-span-1 flex flex-col gap-2 text-2xs text-text-muted">
            Look
            <div className="flex gap-4 flex-wrap">
              {Array.from({ length: looks }, (_, p) => (
                <button
                  key={p}
                  onClick={() => onChange({ palette: p })}
                  className={`p-2 border-2 cursor-pointer bg-bg-dark ${member.palette === p ? 'border-white' : 'border-transparent'}`}
                  aria-label={`Look ${p + 1}`}
                >
                  <CharacterPortrait palette={p} zoom={1} />
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TeamEditor({
  initial,
  draftWorkflows,
  workflows,
  onSave,
  onCancel,
  onDelete,
}: {
  initial: TeamPreset;
  draftWorkflows?: Workflow[];
  workflows: Workflow[];
  onSave: (team: TeamPreset) => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const [team, setTeam] = useState<TeamPreset>(() => ({
    ...initial,
    members:
      initial.members.length > 0
        ? initial.members
        : [{ ...EMPTY_MEMBER, name: 'lead', role: 'Lead', lead: true }],
  }));
  const pickable = [...(draftWorkflows ?? []), ...workflows];
  const setMember = (i: number, patch: Partial<TeamMember>) =>
    setTeam((t) => ({
      ...t,
      members: t.members.map((m, j) => (j === i ? { ...m, ...patch } : m)),
    }));
  const valid = team.title.trim() !== '' && team.members.some((m) => m.name.trim());
  const lead = team.members.find((m) => m.lead) ?? team.members[0];
  const others = team.members.filter((m) => m !== lead);

  return (
    <div className="flex-1 min-h-0 flex max-md:flex-col" data-testid="team-editor">
      <div className="flex-1 min-w-0 overflow-y-auto p-16 flex flex-col gap-10">
        <div className="flex items-center gap-8">
          <input
            autoFocus
            value={team.title}
            onChange={(e) => setTeam((t) => ({ ...t, title: e.target.value }))}
            placeholder="Team name"
            className="flex-1 min-w-0 bg-transparent border-0 border-b-2 border-dashed border-border text-xl text-text px-2"
          />
          {onDelete && (
            <Button size="sm" onClick={onDelete}>
              Delete
            </Button>
          )}
          <Button size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant={valid ? 'accent' : 'disabled'}
            disabled={!valid}
            onClick={() => onSave({ ...team, members: team.members.filter((m) => m.name.trim()) })}
            data-testid="team-save"
          >
            Save team
          </Button>
        </div>
        <label className="flex flex-col gap-2 text-2xs text-text-muted">
          What the team is for (one line)
          <input
            value={team.description ?? ''}
            onChange={(e) => setTeam((t) => ({ ...t, description: e.target.value }))}
            className="bg-bg-dark border-2 border-border px-6 py-2 text-sm text-text font-reading"
          />
        </label>
        <label className="flex flex-col gap-2 text-2xs text-text-muted">
          What the lead is told when the team starts — {'{goal}'} is what you type then
          <textarea
            value={team.goalTemplate ?? ''}
            onChange={(e) => setTeam((t) => ({ ...t, goalTemplate: e.target.value }))}
            rows={2}
            placeholder="Build this feature: {goal}. Split the work, keep the plan on the board, and tell me when it's ready."
            className="bg-bg-dark border-2 border-border px-6 py-2 text-sm text-text font-reading resize-y"
          />
        </label>
        <div className="flex flex-col gap-6">
          {team.members.map((m, i) => (
            <MemberEditor
              key={i}
              member={m}
              index={i}
              workflows={pickable}
              onChange={(patch) => setMember(i, patch)}
              onRemove={() =>
                setTeam((t) => ({ ...t, members: t.members.filter((_, j) => j !== i) }))
              }
              onMakeLead={() =>
                setTeam((t) => ({
                  ...t,
                  members: t.members.map((x, j) => ({ ...x, lead: j === i || undefined })),
                }))
              }
            />
          ))}
        </div>
        <Button
          size="sm"
          className="self-start"
          disabled={team.members.length >= 8}
          onClick={() =>
            setTeam((t) => ({
              ...t,
              members: [...t.members, { ...EMPTY_MEMBER, palette: t.members.length }],
            }))
          }
        >
          + Member
        </Button>
      </div>
      <aside className="md:w-300 shrink-0 p-12 bg-bg-dark border-l-2 max-md:border-l-0 max-md:border-t-2 border-border flex flex-col gap-12 overflow-y-auto">
        <span className="text-2xs text-text-muted uppercase">Room</span>
        <Crew members={team.members} />
        <span className="text-2xs text-text-muted">
          Takes the first free team room with a seat for everyone.
        </span>
        <span className="text-2xs text-text-muted uppercase">Who talks to whom</span>
        <div className="flex flex-col gap-4 text-xs">
          {lead && (
            <span>
              <span className="text-pin-note">★ {lead.name || 'lead'}</span> →{' '}
              {others.map((m) => m.name || '…').join(', ') || 'nobody yet'}
            </span>
          )}
          {others.length > 0 && (
            <span className="text-text-muted">
              Members report back to the lead with @{lead?.name || 'lead'}.
            </span>
          )}
        </div>
        <label className="flex items-center gap-6 text-xs cursor-pointer">
          <input
            type="checkbox"
            checked={team.relay === true}
            onChange={(e) => setTeam((t) => ({ ...t, relay: e.target.checked }))}
          />
          Pass @mentions between members
        </label>
        <span className="text-2xs text-text-muted">
          Every pass starts a turn the receiving agent pays for; the office caps how many it passes.
        </span>
      </aside>
    </div>
  );
}

function StartDialog({
  team,
  folders,
  onStart,
  onCancel,
}: {
  team: TeamPreset;
  folders: string[];
  onStart: (folder: string, goal: string) => void;
  onCancel: () => void;
}) {
  const [folder, setFolder] = useState(folders[0] ?? '');
  const [goal, setGoal] = useState('');
  const lead = team.members.find((m) => m.lead) ?? team.members[0];
  const ordered = [lead, ...team.members.filter((m) => m !== lead)];
  return (
    <div
      className="m-auto w-520 max-w-[calc(100%-24px)] pixel-panel flex flex-col"
      data-testid="team-start"
    >
      <div className="px-12 py-8 border-b-2 border-border text-lg">Start {team.title}</div>
      <div className="p-12 flex flex-col gap-10">
        <label className="flex flex-col gap-2 text-2xs text-text-muted">
          Project folder
          <input
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            placeholder="~/code/my-project"
            className="bg-bg-dark border-2 border-border px-6 py-2 text-sm text-text font-mono"
          />
          <span className="flex gap-4 flex-wrap mt-2">
            {folders.slice(0, 5).map((f) => (
              <button
                key={f}
                onClick={() => setFolder(f)}
                className="px-4 text-2xs bg-bg-dark border-2 border-border text-text-muted cursor-pointer max-w-full overflow-hidden text-ellipsis whitespace-nowrap"
              >
                {f}
              </button>
            ))}
          </span>
        </label>
        <label className="flex flex-col gap-2 text-2xs text-text-muted">
          What should the team do?
          <textarea
            autoFocus
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            rows={3}
            className="bg-bg-dark border-2 border-accent px-6 py-2 text-sm text-text font-reading resize-y"
            data-testid="team-goal"
          />
        </label>
        <div className="flex flex-col gap-2">
          <span className="text-2xs text-text-muted uppercase">Starting</span>
          {ordered.map((m) => (
            <div key={m.name} className="grid grid-cols-[20px_90px_1fr] gap-8 items-center text-xs">
              <CharacterPortrait palette={m.palette ?? 0} zoom={1} />
              <span>
                {m.lead ? '★ ' : ''}
                {m.name}
              </span>
              <code className="text-2xs text-text-muted font-mono overflow-hidden text-ellipsis whitespace-nowrap">
                {m.command || 'claude'}
              </code>
            </div>
          ))}
        </div>
        <span className="text-2xs text-text-muted font-reading">
          The lead gets your goal; the others wait for the lead's first message. Each member counts
          toward the office's limit of agents it runs.
        </span>
      </div>
      <div className="flex gap-6 justify-end px-12 py-8 border-t-2 border-border">
        <Button size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant={folder.trim() && goal.trim() ? 'accent' : 'disabled'}
          disabled={!folder.trim() || !goal.trim()}
          onClick={() => onStart(folder.trim(), goal.trim())}
          data-testid="team-start-go"
        >
          Start {team.members.length} agents
        </Button>
      </div>
    </div>
  );
}

function ExportDialog({
  team,
  workflows,
  onClose,
}: {
  team: TeamPreset;
  workflows: Workflow[];
  onClose: () => void;
}) {
  const [includeCommands, setIncludeCommands] = useState(false);
  const [includeWorkflows, setIncludeWorkflows] = useState(true);
  const [copied, setCopied] = useState(false);
  const bundle = exportBundle(team, workflows, { includeCommands, includeWorkflows });
  const used = team.members.filter((m) => m.workflowId).length;
  return (
    <div
      className="m-auto w-520 max-w-[calc(100%-24px)] pixel-panel flex flex-col"
      data-testid="team-export"
    >
      <div className="px-12 py-8 border-b-2 border-border text-lg">Export {team.title}</div>
      <div className="p-12 flex flex-col gap-8 text-sm">
        <span className="text-2xs text-text-muted">
          Included: roles, names, instructions, looks.
        </span>
        <label className="flex items-center gap-6 cursor-pointer">
          <input
            type="checkbox"
            checked={includeWorkflows}
            onChange={(e) => setIncludeWorkflows(e.target.checked)}
          />
          Workflows the team uses ({used})
        </label>
        <label className="flex items-center gap-6 cursor-pointer">
          <input
            type="checkbox"
            checked={includeCommands}
            onChange={(e) => setIncludeCommands(e.target.checked)}
          />
          Start commands
        </label>
        {!includeCommands && (
          <div className="p-6 border-2 border-status-permission bg-chat-permission text-2xs">
            Start commands are left out: they can hold your own aliases and folder paths. Whoever
            imports the team picks their own.
          </div>
        )}
        <span className="text-2xs text-text-muted">Share code</span>
        <div className="p-6 bg-bg-dark border-2 border-border text-2xs font-mono break-all max-h-80 overflow-y-auto">
          {encodeShareCode(bundle)}
        </div>
      </div>
      <div className="flex gap-6 justify-end px-12 py-8 border-t-2 border-border">
        <Button
          size="sm"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(encodeShareCode(bundle))
              .then(() => setCopied(true));
          }}
        >
          {copied ? 'Copied' : 'Copy code'}
        </Button>
        <Button size="sm" onClick={onClose}>
          Close
        </Button>
        <Button
          size="sm"
          variant="accent"
          onClick={() =>
            downloadText(`${fileSlug(team.title)}.pixelteam`, JSON.stringify(bundle, null, 2))
          }
        >
          Save file
        </Button>
      </div>
    </div>
  );
}

function ImportDialog({
  workflows,
  onImport,
  onImportWorkflow,
  onCancel,
}: {
  workflows: Workflow[];
  onImport: (bundle: TeamBundle) => void;
  onImportWorkflow: (markdown: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const bundle = useMemo(() => (text.trim() ? readBundle(text) : null), [text]);
  const readFile = (file: File) => {
    void file.text().then((content) => {
      if (/\.md$/i.test(file.name)) {
        onImportWorkflow(content);
        onCancel();
        return;
      }
      setText(content);
      setError(readBundle(content) ? null : 'That file is not an exported team.');
    });
  };
  return (
    <div
      className="m-auto w-600 max-w-[calc(100%-24px)] pixel-panel flex flex-col"
      data-testid="team-import"
    >
      <div className="px-12 py-8 border-b-2 border-border text-lg">Import a team</div>
      <div className="p-12 flex flex-col gap-10">
        <label
          className="p-16 border-2 border-dashed border-accent text-center text-sm text-text-muted cursor-pointer"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const file = e.dataTransfer.files[0];
            if (file) readFile(file);
          }}
        >
          <span className="text-text">Drop a .pixelteam file</span> (or a workflow .md) · or click
          to choose
          <input
            type="file"
            accept=".pixelteam,.json,.md"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) readFile(file);
            }}
          />
        </label>
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => e.stopPropagation()}
          rows={3}
          placeholder="…or paste a share code (PXT1-…)"
          className="bg-bg-dark border-2 border-border px-6 py-2 text-2xs text-text font-mono"
        />
        {error && <span className="text-2xs text-danger">{error}</span>}
        {text.trim() && !bundle && !error && (
          <span className="text-2xs text-danger">That is not a team share code.</span>
        )}
        {bundle && (
          <div className="flex flex-col gap-6">
            <span className="text-sm">{bundle.team.title}</span>
            <Crew members={bundle.team.members} />
            {bundle.team.description && (
              <span className="text-xs text-text-muted font-reading">
                {bundle.team.description}
              </span>
            )}
            <span className="text-2xs text-text-muted uppercase">How each member will start</span>
            {bundle.team.members.map((m) => (
              <div key={m.name} className="flex gap-8 text-xs">
                <span className="w-100">
                  {m.lead ? '★ ' : ''}
                  {m.name}
                </span>
                <code className="flex-1 min-w-0 text-2xs font-mono overflow-hidden text-ellipsis whitespace-nowrap">
                  {m.command || 'claude (your default)'}
                </code>
              </div>
            ))}
            {bundle.workflows.length > 0 && (
              <>
                <span className="text-2xs text-text-muted uppercase">Workflows inside</span>
                {bundle.workflows.map((w) => (
                  <span key={w.id} className="text-xs">
                    {w.title}
                    {workflows.some((x) => x.title === w.title) && (
                      <span className="text-2xs text-status-permission">
                        {' '}
                        · you have one with this name; both are kept
                      </span>
                    )}
                  </span>
                ))}
              </>
            )}
            <div className="p-6 border-2 border-status-permission bg-chat-permission text-2xs">
              Read the instructions before you start this team — they are what the agents are told
              to do. Importing only saves it; nothing starts until you press Start.
            </div>
            <details className="text-2xs">
              <summary className="cursor-pointer text-text-muted">Read all instructions</summary>
              {bundle.team.members.map((m) => (
                <p key={m.name} className="font-reading my-4">
                  <b>{m.name}:</b> {m.instructions || '(none)'}
                </p>
              ))}
            </details>
          </div>
        )}
      </div>
      <div className="flex gap-6 justify-end px-12 py-8 border-t-2 border-border">
        <Button size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant={bundle ? 'accent' : 'disabled'}
          disabled={!bundle}
          onClick={() => bundle && onImport(bundle)}
          data-testid="team-import-go"
        >
          Import team
        </Button>
      </div>
    </div>
  );
}

function AiDialog({
  teams,
  folders,
  onUse,
  onCancel,
}: {
  teams: TeamsState;
  folders: string[];
  onUse: (team: TeamPreset, workflows: Workflow[]) => void;
  onCancel: () => void;
}) {
  const [description, setDescription] = useState('');
  const [folder, setFolder] = useState(folders[0] ?? '');
  const [readProject, setReadProject] = useState(true);
  const [change, setChange] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [history, setHistory] = useState<Array<{ who: 'you' | 'ai'; text: string }>>([]);
  const draft = requestId ? teams.teamDrafts[requestId] : undefined;
  const busy = requestId !== null && !draft;
  const [current, setCurrent] = useState<{ team: TeamPreset; workflows: Workflow[] } | null>(null);

  useEffect(() => {
    if (!draft) return;
    if (draft.team) {
      setCurrent({ team: draft.team, workflows: draft.workflows ?? [] });
      if (draft.note) setHistory((h) => [...h, { who: 'ai', text: draft.note ?? '' }]);
    } else if (draft.error) {
      setHistory((h) => [...h, { who: 'ai', text: `Could not draft: ${draft.error}` }]);
    }
  }, [draft]);

  const ask = (changeText?: string) => {
    const id = newRequestId();
    setRequestId(id);
    teams.draftTeam({
      requestId: id,
      description,
      folder: folder || undefined,
      readProject,
      ...(changeText && current ? { previous: current.team, change: changeText } : {}),
    });
  };

  return (
    <div
      className="m-auto w-900 max-w-[calc(100%-24px)] max-h-[calc(100%-24px)] pixel-panel flex max-md:flex-col overflow-hidden"
      data-testid="team-ai"
    >
      <div className="md:w-360 shrink-0 flex flex-col border-r-2 max-md:border-r-0 border-border">
        <div className="px-12 py-8 border-b-2 border-border text-lg">
          <span className="px-4 mr-6 text-2xs bg-accent text-white">AI</span>Create a team
        </div>
        <div className="p-12 flex flex-col gap-8">
          <label className="flex flex-col gap-2 text-2xs text-text-muted">
            Describe the team you want
            <textarea
              autoFocus
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              rows={5}
              placeholder="A team that turns a screenshot into a React page, checks it on mobile, and asks me before merging."
              className="bg-bg-dark border-2 border-accent px-6 py-2 text-sm text-text font-reading resize-y"
              data-testid="team-ai-description"
            />
          </label>
          <label className="flex flex-col gap-2 text-2xs text-text-muted">
            Project (optional)
            <input
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              className="bg-bg-dark border-2 border-border px-6 py-2 text-xs text-text font-mono"
            />
          </label>
          <label className="flex items-center gap-6 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={readProject}
              onChange={(e) => setReadProject(e.target.checked)}
            />
            Let it read the project to fit roles to the code
          </label>
          <span className="text-2xs text-text-muted">
            Runs a Claude session to draft it (a few thousand tokens). It can read files but not
            change them.
          </span>
        </div>
        <div className="mt-auto flex gap-6 justify-end px-12 py-8 border-t-2 border-border">
          <Button size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant={description.trim() && !busy ? 'accent' : 'disabled'}
            disabled={!description.trim() || busy}
            onClick={() => {
              setHistory([]);
              setCurrent(null);
              ask();
            }}
            data-testid="team-ai-draft"
          >
            {busy ? 'Drafting…' : current ? 'Redo' : 'Draft team'}
          </Button>
        </div>
      </div>
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        <div className="flex items-center gap-8 px-12 py-8 bg-chat-permission border-b-2 border-pin-note text-sm">
          <span className="text-pin-note">Draft</span>
          <span className="text-xs text-text-muted flex-1">
            Nothing is saved yet. Check it, then save — you can still edit it after.
          </span>
          <Button
            size="sm"
            disabled={!current}
            onClick={() => current && onUse(current.team, current.workflows)}
            variant={current ? 'accent' : 'disabled'}
            data-testid="team-ai-use"
          >
            Review &amp; save
          </Button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-12 flex flex-col gap-8">
          {busy && (
            <span className="text-sm text-text-muted">A helper agent is drafting the team…</span>
          )}
          {!busy && !current && (
            <span className="text-sm text-text-muted">The draft appears here.</span>
          )}
          {current && (
            <>
              <span className="text-lg">{current.team.title}</span>
              <Crew members={current.team.members} />
              {current.team.members.map((m, i) => (
                <div
                  key={m.name}
                  className="flex gap-8 items-start p-6 border-2 border-border bg-bg-thumb"
                >
                  <CharacterPortrait palette={m.palette ?? i} />
                  <div className="min-w-0 flex flex-col gap-2">
                    <span className="text-sm">
                      {m.name} {m.lead && <span className="text-2xs text-pin-note">★ lead</span>}
                      <span className="text-2xs text-text-muted"> · {m.role}</span>
                    </span>
                    <code className="text-2xs font-mono text-text-muted">
                      {m.command || 'claude'}
                    </code>
                    <span className="text-xs font-reading italic text-text-muted">
                      {m.instructions}
                    </span>
                  </div>
                </div>
              ))}
              {current.workflows.map((w) => (
                <span key={w.id} className="text-xs">
                  Workflow: {w.title} ({w.steps.length} steps, drafted too)
                </span>
              ))}
            </>
          )}
        </div>
        {current && (
          <div className="flex flex-col gap-6 px-12 py-8 border-t-2 border-border">
            {history.map((h, i) => (
              <span
                key={i}
                className={`text-xs font-reading ${h.who === 'you' ? 'self-end text-text' : 'text-text-muted'}`}
              >
                {h.text}
              </span>
            ))}
            <form
              className="flex gap-6"
              onSubmit={(e) => {
                e.preventDefault();
                if (!change.trim() || busy) return;
                setHistory((h) => [...h, { who: 'you', text: change.trim() }]);
                ask(change.trim());
                setChange('');
              }}
            >
              <input
                value={change}
                onChange={(e) => setChange(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder='Ask for changes, e.g. "add a copywriter"'
                className="flex-1 min-w-0 bg-bg-dark border-2 border-border px-6 py-2 text-sm text-text font-reading"
              />
              <Button size="sm" variant="accent" type="submit" disabled={busy}>
                Send
              </Button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}

function RunningTeams({
  crews,
  labelOf,
  onStop,
  onOpenAgent,
}: {
  crews: TeamRun[];
  labelOf: (agentId: number) => string;
  onStop?: (crewId: string) => void;
  onOpenAgent: (agentId: number) => void;
}) {
  const running = crews.filter((c) => c.state === 'running');
  if (running.length === 0) return null;
  return (
    <div className="flex flex-col gap-8 px-16 pb-16">
      <span className="text-2xs text-text-muted uppercase">Running</span>
      {running.map((c) => (
        <div
          key={c.crewId}
          className="p-8 border-2 border-border bg-bg-dark flex flex-col gap-4"
          data-testid="team-running"
        >
          <div className="flex items-center gap-8">
            <span className="text-sm flex-1">{c.title}</span>
            {onStop && (
              <Button size="sm" onClick={() => onStop(c.crewId)}>
                Stop team
              </Button>
            )}
          </div>
          <span className="text-2xs text-text-muted font-reading">
            {c.goal} · {c.folder}
          </span>
          <div className="flex gap-6 flex-wrap">
            {c.members.map((m) => (
              <button
                key={m.name}
                disabled={m.agentId === undefined}
                onClick={() => m.agentId !== undefined && onOpenAgent(m.agentId)}
                className="flex items-center gap-4 px-6 py-2 bg-bg border-2 border-border text-xs text-text cursor-pointer disabled:cursor-default"
                title={m.error}
              >
                <CharacterPortrait palette={m.palette ?? 0} zoom={1} />
                {m.lead ? '★ ' : ''}
                {m.agentId !== undefined ? labelOf(m.agentId) : m.name}
                <span className="text-2xs text-text-muted">
                  {m.error ? `· ${m.error}` : m.agentId === undefined ? '· starting' : ''}
                </span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Teams: presets you set up once (roles, instructions, how each is started,
 * room, workflows) and start in one go — plus export/import and AI drafts.
 */
export function TeamsPanel({
  teams,
  workflows,
  labelOf,
  folders,
  canEdit,
  canStart,
  onOpenAgent,
  onClose,
}: TeamsPanelProps) {
  const [view, setView] = useState<View>({ kind: 'library' });
  const [search, setSearch] = useState('');
  const needle = search.trim().toLowerCase();
  const shown = needle
    ? teams.teams.filter(
        (t) =>
          t.title.toLowerCase().includes(needle) ||
          t.members.some(
            (m) => m.role.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle),
          ),
      )
    : teams.teams;

  return (
    <div
      role="dialog"
      aria-label="Teams"
      className="absolute inset-0 z-58 flex flex-col bg-bg text-text"
      data-testid="teams-panel"
      onMouseDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          if (view.kind === 'library') onClose();
          else setView({ kind: 'library' });
        }
      }}
    >
      <div className="flex items-center gap-8 px-16 py-8 border-b-2 border-border flex-wrap">
        <span className="text-xl">Teams</span>
        <span className="flex-1" />
        {view.kind === 'library' && (
          <>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search teams…"
              className="w-200 max-sm:w-full bg-bg-dark border-2 border-border px-6 py-2 text-sm text-text"
            />
            {canEdit && (
              <>
                <Button
                  size="sm"
                  onClick={() => setView({ kind: 'ai' })}
                  data-testid="team-ai-open"
                >
                  <span className="px-2 mr-4 text-2xs bg-accent text-white">AI</span>Create with AI
                </Button>
                <Button size="sm" onClick={() => setView({ kind: 'import' })}>
                  Import
                </Button>
                <Button
                  size="sm"
                  variant="accent"
                  onClick={() =>
                    setView({ kind: 'edit', team: { id: '', title: '', relay: true, members: [] } })
                  }
                  data-testid="team-new"
                >
                  + New team
                </Button>
              </>
            )}
          </>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={view.kind === 'library' ? onClose : () => setView({ kind: 'library' })}
          aria-label="Close"
        >
          ×
        </Button>
      </div>
      {teams.notice && (
        <div
          className={`flex gap-8 items-start mx-16 mt-8 p-6 border-2 text-xs ${
            teams.notice.error
              ? 'border-status-permission bg-chat-permission'
              : 'border-status-success bg-bg-dark'
          }`}
        >
          <span className="flex-1">{teams.notice.message}</span>
          <button
            className="bg-transparent border-0 text-text-muted cursor-pointer"
            onClick={teams.clearNotice}
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {view.kind === 'library' && (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-12 p-16">
            {shown.map((t) => (
              <div
                key={t.id}
                className="flex flex-col gap-8 p-10 bg-bg-dark border-2 border-border shadow-pixel"
                data-testid="team-card"
              >
                <div className="flex items-center gap-6">
                  <span className="text-base flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                    {t.title}
                  </span>
                  <span className="text-2xs text-text-muted">{t.members.length} agents</span>
                </div>
                <Crew members={t.members} />
                {t.description && (
                  <span className="text-xs text-text-muted font-reading">{t.description}</span>
                )}
                <div className="flex gap-4 flex-wrap">
                  {t.members.map((m) => (
                    <span
                      key={m.name}
                      className={`px-4 text-2xs border-2 ${m.lead ? 'border-pin-note text-pin-note' : 'border-border'}`}
                    >
                      {m.lead ? '★ ' : ''}
                      {m.role}
                    </span>
                  ))}
                </div>
                <div className="flex gap-8 text-2xs text-text-muted flex-wrap">
                  {t.members.some((m) => m.workflowId) && (
                    <span>workflows: {t.members.filter((m) => m.workflowId).length}</span>
                  )}
                  {t.relay && <span>relay on</span>}
                </div>
                <div className="flex gap-4 mt-auto flex-wrap">
                  {canEdit && (
                    <Button
                      size="sm"
                      variant={canStart ? 'accent' : 'disabled'}
                      disabled={!canStart}
                      title={
                        canStart
                          ? 'Start this team'
                          : 'Only the standalone office (npx pixel-agents) can start agents'
                      }
                      onClick={() => setView({ kind: 'start', team: t })}
                      data-testid="team-start-open"
                    >
                      Start
                    </Button>
                  )}
                  {canEdit && (
                    <Button size="sm" onClick={() => setView({ kind: 'edit', team: t })}>
                      Edit
                    </Button>
                  )}
                  <Button size="sm" onClick={() => setView({ kind: 'export', team: t })}>
                    Export
                  </Button>
                </div>
              </div>
            ))}
            {canEdit && (
              <button
                onClick={() =>
                  setView({ kind: 'edit', team: { id: '', title: '', relay: true, members: [] } })
                }
                className="min-h-200 flex flex-col items-center justify-center gap-4 border-2 border-dashed border-border bg-transparent text-text-muted cursor-pointer"
              >
                <span className="text-3xl text-accent-bright">+</span>
                <span className="text-sm text-text">New team</span>
                <span className="text-2xs">or create one with AI</span>
              </button>
            )}
          </div>
          <RunningTeams
            crews={teams.crews}
            labelOf={labelOf}
            onStop={canEdit ? teams.stop : undefined}
            onOpenAgent={onOpenAgent}
          />
        </div>
      )}

      {view.kind === 'edit' && (
        <TeamEditor
          key={view.team.id || 'new'}
          initial={view.team}
          draftWorkflows={view.draftWorkflows}
          workflows={workflows}
          onSave={(team) => {
            if (view.draftWorkflows?.length) {
              // A drafted team brings its drafted workflows: import saves both.
              teams.importTeam(team, view.draftWorkflows);
            } else {
              teams.save(team);
            }
            setView({ kind: 'library' });
          }}
          onCancel={() => setView({ kind: 'library' })}
          onDelete={
            view.team.id
              ? () => {
                  teams.remove(view.team.id);
                  setView({ kind: 'library' });
                }
              : undefined
          }
        />
      )}

      {view.kind === 'start' && (
        <div className="flex-1 min-h-0 overflow-y-auto flex p-12">
          <StartDialog
            team={view.team}
            folders={folders}
            onStart={(folder, goal) => {
              teams.start(view.team.id, folder, goal);
              onClose();
            }}
            onCancel={() => setView({ kind: 'library' })}
          />
        </div>
      )}

      {view.kind === 'export' && (
        <div className="flex-1 min-h-0 overflow-y-auto flex p-12">
          <ExportDialog
            team={view.team}
            workflows={workflows}
            onClose={() => setView({ kind: 'library' })}
          />
        </div>
      )}

      {view.kind === 'import' && (
        <div className="flex-1 min-h-0 overflow-y-auto flex p-12">
          <ImportDialog
            workflows={workflows}
            onImport={(bundle) => {
              teams.importTeam(bundle.team, bundle.workflows);
              setView({ kind: 'library' });
            }}
            onImportWorkflow={teams.importWorkflow}
            onCancel={() => setView({ kind: 'library' })}
          />
        </div>
      )}

      {view.kind === 'ai' && (
        <div className="flex-1 min-h-0 flex p-12">
          <AiDialog
            teams={teams}
            folders={folders}
            onUse={(team, drafted) => setView({ kind: 'edit', team, draftWorkflows: drafted })}
            onCancel={() => setView({ kind: 'library' })}
          />
        </div>
      )}
    </div>
  );
}
