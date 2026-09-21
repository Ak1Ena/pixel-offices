import { useEffect, useState } from 'react';

import type {
  DeskAgent,
  DeskBrief,
  DeskSubtask,
  DeskTask,
  DeskTaskKind,
  DeskTaskPriority,
} from '../../../core/src/messages.js';
import {
  TASK_BODY_MAX_CHARS,
  TASK_DESK_COLUMN_MIN_PX,
  TASK_DESK_COMMAND_KEY,
  TASK_DESK_FIRST_MESSAGE,
  TASK_DESK_MODELS,
  TASK_DESK_WIDTH_PX,
  TASK_NOTE_MAX_CHARS,
  TASK_SUBTASK_MAX_CHARS,
  TASK_TITLE_MAX_CHARS,
} from '../constants.js';
import type { TaskDeskState } from '../hooks/useTaskDesk.js';
import {
  agentsInFolder,
  branchMismatch,
  cardFolders,
  deskColumns,
  type DeskFilter,
  deskSections,
  filterCards,
  isFiltering,
  needsYou,
  NO_FILTER,
  STATE_LABEL,
  stuckReason,
  subtaskProgress,
} from '../taskDesk.js';
import { transport } from '../transport/index.js';
import { FolderPicker } from './FolderPicker.js';
import { Button } from './ui/Button.js';

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
}

const KINDS: DeskTaskKind[] = ['task', 'issue', 'feature'];
const KIND_TAG: Record<DeskTaskKind, string> = { task: 'T', issue: '!', feature: '+' };

const fieldClass =
  'w-full px-8 py-4 bg-bg-dark text-text text-sm border-2 border-border rounded-none outline-none focus:border-accent';
const sectionTitle = 'text-xs text-text-muted uppercase tracking-wider';
const chip = 'px-4 text-2xs border-2 leading-tight';

// ── Add a card ───────────────────────────────────────────────

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
  const canAdd = title.trim().length > 0 && folder.trim().length > 0;
  const save = (draft: boolean) => {
    if (!canAdd) return;
    desk.saveCard({
      kind,
      title: title.trim(),
      body: body.trim(),
      priority,
      folder,
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
      <textarea
        className={`${fieldClass} resize-none`}
        rows={3}
        value={body}
        maxLength={TASK_BODY_MAX_CHARS}
        placeholder="What you know so far (optional)"
        aria-label="Card details"
        onChange={(e) => setBody(e.target.value)}
      />
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

function StartAgentHere({ folder }: { folder: string }) {
  const [command, setCommand] = useState(() => {
    try {
      return localStorage.getItem(TASK_DESK_COMMAND_KEY) || 'claude';
    } catch {
      return 'claude';
    }
  });
  const [model, setModel] = useState<string>(TASK_DESK_MODELS[0].flag);
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

  const full = `${command.trim() || 'claude'}${model ? ` --model ${model}` : ''}`;
  return (
    <div
      className="flex flex-col gap-6 p-8 border-2 border-warning bg-bg-dark"
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
        <select
          className={fieldClass}
          value={model}
          aria-label="Model"
          onChange={(e) => setModel(e.target.value)}
        >
          {TASK_DESK_MODELS.map((m) => (
            <option key={m.label} value={m.flag}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
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
  const toggle = (id: number) => {
    const next = here.filter((a) => (a.id === id ? !allowed(id) : allowed(a.id))).map((a) => a.id);
    // Everyone ticked is stored as "anyone in the folder", so agents who join later count too.
    onAllow(next.length === here.length ? [] : next);
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
              checked={allowed(agent.id)}
              disabled={!editable}
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
  const [newSub, setNewSub] = useState('');
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

  const shown = judging ? subtasks : (brief?.subtasks ?? []);
  const stuck = stuckReason(task, desk.agents);
  const noAgentHere = agentsInFolder(task, desk.agents).length === 0;
  const send = (action: 'verified' | 'do' | 'rejected' | 'accept' | 'sendBack') => {
    if ((action === 'rejected' || action === 'sendBack') && !note.trim()) {
      setNeedNote(true);
      return;
    }
    desk.call(task.id, action, judging ? { note, answers, subtasks } : { note });
  };
  const addSubtask = () => {
    const title = newSub.trim();
    if (!title) return;
    setSubtasks((list) => [...list, { title, skip: false, done: false, by: 'you' }]);
    setNewSub('');
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
        <p className="m-0 text-sm text-text-muted whitespace-pre-wrap break-words">{task.body}</p>
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
        {stuck && noAgentHere && canStartAgents && <StartAgentHere folder={task.folder.root} />}
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

          {shown.length > 0 && (
            <div className="flex flex-col gap-2" data-testid="desk-subtasks">
              <span className="text-2xs text-text-muted">Subtasks · linked to #{task.num}</span>
              {shown.map((sub, index) => (
                <label
                  key={index}
                  className={`flex gap-6 items-start text-sm px-6 py-2 border-2 ${
                    sub.done ? 'border-status-success' : 'border-border'
                  } ${sub.skip ? 'opacity-50 line-through' : ''}`}
                >
                  {judging && (
                    <input
                      type="checkbox"
                      checked={!sub.skip}
                      aria-label={`Include subtask ${index + 1}`}
                      onChange={() =>
                        setSubtasks((list) =>
                          list.map((s, i) => (i === index ? { ...s, skip: !s.skip } : s)),
                        )
                      }
                    />
                  )}
                  <span className="text-text-muted">
                    #{task.num}.{index + 1}
                  </span>
                  <span className="flex-1 break-words">
                    {sub.title}
                    {sub.by === 'you' && <span className="text-text-muted"> (yours)</span>}
                  </span>
                  <span className="text-2xs text-text-muted">
                    {sub.skip ? 'skipped' : sub.done ? 'done' : ''}
                  </span>
                </label>
              ))}
            </div>
          )}
          {judging && (
            <div className="flex gap-6">
              <input
                className={fieldClass}
                value={newSub}
                maxLength={TASK_SUBTASK_MAX_CHARS}
                placeholder="Add a subtask the agent missed"
                aria-label="New subtask"
                onChange={(e) => setNewSub(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addSubtask();
                  }
                }}
              />
              <Button size="sm" onClick={addSubtask}>
                Add
              </Button>
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
      className={`flex flex-col border-2 shadow-pixel ${
        isOpen && !inline ? 'bg-active-bg border-accent' : 'bg-bg'
      } ${isOpen && !inline ? '' : yours ? 'border-status-permission' : 'border-border'}`}
      data-testid={`desk-card-${task.num}`}
    >
      <button
        className="flex flex-col gap-4 p-8 text-left bg-transparent border-0 text-text cursor-pointer"
        onClick={onOpen}
        aria-expanded={isOpen}
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
            {task.state === 'ready' && task.queued ? 'Queued' : STATE_LABEL[task.state]}
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
          {progress && task.state !== 'inbox' && <span>{progress} subtasks</span>}
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
export function TaskDesk({
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
  const [showFilter, setShowFilter] = useState(false);
  const [filter, setFilter] = useState<DeskFilter>(NO_FILTER);
  // The tab counts EVERY card waiting on you; a filter must not hide work from the closed desk.
  const waiting = deskSections(desk.tasks).needsYou.length;
  const cards = filterCards(desk.tasks, filter);
  const filtering = isFiltering(filter);

  if (!isOpen) {
    return (
      <button
        onClick={onToggle}
        aria-label={`Open task desk, ${waiting} waiting on you`}
        className={`absolute left-0 top-1/2 -translate-y-1/2 z-30 px-4 py-16 text-xs border-2 border-l-0 rounded-none cursor-pointer bg-bg shadow-pixel ${
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
    />
  );

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
    const open = desk.tasks.find((t) => t.id === openId);
    return (
      <section
        aria-label="Task desk, full board"
        className="absolute inset-0 z-40 flex flex-col bg-bg text-text"
        data-testid="desk-board"
        {...stop}
      >
        {header}
        {notice}
        {filterBar}
        <div className="flex-1 min-h-0 flex">
          {isAdding && (
            <div
              className="shrink-0 border-r-2 border-border overflow-y-auto"
              style={{ width: `min(${TASK_DESK_WIDTH_PX}px, 100%)` }}
            >
              {form}
            </div>
          )}
          <div className="flex-1 min-w-0 overflow-auto p-10">
            <div
              className="grid gap-8 items-start h-full"
              style={{
                gridTemplateColumns: `repeat(${columns.length}, minmax(${TASK_DESK_COLUMN_MIN_PX}px, 1fr))`,
              }}
            >
              {columns.map((column) => (
                <div
                  key={column.key}
                  className={`flex flex-col border-2 bg-bg-dark max-h-full ${
                    column.yours ? 'border-status-permission' : 'border-border'
                  }`}
                  data-testid={`desk-column-${column.key}`}
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
                    {column.tasks.length === 0 && (
                      <span className="text-2xs text-text-muted">
                        {filtering ? 'Nothing matches.' : 'Nothing here.'}
                      </span>
                    )}
                    {column.tasks.map((task) => card(task, false))}
                  </div>
                </div>
              ))}
            </div>
          </div>
          {open && (
            <aside
              aria-label={`Card #${open.num}`}
              className="shrink-0 flex flex-col border-l-4 border-accent bg-bg overflow-y-auto"
              style={{ width: `min(${TASK_DESK_WIDTH_PX}px, 100%)` }}
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
      style={{ width: `min(${TASK_DESK_WIDTH_PX}px, 100%)` }}
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
