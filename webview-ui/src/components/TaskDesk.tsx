import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';

import type {
  DeskAgent,
  DeskBrief,
  DeskSubtask,
  DeskTask,
  DeskTaskKind,
  DeskTaskPriority,
  ModelOption,
  TeamPreset,
  Workflow,
} from '../../../core/src/messages.js';
import {
  DESK_CARD_DRAG_MIME,
  TASK_BODY_MAX_CHARS,
  TASK_DESK_COMMAND_KEY,
  TASK_DESK_FIRST_MESSAGE,
  TASK_DESK_LAYA_TIMEOUT_MS,
  TASK_DETAILS_EXPANDED_ROWS,
  TASK_DETAILS_ROWS,
  TASK_NOTE_MAX_CHARS,
  TASK_TITLE_MAX_CHARS,
} from '../constants.js';
import { canSendChatFiles, uploadChatFiles } from '../fileUpload.js';
import { decisionModelReady, useLayaStatus } from '../hooks/useLayaStatus.js';
import type { TaskDeskState } from '../hooks/useTaskDesk.js';
import {
  agentsInFolder,
  branchMismatch,
  cardFolders,
  type DeskColumn,
  deskColumns,
  type DeskFilter,
  deskSections,
  dropAction,
  filterCards,
  isFiltering,
  isWaitingOnYou,
  lockedStepCount,
  needsYou,
  NO_FILTER,
  sameSteps,
  stateLabel,
  stepsToWorkflow,
  stuckFixes,
  stuckReason,
  subColumns,
  subtaskProgress,
  workflowToSteps,
} from '../taskDesk.js';
import { transport } from '../transport/index.js';
import { tunable } from '../tunableStore.js';
import { DeskFlowEditor } from './DeskFlowEditor.js';
import { DeskSteps } from './DeskSteps.js';
import { FolderPicker } from './FolderPicker.js';
import { ModelSelect } from './ModelSelect.js';
import { Button } from './ui/Button.js';

/** Saved workflows, for a card's "Load workflow" / "Save as workflow". Absent = not offered. */
const DeskWorkflowsContext = createContext<{
  list: Workflow[];
  save: (workflow: Workflow) => void;
} | null>(null);

/**
 * Team presets a card can be given to (standalone office only: it starts
 * agents), and the model list for "Start an agent here".
 */
const DeskExtrasContext = createContext<{
  teams: TeamPreset[] | null;
  modelOptions: ModelOption[];
}>({ teams: null, modelOptions: [] });

interface FolderChoice {
  name: string;
  path: string;
}

/** What the card form needs to offer a folder; passed down so a card can be edited in place. */
type FolderSources = Pick<TaskDeskProps, 'canBrowseFolders' | 'recentFolders' | 'workspaceFolders'>;

interface TaskDeskProps {
  isOpen: boolean;
  onToggle: () => void;
  desk: TaskDeskState;
  labelOf: (agentId: number) => string;
  /** Standalone office: folders are browsed on the server's machine. */
  canBrowseFolders: boolean;
  recentFolders: string[];
  /** VS Code: the workspace's folders are the choices. */
  workspaceFolders: FolderChoice[];
  /** The office can start agents itself (standalone with node-pty, privileged). */
  canStartAgents: boolean;
  /** Saved workflows a card's steps can be loaded from or saved as. */
  workflows?: Workflow[];
  onSaveWorkflow?: (workflow: Workflow) => void;
  /** Team presets a card can be for; absent where the office cannot start teams. */
  teams?: TeamPreset[];
  /** Claude's model picker options, as last read (see ModelSelect). */
  modelOptions?: ModelOption[];
}

const KINDS: DeskTaskKind[] = ['task', 'issue', 'feature'];
const KIND_TAG: Record<DeskTaskKind, string> = { task: 'T', issue: '!', feature: '+' };

const fieldClass =
  'w-full px-8 py-4 bg-bg-dark text-text text-base border border-border rounded-ui outline-none focus:border-accent';
const sectionTitle = 'text-xs text-text-muted uppercase tracking-wider';
const chip = 'px-4 text-2xs border leading-tight';

// ── Add a card ───────────────────────────────────────────────

interface LayaPick {
  teamId?: string;
  workflowId?: string;
  model?: string;
}

/** "Suggest with Laya": one request at a time, the answer fills the form (server: cardRouting.ts). */
function useLayaSuggestion() {
  const available = decisionModelReady(useLayaStatus());
  const [pending, setPending] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const apply = useRef<(pick: LayaPick) => void>(() => {});

  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => {
      setPending(null);
      setNote('Laya did not answer in time.');
    }, TASK_DESK_LAYA_TIMEOUT_MS);
    const off = transport.onMessage((msg) => {
      if (msg.type !== 'deskCardSuggestion' || msg.requestId !== pending) return;
      clearTimeout(timer);
      setPending(null);
      if (msg.error) {
        setNote(msg.error);
        return;
      }
      const pick: LayaPick = {
        ...(msg.teamId !== undefined ? { teamId: msg.teamId } : {}),
        ...(msg.workflowId !== undefined ? { workflowId: msg.workflowId } : {}),
        ...(msg.model !== undefined ? { model: msg.model } : {}),
      };
      apply.current(pick);
      const filled = Object.keys(pick);
      setNote(
        filled.length === 0
          ? 'Laya was not sure about any of them; nothing changed.'
          : `Laya picked the ${filled
              .map((k) => (k === 'teamId' ? 'team' : k === 'workflowId' ? 'workflow' : 'model'))
              .join(', ')}. Check and save.`,
      );
    });
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [pending]);

  const ask = (
    card: { title: string; body: string; kind: string },
    onPick: (p: LayaPick) => void,
  ) => {
    const requestId = Math.random().toString(36).slice(2);
    apply.current = onPick;
    setNote(null);
    setPending(requestId);
    transport.send({ type: 'suggestDeskCard', requestId, ...card });
  };

  return { available, pending: pending !== null, note, ask };
}

function CardForm({
  desk,
  canBrowseFolders,
  recentFolders,
  workspaceFolders,
  onDone,
  editing,
}: Pick<TaskDeskProps, 'desk' | 'canBrowseFolders' | 'recentFolders' | 'workspaceFolders'> & {
  onDone: () => void;
  /** The card being edited; absent when adding a new one. */
  editing?: DeskTask;
}) {
  const [kind, setKind] = useState<DeskTaskKind>(editing?.kind ?? 'task');
  const [title, setTitle] = useState(editing?.title ?? '');
  const [body, setBody] = useState(editing?.body ?? '');
  const [priority, setPriority] = useState<DeskTaskPriority>(editing?.priority ?? 'p2');
  const [folder, setFolder] = useState(
    editing?.folder.root ?? workspaceFolders[0]?.path ?? recentFolders[0] ?? '',
  );
  const [teamId, setTeamId] = useState(editing?.teamId ?? '');
  const [workflowId, setWorkflowId] = useState(editing?.workflowId ?? '');
  const [model, setModel] = useState(editing?.model ?? '');
  const [files, setFiles] = useState<string[]>(editing?.attachments?.map((a) => a.path) ?? []);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const extras = useContext(DeskExtrasContext);
  const deskWorkflows = useContext(DeskWorkflowsContext);
  const canAdd = title.trim().length > 0 && folder.trim().length > 0;
  const suggest = useLayaSuggestion();
  const askLaya = () =>
    suggest.ask({ title, body, kind }, (pick) => {
      if (pick.teamId !== undefined && extras.teams) setTeamId(pick.teamId);
      if (pick.workflowId !== undefined && deskWorkflows) setWorkflowId(pick.workflowId);
      if (pick.model !== undefined) setModel(pick.model);
    });
  const save = (draft: boolean) => {
    if (!canAdd) return;
    desk.saveCard({
      kind,
      title: title.trim(),
      body: body.trim(),
      priority,
      folder,
      teamId,
      workflowId,
      model,
      attachments: files,
      ...(editing ? { taskId: editing.id } : { draft }),
    });
    onDone();
  };

  return (
    <form
      // Its own scroll: with the folder browser open the form is taller than a short window.
      className="flex flex-col gap-8 p-10 border-b-2 border-border bg-bg-dark shrink-0 max-h-[80%] overflow-y-auto"
      onSubmit={(e) => {
        e.preventDefault();
        save(false);
      }}
      onKeyDown={(e) => e.stopPropagation()}
      data-testid="desk-card-form"
    >
      <div className="flex gap-4">
        {KINDS.map((k) => (
          <Button
            key={k}
            type="button"
            size="sm"
            variant={kind === k ? 'active' : 'default'}
            onClick={() => setKind(k)}
          >
            {k}
          </Button>
        ))}
        <label className="flex gap-4 items-center text-sm ml-auto">
          <input
            type="checkbox"
            checked={priority === 'p1'}
            onChange={(e) => setPriority(e.target.checked ? 'p1' : 'p2')}
          />
          P1
        </label>
      </div>
      <input
        className={fieldClass}
        value={title}
        maxLength={TASK_TITLE_MAX_CHARS}
        placeholder="What needs doing"
        aria-label="Card title"
        onChange={(e) => setTitle(e.target.value)}
        data-testid="desk-card-title"
        autoFocus
      />
      <div className="flex flex-col gap-2">
        <textarea
          // A fixed size: longer details scroll inside the box.
          className={`${fieldClass} resize-y overflow-y-auto shrink-0`}
          rows={detailsExpanded ? TASK_DETAILS_EXPANDED_ROWS : TASK_DETAILS_ROWS}
          value={body}
          maxLength={TASK_BODY_MAX_CHARS}
          placeholder="What you know so far (optional)"
          aria-label="Card details"
          onChange={(e) => setBody(e.target.value)}
          data-testid="desk-card-details"
        />
        <div className="flex items-center gap-8 text-2xs text-text-muted">
          <span>
            {body.length}/{TASK_BODY_MAX_CHARS}
          </span>
          <Button
            type="button"
            size="sm"
            className="ml-auto"
            aria-expanded={detailsExpanded}
            onClick={() => setDetailsExpanded((v) => !v)}
            data-testid="desk-card-details-expand"
          >
            {detailsExpanded ? 'Smaller' : 'Expand'}
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-2 text-sm">
        Folder the agent must be in
        {canBrowseFolders ? (
          <FolderPicker value={folder} onChange={setFolder} recentFolders={recentFolders} />
        ) : (
          <select
            className={fieldClass}
            value={folder}
            aria-label="Folder"
            onChange={(e) => setFolder(e.target.value)}
          >
            {workspaceFolders.length === 0 && <option value="">Open a folder first</option>}
            {workspaceFolders.map((f) => (
              <option key={f.path} value={f.path}>
                {f.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {extras.teams && extras.teams.length > 0 && (
        <label className="flex flex-col gap-2 text-sm">
          Team
          <select
            className={fieldClass}
            value={teamId}
            aria-label="Team"
            onChange={(e) => setTeamId(e.target.value)}
            data-testid="desk-card-team"
          >
            <option value="">No team: one agent in the folder takes it</option>
            {extras.teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title} ({t.members.length})
              </option>
            ))}
          </select>
          {teamId && (
            <span className="text-2xs text-text-muted">
              The desk starts this team in the folder and hands the card to its lead, who calls
              teammates in.
            </span>
          )}
        </label>
      )}
      {deskWorkflows && deskWorkflows.list.length > 0 && (
        <label className="flex flex-col gap-2 text-sm">
          Workflow
          <select
            className={fieldClass}
            value={workflowId}
            aria-label="Workflow"
            onChange={(e) => setWorkflowId(e.target.value)}
            data-testid="desk-card-workflow"
          >
            <option value="">No workflow: the agent plans the steps</option>
            {deskWorkflows.list.map((w) => (
              <option key={w.id} value={w.id}>
                {w.title} ({w.steps.length} steps)
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="flex flex-col gap-2 text-sm">
        Model for agents started for this card
        <ModelSelect
          options={extras.modelOptions}
          value={model}
          onChange={setModel}
          className={fieldClass}
        />
      </label>
      {suggest.available && (
        <div className="flex flex-col gap-2" data-testid="desk-card-laya">
          <Button
            type="button"
            size="sm"
            variant={title.trim() && !suggest.pending ? 'default' : 'disabled'}
            disabled={!title.trim() || suggest.pending}
            onClick={askLaya}
            title="Laya reads the title and details and picks the team, workflow and model that fit. You still save."
            data-testid="desk-card-laya-suggest"
          >
            {suggest.pending ? 'Laya is reading…' : 'Suggest team, workflow and model (Laya)'}
          </Button>
          {suggest.note && <span className="text-2xs text-text-muted">{suggest.note}</span>}
        </div>
      )}
      <CardFiles files={files} onChange={setFiles} />
      <div className="flex gap-6 justify-end">
        <Button type="button" size="sm" onClick={onDone}>
          Cancel
        </Button>
        {!editing && (
          <Button
            type="button"
            size="sm"
            variant={canAdd ? 'default' : 'disabled'}
            disabled={!canAdd}
            onClick={() => save(true)}
            title="Keep it to yourself for now. No agent looks at a draft."
            data-testid="desk-card-draft"
          >
            Save as draft
          </Button>
        )}
        <Button
          type="submit"
          size="sm"
          variant={canAdd ? 'accent' : 'disabled'}
          disabled={!canAdd}
          data-testid="desk-card-add"
        >
          {editing ? 'Save' : 'Add to desk'}
        </Button>
      </div>
    </form>
  );
}

/** A card's attached files: paths on the server's machine, typed in or uploaded. */
function CardFiles({ files, onChange }: { files: string[]; onChange: (files: string[]) => void }) {
  const [pathDraft, setPathDraft] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const add = (paths: string[]) =>
    onChange([...files, ...paths.filter((p) => p && !files.includes(p))]);
  const canUpload = canSendChatFiles();
  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="desk-card-files">
      Files for the agent
      {files.length > 0 && (
        <div className="flex flex-wrap gap-4">
          {files.map((p) => (
            <span
              key={p}
              className="flex items-center gap-4 px-4 border border-border bg-bg text-2xs max-w-full"
              title={p}
            >
              <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                {p.split(/[\\/]/).pop()}
              </span>
              <button
                type="button"
                className="bg-transparent border-0 p-0 text-text-muted cursor-pointer"
                aria-label={`Remove ${p}`}
                onClick={() => onChange(files.filter((f) => f !== p))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-4">
        <input
          className={fieldClass}
          value={pathDraft}
          spellCheck={false}
          placeholder="/full/path/to/file"
          aria-label="File path"
          onChange={(e) => setPathDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            add([pathDraft.trim()]);
            setPathDraft('');
          }}
          data-testid="desk-card-file-path"
        />
        <Button
          type="button"
          size="sm"
          variant={pathDraft.trim() ? 'default' : 'disabled'}
          disabled={!pathDraft.trim()}
          onClick={() => {
            add([pathDraft.trim()]);
            setPathDraft('');
          }}
        >
          Add
        </Button>
        {canUpload && (
          <>
            <input
              ref={inputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                const picked = e.target.files ? Array.from(e.target.files) : [];
                e.target.value = '';
                if (picked.length === 0) return;
                setUploading(true);
                setError(null);
                void uploadChatFiles(picked).then((result) => {
                  setUploading(false);
                  if (result.ok) add(result.paths);
                  else setError(result.error);
                });
              }}
              data-testid="desk-card-file-input"
            />
            <Button
              type="button"
              size="sm"
              variant={uploading ? 'disabled' : 'default'}
              disabled={uploading}
              onClick={() => inputRef.current?.click()}
              title="Upload files; the agent gets their paths"
            >
              {uploading ? 'Uploading…' : 'Upload'}
            </Button>
          </>
        )}
      </div>
      {error && <span className="text-2xs text-danger">{error}</span>}
    </div>
  );
}

// ── One card ─────────────────────────────────────────────────

function BriefView({ brief }: { brief: DeskBrief }) {
  return (
    <div className="flex flex-col gap-6 text-sm">
      {brief.understanding ? (
        <p className="m-0 whitespace-pre-wrap break-words">{brief.understanding}</p>
      ) : (
        <p className="m-0 text-text-muted">No agent managed to write a brief for this card.</p>
      )}
      {brief.files.length > 0 && (
        <p className="m-0 text-2xs text-text-muted break-all">Files: {brief.files.join(', ')}</p>
      )}
      {(brief.risk || brief.size) && (
        <p className="m-0 text-2xs text-text-muted">
          {brief.risk && `Risk ${brief.risk}`} {brief.size && `· Size ${brief.size}`} · by{' '}
          {brief.by}
        </p>
      )}
    </div>
  );
}

function StartAgentHere({ folder, cardModel }: { folder: string; cardModel?: string }) {
  const [command, setCommand] = useState(() => {
    try {
      return localStorage.getItem(TASK_DESK_COMMAND_KEY) || 'claude';
    } catch {
      return 'claude';
    }
  });
  const [model, setModel] = useState(cardModel ?? '');
  const { modelOptions } = useContext(DeskExtrasContext);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!pending) return;
    return transport.onMessage((msg) => {
      if (msg.type !== 'startAgentResult') return;
      setPending(false);
      setError(msg.ok ? null : (msg.error ?? 'Could not start the agent.'));
    });
  }, [pending]);

  const full = command.trim() || 'claude';
  return (
    <div
      className="flex flex-col gap-6 p-8 border border-warning bg-bg-dark"
      onKeyDown={(e) => e.stopPropagation()}
    >
      <span className="text-sm">Start an agent in this folder</span>
      <div className="flex gap-6">
        <input
          className={fieldClass}
          value={command}
          spellCheck={false}
          placeholder="claude"
          aria-label="Command"
          onChange={(e) => setCommand(e.target.value)}
          data-testid="desk-start-command"
        />
      </div>
      <ModelSelect
        options={modelOptions}
        value={model}
        onChange={setModel}
        className={fieldClass}
      />
      <span className="text-2xs text-text-muted break-all">
        Runs: {full} — an alias works as long as it runs Claude.
      </span>
      {error && <span className="text-2xs text-danger">{error}</span>}
      <Button
        size="sm"
        variant={pending ? 'disabled' : 'accent'}
        disabled={pending}
        onClick={() => {
          try {
            localStorage.setItem(TASK_DESK_COMMAND_KEY, command.trim() || 'claude');
          } catch {
            /* remembered only when storage is available */
          }
          setError(null);
          setPending(true);
          transport.send({
            type: 'startAgent',
            cwd: folder,
            command: full,
            firstMessage: TASK_DESK_FIRST_MESSAGE,
            ...(model ? { model } : {}),
          });
        }}
        data-testid="desk-start-agent"
      >
        {pending ? 'Starting…' : 'Start agent'}
      </Button>
    </div>
  );
}

function WhoMayLook({
  task,
  agents,
  labelOf,
  editable,
  onAllow,
  onPickup,
}: {
  task: DeskTask;
  agents: DeskAgent[];
  labelOf: (id: number) => string;
  editable: boolean;
  onAllow: (allow: number[]) => void;
  onPickup: (agentId: number, enabled: boolean) => void;
}) {
  const here = agentsInFolder(task, agents);
  const allowed = (id: number) => task.allow.length === 0 || task.allow.includes(id);
  const reachable = here.filter((a) => a.canReach);
  const toggle = (id: number) => {
    // Only agents the office can type into count as ticked (a read-only one only ever unticks).
    const ticked = (a: DeskAgent) => allowed(a.id) && (a.canReach || task.allow.includes(a.id));
    const next = here.filter((a) => (a.id === id ? !ticked(a) : ticked(a))).map((a) => a.id);
    // Every reachable agent ticked is stored as "anyone in the folder", so agents who join later count too.
    onAllow(
      reachable.length > 0 &&
        reachable.every((a) => next.includes(a.id)) &&
        next.every((n) => reachable.some((a) => a.id === n))
        ? []
        : next,
    );
  };
  return (
    <div className="flex flex-col gap-4 text-sm">
      <span className="text-2xs text-text-muted break-all">
        {task.folder.root}
        {task.folder.branch && ` · ${task.folder.branch}`}
        {task.folder.subPath && ` · you pointed at ${task.folder.subPath}`}
        {!task.folder.isGit && ' · not a git project: exact folder only'}
      </span>
      {here.map((agent) => (
        <div key={agent.id} className="flex gap-6 items-center flex-wrap">
          <label className="flex gap-4 items-center">
            <input
              type="checkbox"
              checked={allowed(agent.id) && (agent.canReach || task.allow.includes(agent.id))}
              // A read-only session can never take a card: it can be unticked, never ticked.
              disabled={!editable || (!agent.canReach && !task.allow.includes(agent.id))}
              title={
                agent.canReach
                  ? undefined
                  : 'The office cannot type into this session, so it cannot take cards.'
              }
              onChange={() => toggle(agent.id)}
            />
            {labelOf(agent.id)}
          </label>
          {branchMismatch(task, agent) && (
            <span className="text-2xs text-warning">on {agent.branch}</span>
          )}
          {!agent.canReach ? (
            <span className="text-2xs text-text-muted">read-only session</span>
          ) : (
            <label className="flex gap-4 items-center text-2xs text-text-muted ml-auto">
              <input
                type="checkbox"
                checked={agent.pickup}
                onChange={(e) => onPickup(agent.id, e.target.checked)}
                data-testid={`desk-pickup-${agent.id}`}
              />
              picks up cards
            </label>
          )}
        </div>
      ))}
    </div>
  );
}

/** The card's team, workflow and attached files, as the agent will see them. */
function CardLinks({ task }: { task: DeskTask }) {
  const { teams } = useContext(DeskExtrasContext);
  const deskWorkflows = useContext(DeskWorkflowsContext);
  if (!task.teamId && !task.workflowId && !task.model && !task.attachments?.length) return null;
  const team = task.teamId ? teams?.find((t) => t.id === task.teamId) : undefined;
  const workflow = task.workflowId
    ? deskWorkflows?.list.find((w) => w.id === task.workflowId)
    : undefined;
  return (
    <div className="flex flex-col gap-4 text-2xs" data-testid="desk-card-links">
      {task.teamId && (
        <span>
          <span className="text-text-muted">Team: </span>
          {team?.title ?? task.teamId}
          {task.crewId ? ' · running' : ''}
        </span>
      )}
      {task.workflowId && (
        <span>
          <span className="text-text-muted">Workflow: </span>
          {workflow ? `${workflow.title} (${workflow.steps.length} steps)` : task.workflowId}
        </span>
      )}
      {task.model && (
        <span>
          <span className="text-text-muted">Model: </span>
          {task.model}
        </span>
      )}
      {task.attachments && task.attachments.length > 0 && (
        <span className="flex flex-col gap-2">
          <span className="text-text-muted">Files:</span>
          {task.attachments.map((a) => (
            <span key={a.path} className="break-all" title={a.path}>
              {a.path}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

/** A builder that ended its turn asking you something (or stuck): what it said, and a reply box. */
function WaitingOnYou({
  task,
  agentId,
  desk,
  labelOf,
}: {
  task: DeskTask;
  agentId: number;
  desk: TaskDeskState;
  labelOf: (id: number) => string;
}) {
  const [text, setText] = useState('');
  const waiting = task.waitingOn!;
  const send = () => {
    if (!text.trim()) return;
    desk.reply(agentId, text.trim());
    setText('');
  };
  return (
    <div className="flex flex-col gap-4" data-testid="desk-waiting">
      <span className={sectionTitle}>
        {waiting.kind === 'question'
          ? `${labelOf(agentId)} asks you`
          : `${labelOf(agentId)} is stuck`}
      </span>
      <p className="m-0 text-sm whitespace-pre-wrap break-words">{waiting.text}</p>
      <textarea
        className={`${fieldClass} resize-none`}
        rows={2}
        value={text}
        placeholder="Your answer (typed into its session)"
        aria-label="Your answer"
        onChange={(e) => setText(e.target.value)}
        data-testid="desk-waiting-reply"
      />
      <Button
        size="sm"
        variant="accent"
        className="self-start"
        disabled={!text.trim()}
        onClick={send}
        data-testid="desk-waiting-send"
      >
        Send
      </Button>
    </div>
  );
}

function CardDetail({
  task,
  desk,
  labelOf,
  canStartAgents,
  folders,
}: {
  task: DeskTask;
  desk: TaskDeskState;
  labelOf: (id: number) => string;
  canStartAgents: boolean;
  folders: FolderSources;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const brief = task.briefs[task.briefs.length - 1];
  const judging = task.state === 'brief' || task.state === 'ready';
  const [note, setNote] = useState('');
  const [answers, setAnswers] = useState<string[]>(brief?.questions.map((q) => q.a) ?? []);
  const [subtasks, setSubtasks] = useState<DeskSubtask[]>(brief?.subtasks ?? []);
  const [needNote, setNeedNote] = useState(false);

  // A new brief (or a rebuilt one) replaces whatever was being edited.
  const briefKey = `${task.state}:${task.briefs.length}:${brief?.createdAt ?? ''}`;
  useEffect(() => {
    setAnswers(brief?.questions.map((q) => q.a) ?? []);
    setSubtasks(brief?.subtasks ?? []);
    setNote('');
    setNeedNote(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the brief's identity, not its object
  }, [briefKey]);

  // Mid-build the human edits a draft of the steps and saves it; before, the
  // edits ride the verify / do call like the answers do.
  const serverSteps = brief?.subtasks ?? [];
  const [draft, setDraft] = useState<DeskSubtask[]>(serverSteps);
  const stepsDirty = task.state === 'working' && !sameSteps(draft, serverSteps);
  const serverStepsKey = JSON.stringify(serverSteps);
  useEffect(() => {
    // The agent moved on (a step done, a gate reached): take the server's list
    // unless the human is mid-edit, in which case their locked prefix follows it.
    setDraft((current) =>
      sameSteps(current, serverSteps) || task.state !== 'working'
        ? serverSteps
        : [...serverSteps.slice(0, lockedStepCount(task)), ...current.slice(lockedStepCount(task))],
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the steps' content
  }, [serverStepsKey, task.state]);
  const deskWorkflows = useContext(DeskWorkflowsContext);
  const stepsEditable = judging || task.state === 'working';
  const locked = lockedStepCount(task);
  const shown = judging ? subtasks : task.state === 'working' ? draft : serverSteps;
  const setSteps = judging ? setSubtasks : setDraft;
  const stuck = stuckReason(task, desk.agents);
  const noAgentHere = agentsInFolder(task, desk.agents).length === 0;
  const fixes = stuckFixes(task, desk.agents);
  const send = (action: 'verified' | 'do' | 'rejected' | 'accept' | 'sendBack') => {
    if ((action === 'rejected' || action === 'sendBack') && !note.trim()) {
      setNeedNote(true);
      return;
    }
    desk.call(task.id, action, judging ? { note, answers, subtasks } : { note });
  };

  if (isEditing) {
    return (
      <div className="border-t-2 border-border">
        <CardForm desk={desk} {...folders} editing={task} onDone={() => setIsEditing(false)} />
      </div>
    );
  }

  return (
    <div
      className="flex flex-col gap-10 p-8 border-t-2 border-border"
      onKeyDown={(e) => e.stopPropagation()}
    >
      {task.state === 'draft' && (
        <div className="flex flex-col gap-4">
          <span className="text-2xs text-text-muted">
            A draft is yours alone: no agent looks at it until you send it to the desk.
          </span>
          <div className="flex gap-6">
            <Button
              size="sm"
              variant="accent"
              onClick={() => desk.call(task.id, 'publish')}
              data-testid="desk-publish"
            >
              Send to desk
            </Button>
            <Button size="sm" onClick={() => setIsEditing(true)} data-testid="desk-edit">
              Edit
            </Button>
          </div>
        </div>
      )}
      {task.state === 'inbox' && (
        <Button size="sm" className="self-start" onClick={() => setIsEditing(true)}>
          Edit card
        </Button>
      )}
      {task.body && (
        <p className="m-0 text-base text-text-muted whitespace-pre-wrap break-words">{task.body}</p>
      )}
      <CardLinks task={task} />

      {isWaitingOnYou(task) && task.claimedBy !== undefined && (
        <WaitingOnYou task={task} agentId={task.claimedBy} desk={desk} labelOf={labelOf} />
      )}

      <div className="flex flex-col gap-4">
        <span className={sectionTitle}>Folder · who may look</span>
        <WhoMayLook
          task={task}
          agents={desk.agents}
          labelOf={labelOf}
          editable={task.state === 'inbox' || judging}
          onAllow={(allow) => desk.setAllow(task.id, allow)}
          onPickup={desk.setPickup}
        />
        {fixes.allowAnyone && (
          <Button
            size="sm"
            className="self-start"
            onClick={() => desk.setAllow(task.id, [])}
            data-testid="desk-allow-anyone"
          >
            Let any agent here take it
          </Button>
        )}
        {stuck && (noAgentHere || fixes.startAgent) && canStartAgents && (
          <StartAgentHere folder={task.folder.root} cardModel={task.model} />
        )}
      </div>

      {task.result && (task.state === 'result' || task.state === 'done') && (
        <div className="flex flex-col gap-4">
          <span className={sectionTitle}>Result</span>
          <p className="m-0 text-sm whitespace-pre-wrap break-words">{task.result.summary}</p>
          <span className="text-2xs text-text-muted break-all">
            by {task.result.by}
            {task.result.branch && ` · branch ${task.result.branch}`}
            {task.result.diffStat && ` · ${task.result.diffStat}`}
            {task.result.tests && ` · tests: ${task.result.tests}`}
          </span>
        </div>
      )}

      {brief && task.state !== 'done' && (
        <div className="flex flex-col gap-6">
          <span className={sectionTitle}>
            Agent brief{task.state === 'inbox' ? ' (rejected)' : ''}
          </span>
          <BriefView brief={brief} />

          {(shown.length > 0 || stepsEditable) && (
            <DeskSteps
              taskNum={task.num}
              steps={shown}
              locked={locked}
              onChange={stepsEditable ? setSteps : undefined}
              onAnswerGate={
                task.state === 'working'
                  ? (step, decision) => desk.answerGate(task.id, step, decision)
                  : undefined
              }
            />
          )}
          {stepsEditable && (
            <div className="flex flex-wrap gap-6 items-center">
              {task.state === 'working' && stepsDirty && (
                <>
                  <Button
                    size="sm"
                    variant="accent"
                    onClick={() => desk.editSteps(task.id, draft)}
                    data-testid="desk-steps-save"
                  >
                    Save steps
                  </Button>
                  <Button size="sm" onClick={() => setDraft(serverSteps)}>
                    Undo changes
                  </Button>
                  <span className="text-2xs text-text-muted">
                    The agent sees them on its next step report.
                  </span>
                </>
              )}
              {deskWorkflows && (
                <>
                  <Button
                    size="sm"
                    onClick={() =>
                      deskWorkflows.save({
                        id: '',
                        title: task.title,
                        steps: stepsToWorkflow(shown),
                      })
                    }
                    disabled={shown.length === 0}
                    title="Save these steps as a workflow you can reuse"
                  >
                    Save as workflow
                  </Button>
                  {deskWorkflows.list.length > 0 && (
                    <select
                      className="bg-bg-dark text-text text-sm border border-border rounded-ui px-4"
                      value=""
                      aria-label="Load steps from a workflow"
                      onChange={(e) => {
                        const workflow = deskWorkflows.list.find((w) => w.id === e.target.value);
                        if (!workflow) return;
                        setSteps([...shown.slice(0, locked), ...workflowToSteps(workflow.steps)]);
                      }}
                    >
                      <option value="">Load workflow…</option>
                      {deskWorkflows.list.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.title} ({w.steps.length})
                        </option>
                      ))}
                    </select>
                  )}
                </>
              )}
            </div>
          )}

          {brief.questions.map((question, index) => (
            <label key={index} className="flex flex-col gap-2 text-sm">
              <span className="text-accent-bright">{question.q}</span>
              {judging ? (
                <input
                  className={fieldClass}
                  value={answers[index] ?? ''}
                  maxLength={TASK_NOTE_MAX_CHARS}
                  placeholder="Your answer (optional)"
                  onChange={(e) =>
                    setAnswers((list) => {
                      const next = [...list];
                      next[index] = e.target.value;
                      return next;
                    })
                  }
                />
              ) : (
                <span className="text-text-muted">{question.a || 'not answered'}</span>
              )}
            </label>
          ))}
        </div>
      )}

      {(judging || task.state === 'result') && (
        <div className="flex flex-col gap-6">
          <textarea
            className={`${fieldClass} resize-none`}
            rows={2}
            value={note}
            maxLength={TASK_NOTE_MAX_CHARS}
            placeholder={
              task.state === 'result'
                ? 'Your note (required to send back)'
                : 'Your note (required for Rejected)'
            }
            aria-label="Your note"
            onChange={(e) => {
              setNote(e.target.value);
              setNeedNote(false);
            }}
            data-testid="desk-note"
          />
          {needNote && (
            <span className="text-2xs text-danger">
              Say what is missing — the agent only has your reason to go on.
            </span>
          )}
          {task.state === 'result' ? (
            <div className="flex gap-6">
              <Button
                size="sm"
                variant="accent"
                onClick={() => send('accept')}
                data-testid="desk-accept"
              >
                Accept
              </Button>
              <Button size="sm" className="ml-auto" onClick={() => send('sendBack')}>
                Send back
              </Button>
            </div>
          ) : (
            <div className="flex gap-6 flex-wrap">
              <Button
                size="sm"
                variant={task.queued ? 'disabled' : 'accent'}
                disabled={task.queued}
                onClick={() => send('do')}
                title="Build from this brief, your note and answers"
                data-testid="desk-do"
              >
                Do the task
              </Button>
              {task.state === 'brief' && (
                <Button
                  size="sm"
                  onClick={() => send('verified')}
                  title="The brief is right. Park it; nothing starts."
                  data-testid="desk-verified"
                >
                  Verified
                </Button>
              )}
              <Button
                size="sm"
                className="ml-auto"
                onClick={() => send('rejected')}
                title="Back to the inbox: the next free agent re-details what is missing"
                data-testid="desk-rejected"
              >
                Rejected
              </Button>
            </div>
          )}
        </div>
      )}

      {task.log.length > 0 && (
        <details className="text-2xs text-text-muted">
          <summary className="cursor-pointer">History ({task.log.length})</summary>
          <div className="flex flex-col gap-2 pt-4">
            {task.log.map((entry, index) => (
              <span key={index} className="break-words whitespace-pre-wrap">
                <span className="text-text">{entry.who}</span> — {entry.text}
              </span>
            ))}
          </div>
        </details>
      )}
      {task.state !== 'looking' && task.state !== 'working' && (
        <button
          className="self-end bg-transparent border-0 p-0 underline cursor-pointer text-2xs text-text-muted"
          onClick={() => desk.removeCard(task.id)}
        >
          Remove card
        </button>
      )}
    </div>
  );
}

function Card({
  task,
  isOpen,
  onOpen,
  desk,
  labelOf,
  canStartAgents,
  folders,
  inline = true,
  onDragChange,
}: {
  task: DeskTask;
  isOpen: boolean;
  onOpen: () => void;
  desk: TaskDeskState;
  labelOf: (id: number) => string;
  canStartAgents: boolean;
  folders: FolderSources;
  /** Rail: the detail unfolds under the card. Full board: it opens beside the columns instead. */
  inline?: boolean;
  /** A drag of this card started (true) or ended (false). */
  onDragChange?: (dragging: boolean) => void;
}) {
  const yours = needsYou(task);
  const progress = subtaskProgress(task);
  const stuck = stuckReason(task, desk.agents);
  const who =
    task.claimedBy !== undefined && (task.state === 'looking' || task.state === 'working')
      ? labelOf(task.claimedBy)
      : null;
  return (
    <div
      className={`flex flex-col border shadow-pixel ${
        isOpen && !inline ? 'bg-active-bg border-accent' : 'bg-bg'
      } ${isOpen && !inline ? '' : yours ? 'border-status-permission' : 'border-border'}`}
      data-testid={`desk-card-${task.num}`}
    >
      <button
        className="flex flex-col gap-4 p-8 text-left bg-transparent border-0 text-text cursor-pointer"
        onClick={onOpen}
        aria-expanded={isOpen}
        // Only the header drags, so text in the open card stays selectable.
        // Drop on a board column to move the card, or on a character to give it to that agent.
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(DESK_CARD_DRAG_MIME, task.id);
          e.dataTransfer.effectAllowed = 'copyMove';
          onDragChange?.(true);
        }}
        onDragEnd={() => onDragChange?.(false)}
        title="Drag onto a column to move it, or onto a character to give it to that agent"
      >
        <span className="text-sm leading-tight break-words">
          <span className="text-text-muted">
            [{KIND_TAG[task.kind]}] #{task.num}
          </span>{' '}
          {task.title}
        </span>
        <span className="flex flex-wrap gap-4 items-center text-2xs text-text-muted">
          <span
            className={`${chip} ${yours ? 'border-status-permission text-status-permission' : 'border-border'}`}
          >
            {stateLabel(task)}
          </span>
          <span className={`${chip} border-border`}>{task.folder.name}</span>
          {task.priority === 'p1' && (
            <span className={`${chip} border-warning text-warning`}>P1</span>
          )}
          {task.round > 1 && (
            <span className={`${chip} border-status-permission text-status-permission`}>
              round {task.round}
            </span>
          )}
          {task.teamId && <span className={`${chip} border-border`}>team</span>}
          {task.workflowId && <span className={`${chip} border-border`}>workflow</span>}
          {task.attachments && task.attachments.length > 0 && (
            <span className={`${chip} border-border`}>📎{task.attachments.length}</span>
          )}
          {progress && task.state !== 'inbox' && <span>{progress} steps</span>}
          {who && <span>{who}</span>}
        </span>
        {stuck && <span className="text-2xs text-warning">{stuck}</span>}
      </button>
      {isOpen && inline && (
        <CardDetail
          task={task}
          desk={desk}
          labelOf={labelOf}
          canStartAgents={canStartAgents}
          folders={folders}
        />
      )}
    </div>
  );
}

// ── Filter ───────────────────────────────────────────────────

function FilterBar({
  filter,
  onChange,
  tasks,
  agents,
  labelOf,
  shown,
}: {
  filter: DeskFilter;
  onChange: (filter: DeskFilter) => void;
  tasks: DeskTask[];
  agents: DeskAgent[];
  labelOf: (id: number) => string;
  /** How many cards pass the filter. */
  shown: number;
}) {
  const selectClass = `${fieldClass} w-auto flex-1 min-w-[120px]`;
  return (
    <div
      className="flex flex-wrap gap-6 items-center px-10 py-6 border-b-2 border-border bg-bg-dark"
      onKeyDown={(e) => e.stopPropagation()}
      data-testid="desk-filter"
    >
      <input
        className={`${fieldClass} flex-[2] min-w-[160px] w-auto`}
        type="search"
        value={filter.text}
        placeholder="Search title, details, brief, #number"
        aria-label="Search cards"
        onChange={(e) => onChange({ ...filter, text: e.target.value })}
        data-testid="desk-filter-text"
      />
      <select
        className={selectClass}
        value={filter.kind}
        aria-label="Kind"
        onChange={(e) => onChange({ ...filter, kind: e.target.value as DeskFilter['kind'] })}
      >
        <option value="all">Any kind</option>
        {KINDS.map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </select>
      <select
        className={selectClass}
        value={filter.folder}
        aria-label="Folder"
        onChange={(e) => onChange({ ...filter, folder: e.target.value })}
      >
        <option value="all">Any folder</option>
        {cardFolders(tasks).map((f) => (
          <option key={f.root} value={f.root}>
            {f.name}
          </option>
        ))}
      </select>
      <select
        className={selectClass}
        value={filter.priority}
        aria-label="Priority"
        onChange={(e) =>
          onChange({ ...filter, priority: e.target.value as DeskFilter['priority'] })
        }
      >
        <option value="all">Any priority</option>
        <option value="p1">P1 only</option>
        <option value="p2">Normal only</option>
      </select>
      <select
        className={selectClass}
        value={String(filter.agent)}
        aria-label="Agent"
        onChange={(e) =>
          onChange({ ...filter, agent: e.target.value === 'all' ? 'all' : Number(e.target.value) })
        }
      >
        <option value="all">Any agent</option>
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {labelOf(a.id)}
          </option>
        ))}
      </select>
      <span className="text-2xs text-text-muted">
        {shown} of {tasks.length}
      </span>
      {isFiltering(filter) && (
        <Button size="sm" onClick={() => onChange(NO_FILTER)} data-testid="desk-filter-clear">
          Clear
        </Button>
      )}
    </div>
  );
}

// ── The rail ─────────────────────────────────────────────────

/**
 * The task desk: cards people add, which free agents look at and — once a
 * human says so — build. A rail on the left edge, mirroring the whiteboard on
 * the right; closed, it folds into a tab that counts what is waiting on you.
 * "Full board" swaps the rail for every column at once, with the open card
 * beside them. Both views share one search + filter.
 */
export function TaskDesk(props: TaskDeskProps) {
  const { workflows, onSaveWorkflow, teams, modelOptions } = props;
  const value = useMemo(
    () => (workflows && onSaveWorkflow ? { list: workflows, save: onSaveWorkflow } : null),
    [workflows, onSaveWorkflow],
  );
  const extras = useMemo(
    () => ({ teams: teams ?? null, modelOptions: modelOptions ?? [] }),
    [teams, modelOptions],
  );
  return (
    <DeskWorkflowsContext.Provider value={value}>
      <DeskExtrasContext.Provider value={extras}>
        <DeskPanel {...props} />
      </DeskExtrasContext.Provider>
    </DeskWorkflowsContext.Provider>
  );
}

function DeskPanel({
  isOpen,
  onToggle,
  desk,
  labelOf,
  canBrowseFolders,
  recentFolders,
  workspaceFolders,
  canStartAgents,
}: TaskDeskProps) {
  const [isAdding, setIsAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [isFull, setIsFull] = useState(false);
  const [editingFlow, setEditingFlow] = useState(false);
  /** The board section under a dragged card (a column of yours). */
  const [overSection, setOverSection] = useState<string | null>(null);
  const [showFilter, setShowFilter] = useState(false);
  const [filter, setFilter] = useState<DeskFilter>(NO_FILTER);
  /** The card being dragged, and the board column under it. */
  const [dragId, setDragId] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<string | null>(null);
  // The tab counts EVERY card waiting on you; a filter must not hide work from the closed desk.
  const waiting = deskSections(desk.tasks).needsYou.length;
  const cards = filterCards(desk.tasks, filter);
  const filtering = isFiltering(filter);

  if (!isOpen) {
    return (
      <button
        onClick={onToggle}
        aria-label={`Open task desk, ${waiting} waiting on you`}
        className={`absolute left-0 top-1/2 -translate-y-1/2 z-30 px-4 py-16 text-xs border border-l-0 rounded-ui cursor-pointer bg-bg shadow-pixel ${
          waiting > 0
            ? 'border-status-permission text-status-permission'
            : 'border-border text-text'
        }`}
        style={{ writingMode: 'vertical-rl' }}
        data-testid="desk-tab"
      >
        DESK · {waiting}
      </button>
    );
  }

  const folders: FolderSources = { canBrowseFolders, recentFolders, workspaceFolders };
  const toggleCard = (id: string) => setOpenId((open) => (open === id ? null : id));
  const card = (task: DeskTask, inline: boolean) => (
    <Card
      key={task.id}
      task={task}
      isOpen={openId === task.id}
      onOpen={() => toggleCard(task.id)}
      desk={desk}
      labelOf={labelOf}
      canStartAgents={canStartAgents}
      folders={folders}
      inline={inline}
      onDragChange={(dragging) => {
        setDragId(dragging ? task.id : null);
        if (!dragging) setOverColumn(null);
        setDropHint(null);
      }}
    />
  );
  const dragged = dragId ? desk.tasks.find((t) => t.id === dragId) : undefined;
  const dropOn = (task: DeskTask, column: DeskColumn['key']) => {
    const drop = dropAction(task, column);
    if (!drop) return;
    if ('action' in drop) {
      desk.call(task.id, drop.action);
      return;
    }
    // Rejecting a brief or sending a result back needs a reason: open the card for it.
    setOpenId(task.id);
    setDropHint(
      drop.needsNote === 'rejected'
        ? `Card #${task.num}: say why the brief is wrong, then press Reject.`
        : `Card #${task.num}: say what to change, then press Send back.`,
    );
  };

  const header = (
    <div className="flex items-start gap-8 p-10 border-b-2 border-border">
      <div className="flex flex-col gap-2 flex-1 min-w-0">
        <span className="text-lg leading-none">TASK DESK</span>
        <span className="text-2xs text-text-muted">
          Free agents look at new cards. Nothing is built until you say so.
        </span>
      </div>
      <Button
        size="sm"
        variant={isAdding ? 'active' : 'default'}
        onClick={() => setIsAdding((v) => !v)}
      >
        + Card
      </Button>
      {!isFull && (
        <Button
          size="sm"
          variant={showFilter || filtering ? 'active' : 'default'}
          onClick={() => setShowFilter((v) => !v)}
          title="Search and filter cards"
          data-testid="desk-filter-toggle"
        >
          Filter
        </Button>
      )}
      {isFull && (
        <Button
          size="sm"
          onClick={() => setEditingFlow(true)}
          title="Split the board's states into your own columns; Laya moves cards between them"
          data-testid="desk-flow-edit"
        >
          Columns
        </Button>
      )}
      <Button
        size="sm"
        onClick={() => setIsFull((v) => !v)}
        title={isFull ? 'Back to the side rail' : 'Open the whole board: every column at once'}
        data-testid="desk-full-toggle"
      >
        {isFull ? 'Side rail' : 'Full board'}
      </Button>
      <button
        onClick={onToggle}
        aria-label="Close task desk"
        className="bg-transparent border-0 text-text cursor-pointer text-lg leading-none p-0"
      >
        ×
      </button>
    </div>
  );

  const notice = desk.notice && (
    <span className="px-10 py-4 text-2xs text-danger border-b-2 border-border" role="alert">
      {desk.notice}
    </span>
  );
  const filterBar = (
    <FilterBar
      filter={filter}
      onChange={setFilter}
      tasks={desk.tasks}
      agents={desk.agents}
      labelOf={labelOf}
      shown={cards.length}
    />
  );
  const form = isAdding && (
    <CardForm
      desk={desk}
      canBrowseFolders={canBrowseFolders}
      recentFolders={recentFolders}
      workspaceFolders={workspaceFolders}
      onDone={() => setIsAdding(false)}
    />
  );
  const stop = {
    onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
    onWheel: (e: React.WheelEvent) => e.stopPropagation(),
  };

  if (isFull) {
    const columns = deskColumns(cards);
    const sections = (column: (typeof columns)[number]) => subColumns(column, desk.flow);
    const open = desk.tasks.find((t) => t.id === openId);
    return (
      <section
        aria-label="Task desk, full board"
        className="absolute inset-0 z-40 flex flex-col bg-bg text-text"
        data-testid="desk-board"
        {...stop}
      >
        {header}
        {editingFlow && (
          <DeskFlowEditor
            columns={desk.flow}
            onSave={desk.saveFlow}
            onClose={() => setEditingFlow(false)}
          />
        )}
        {notice}
        {dropHint && (
          <span
            className="px-10 py-4 text-2xs text-status-permission border-b-2 border-border"
            role="status"
          >
            {dropHint}
          </span>
        )}
        {filterBar}
        <div className="flex-1 min-h-0 flex">
          {isAdding && (
            <div
              className="shrink-0 border-r-2 border-border overflow-y-auto"
              style={{ width: `min(${tunable('taskDeskWidthPx')}px, 100%)` }}
            >
              {form}
            </div>
          )}
          <div className="flex-1 min-w-0 overflow-auto p-10">
            <div
              className="grid gap-8 items-start h-full"
              style={{
                gridTemplateColumns: `repeat(${columns.length}, minmax(${tunable('taskDeskColumnMinPx')}px, 1fr))`,
              }}
            >
              {columns.map((column) => {
                const canDrop = !!dragged && dropAction(dragged, column.key) !== null;
                return (
                  <div
                    key={column.key}
                    className={`flex flex-col border bg-bg-dark max-h-full ${
                      canDrop
                        ? overColumn === column.key
                          ? 'border-accent bg-active-bg'
                          : 'border-dashed border-accent'
                        : column.yours
                          ? 'border-status-permission'
                          : 'border-border'
                    } ${dragged && !canDrop ? 'opacity-60' : ''}`}
                    data-testid={`desk-column-${column.key}`}
                    onDragOver={(e) => {
                      if (!canDrop || !e.dataTransfer.types.includes(DESK_CARD_DRAG_MIME)) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                      setOverColumn(column.key);
                    }}
                    onDragLeave={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                        setOverColumn((c) => (c === column.key ? null : c));
                    }}
                    onDrop={(e) => {
                      const id = e.dataTransfer.getData(DESK_CARD_DRAG_MIME);
                      const task = desk.tasks.find((t) => t.id === id);
                      setDragId(null);
                      setOverColumn(null);
                      if (!task) return;
                      e.preventDefault();
                      dropOn(task, column.key);
                    }}
                  >
                    <div
                      className={`flex flex-col gap-2 px-8 py-6 border-b-2 ${
                        column.yours
                          ? 'border-status-permission bg-chat-permission text-status-permission'
                          : 'border-border bg-bg-thumb'
                      }`}
                    >
                      <span className="text-sm leading-none">
                        {column.title} · {column.tasks.length}
                      </span>
                      <span className="text-2xs text-text-muted">{column.hint}</span>
                    </div>
                    <div className="flex flex-col gap-6 p-8 overflow-y-auto">
                      {column.tasks.length === 0 && sections(column).length === 0 && (
                        <span className="text-2xs text-text-muted">
                          {filtering ? 'Nothing matches.' : 'Nothing here.'}
                        </span>
                      )}
                      {sections(column).length === 0
                        ? column.tasks.map((task) => card(task, false))
                        : sections(column).map((section) => {
                            const key = section.def?.id ?? '__own';
                            const draggedTask = dragged;
                            const canMove =
                              !!section.def &&
                              !!draggedTask &&
                              draggedTask.state === section.def.phase &&
                              draggedTask.column !== section.def.id;
                            return (
                              <div
                                key={key}
                                className={`flex flex-col gap-6 p-4 rounded-ui border ${
                                  canMove && overSection === key
                                    ? 'border-accent bg-active-bg'
                                    : canMove
                                      ? 'border-dashed border-accent'
                                      : 'border-transparent'
                                }`}
                                data-testid={`desk-section-${key}`}
                                onDragOver={(e) => {
                                  if (!canMove) return;
                                  e.preventDefault();
                                  e.stopPropagation();
                                  e.dataTransfer.dropEffect = 'move';
                                  setOverSection(key);
                                }}
                                onDragLeave={() => setOverSection((s) => (s === key ? null : s))}
                                onDrop={(e) => {
                                  if (!canMove || !section.def || !draggedTask) return;
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setDragId(null);
                                  setOverSection(null);
                                  desk.setColumn(draggedTask.id, section.def.id);
                                }}
                              >
                                {section.def && (
                                  <span
                                    className="text-2xs uppercase tracking-wider text-text-muted"
                                    title={section.def.description}
                                  >
                                    {section.def.name} · {section.tasks.length}
                                    {section.def.laya ? ' · Laya' : ''}
                                  </span>
                                )}
                                {section.tasks.map((task) => card(task, false))}
                              </div>
                            );
                          })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          {open && (
            <aside
              aria-label={`Card #${open.num}`}
              className="shrink-0 flex flex-col border-l-4 border-accent bg-bg overflow-y-auto"
              style={{ width: `min(${tunable('taskDeskWidthPx')}px, 100%)` }}
              data-testid="desk-board-detail"
            >
              <div className="flex items-start gap-8 p-10">
                <span className="flex-1 text-base leading-tight break-words">
                  <span className="text-text-muted">#{open.num}</span> {open.title}
                </span>
                <button
                  onClick={() => setOpenId(null)}
                  aria-label="Close card"
                  className="bg-transparent border-0 text-text cursor-pointer text-lg leading-none p-0"
                >
                  ×
                </button>
              </div>
              <CardDetail
                task={open}
                desk={desk}
                labelOf={labelOf}
                canStartAgents={canStartAgents}
                folders={folders}
              />
            </aside>
          )}
        </div>
      </section>
    );
  }

  const sections = deskSections(cards);
  const list = (title: string, tasks: DeskTask[], empty: string) => (
    <div className="flex flex-col gap-6">
      <span className={sectionTitle}>
        {title} · {tasks.length}
      </span>
      {tasks.length === 0 && (
        <span className="text-2xs text-text-muted">{filtering ? 'Nothing matches.' : empty}</span>
      )}
      {tasks.map((task) => card(task, true))}
    </div>
  );

  return (
    <aside
      aria-label="Task desk"
      className="absolute left-0 top-0 bottom-0 z-30 flex flex-col bg-bg text-text border-r-4 border-border"
      style={{ width: `min(${tunable('taskDeskWidthPx')}px, 100%)` }}
      data-testid="desk-rail"
      {...stop}
    >
      {header}
      {notice}
      {(showFilter || filtering) && filterBar}
      {form}
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-16 p-10">
        {list('Needs you', sections.needsYou, 'Nothing is waiting on you.')}
        {sections.drafts.length > 0 && list('Drafts', sections.drafts, '')}
        {list('With agents', sections.inFlight, 'No open cards. Add one with + Card.')}
        {sections.done.length > 0 && (
          <details>
            <summary className={`${sectionTitle} cursor-pointer`}>
              Done · {sections.done.length}
            </summary>
            <div className="flex flex-col gap-6 pt-6">
              {sections.done.map((task) => card(task, true))}
            </div>
          </details>
        )}
      </div>
    </aside>
  );
}
