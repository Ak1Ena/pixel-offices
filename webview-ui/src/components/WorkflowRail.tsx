import { useEffect, useState } from 'react';

import type {
  Workflow,
  WorkflowDraft,
  WorkflowRun,
  WorkflowStep,
  WorkflowStepKind,
} from '../../../core/src/messages.js';
import { WORKFLOW_DRAG_MIME } from '../constants.js';
import { downloadText } from '../download.js';
import { fileSlug } from '../teams.js';
import { tunable } from '../tunableStore.js';
import { moveStep, previewMarkdown, runProgress } from '../workflows.js';
import { FolderField } from './FolderField.js';
import { Button } from './ui/Button.js';

interface WorkflowRailProps {
  workflows: Workflow[];
  runs: WorkflowRun[];
  /** Agents that can be given a workflow (the office can type to them). */
  agents: Array<{ id: number; label: string }>;
  labelOf: (agentId: number) => string;
  /** Absent for view-only connections. */
  onSave?: (workflow: Workflow) => void;
  onDelete?: (workflowId: string) => void;
  onAttach?: (agentId: number, workflowId: string) => void;
  onStopRun?: (runId: string) => void;
  notice: string | null;
  onClearNotice: () => void;
  onClose: () => void;
  /** Save a workflow from an exported .md file. */
  onImport?: (markdown: string) => void;
  /** Ask AI for a draft; the answer lands in `drafts[requestId]`. */
  onDraft?: (req: {
    requestId: string;
    description: string;
    folder?: string;
    readProject?: boolean;
    previous?: Workflow;
    change?: string;
  }) => void;
  drafts: Record<string, WorkflowDraft>;
  folders: string[];
  /** The folder browser works here (standalone, tokened page). */
  canBrowseFolders: boolean;
}

const KINDS: Array<{ kind: WorkflowStepKind; label: string; hint: string; color: string }> = [
  {
    kind: 'do',
    label: 'do',
    hint: 'The agent does it, then marks it done',
    color: 'text-status-active border-status-active',
  },
  {
    kind: 'show',
    label: 'show',
    hint: 'The agent shows you a file and waits for you',
    color: 'text-status-success border-status-success',
  },
  {
    kind: 'gate',
    label: 'gate',
    hint: 'The agent stops until you say go ahead',
    color: 'text-status-permission border-status-permission',
  },
];

function kindClass(kind: WorkflowStepKind): string {
  return KINDS.find((k) => k.kind === kind)?.color ?? '';
}

function Editor({
  initial,
  unsure = [],
  onSave,
  onCancel,
  onDelete,
}: {
  initial: Workflow;
  /** 1-based steps an AI draft guessed: drawn dashed until edited. */
  unsure?: number[];
  onSave?: (workflow: Workflow) => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const [guessed, setGuessed] = useState<ReadonlySet<number>>(
    () => new Set(unsure.map((n) => n - 1)),
  );
  const [title, setTitle] = useState(initial.title);
  const [steps, setSteps] = useState<WorkflowStep[]>(
    initial.steps.length > 0 ? initial.steps : [{ kind: 'do', text: '' }],
  );
  const [focusIndex, setFocusIndex] = useState(0);
  const setStep = (i: number, patch: Partial<WorkflowStep>) =>
    setSteps((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const cleaned = steps.filter((s) => s.text.trim());
  const canSave = !!onSave && title.trim() !== '' && cleaned.length > 0;

  return (
    <div
      role="dialog"
      aria-label={`Edit workflow ${title}`}
      className="absolute inset-0 z-62 flex bg-bg text-text"
      data-testid="workflow-editor"
      onMouseDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') onCancel();
      }}
    >
      <div className="flex-1 min-w-0 flex flex-col gap-10 p-16 overflow-y-auto">
        <div className="flex items-center gap-8">
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Workflow name"
            className="flex-1 min-w-0 bg-transparent border-0 border-b-2 border-dashed border-border text-xl text-text px-2"
            data-testid="workflow-title"
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
            variant={canSave ? 'accent' : 'disabled'}
            disabled={!canSave}
            onClick={() => onSave?.({ id: initial.id, title: title.trim(), steps: cleaned })}
            data-testid="workflow-save"
          >
            Save
          </Button>
        </div>
        {initial.path && <span className="text-2xs text-text-muted">{initial.path}</span>}
        <div className="flex flex-col gap-6">
          {steps.map((step, i) => (
            <div
              key={i}
              className={`grid grid-cols-[28px_1fr_auto] gap-8 items-start p-8 border ${
                guessed.has(i) ? 'border-dashed border-pin-note ' : ''
              }${i === focusIndex ? 'bg-active-bg border-accent' : 'bg-bg-thumb border-border'}`}
              onFocus={() => setFocusIndex(i)}
              data-testid="workflow-step"
            >
              <span className="w-24 h-24 text-center text-xs border border-border bg-bg-dark leading-5">
                {i + 1}
              </span>
              <div className="flex flex-col gap-4 min-w-0">
                <input
                  value={step.text}
                  onChange={(e) => {
                    setStep(i, { text: e.target.value });
                    setGuessed((g) => {
                      const next = new Set(g);
                      next.delete(i);
                      return next;
                    });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      setSteps((prev) => [
                        ...prev.slice(0, i + 1),
                        { kind: 'do', text: '' },
                        ...prev.slice(i + 1),
                      ]);
                      setFocusIndex(i + 1);
                    }
                  }}
                  placeholder={
                    step.kind === 'gate'
                      ? 'What should it wait for your OK on?'
                      : step.kind === 'show'
                        ? 'What should it show you?'
                        : 'What should the agent do?'
                  }
                  className="w-full bg-bg-dark border border-border px-6 py-2 text-sm text-text"
                />
                {guessed.has(i) && (
                  <span className="text-2xs text-pin-note">
                    ? The draft guessed this step. Check it.
                  </span>
                )}
                {i === focusIndex && (
                  <>
                    <div className="flex gap-4 flex-wrap">
                      {KINDS.map((k) => (
                        <button
                          key={k.kind}
                          title={k.hint}
                          onClick={() => setStep(i, { kind: k.kind })}
                          className={`px-6 text-2xs border bg-transparent cursor-pointer ${k.color} ${
                            step.kind === k.kind ? '' : 'opacity-40'
                          }`}
                        >
                          {k.label}
                        </button>
                      ))}
                      <span className="text-2xs text-text-muted self-center">
                        {KINDS.find((k) => k.kind === step.kind)?.hint}
                      </span>
                    </div>
                    {step.kind === 'show' && (
                      <input
                        value={step.show ?? ''}
                        onChange={(e) => setStep(i, { show: e.target.value })}
                        placeholder="File to show, e.g. ~/code/app/CHANGELOG.md --lines 1-40"
                        className="w-full bg-bg-dark border border-border px-6 py-1 text-code-sm text-text font-mono"
                      />
                    )}
                    {(step.refs ?? []).map((ref, r) => (
                      <div key={r} className="flex gap-4">
                        <input
                          value={ref}
                          onChange={(e) =>
                            setStep(i, {
                              refs: (step.refs ?? []).map((x, y) => (y === r ? e.target.value : x)),
                            })
                          }
                          placeholder="File for this step (a path)"
                          className="flex-1 min-w-0 bg-bg-dark border border-border px-6 py-1 text-code-sm text-text font-mono"
                        />
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setStep(i, { refs: (step.refs ?? []).filter((_, y) => y !== r) })
                          }
                          aria-label="Remove file"
                        >
                          ✕
                        </Button>
                      </div>
                    ))}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="self-start"
                      onClick={() => setStep(i, { refs: [...(step.refs ?? []), ''] })}
                    >
                      + File
                    </Button>
                  </>
                )}
              </div>
              <div className="flex flex-col gap-2 items-end">
                <span className={`px-6 text-2xs border ${kindClass(step.kind)}`}>{step.kind}</span>
                <span className="flex gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setSteps((p) => moveStep(p, i, -1))}
                    aria-label="Move up"
                  >
                    ↑
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setSteps((p) => moveStep(p, i, 1))}
                    aria-label="Move down"
                  >
                    ↓
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setSteps((p) => (p.length > 1 ? p.filter((_, j) => j !== i) : p))
                    }
                    aria-label="Remove step"
                  >
                    ✕
                  </Button>
                </span>
              </div>
            </div>
          ))}
        </div>
        <Button
          size="sm"
          className="self-start"
          onClick={() => {
            setSteps((p) => [...p, { kind: 'do', text: '' }]);
            setFocusIndex(steps.length);
          }}
        >
          + Step
        </Button>
      </div>
      <aside className="hidden md:flex flex-col gap-8 w-320 shrink-0 p-12 bg-bg-dark border-l-2 border-border overflow-y-auto">
        <span className="text-2xs text-text-muted uppercase">The file</span>
        <pre className="m-0 p-8 bg-bg border border-border text-code-sm font-mono whitespace-pre-wrap">
          {previewMarkdown(title, cleaned)}
        </pre>
        <span className="text-2xs text-text-muted uppercase">What the agent receives</span>
        <pre className="m-0 p-8 bg-chat-office border border-accent text-code-sm font-mono whitespace-pre-wrap">
          {`Follow the workflow in @${initial.path ?? '~/.pixel-agents/workflows/…'} (run w…). Read it first.\n…how to mark steps and wait at gates`}
        </pre>
        <span className="text-2xs text-text-muted">
          Only the path is sent. The agent reads the steps itself.
        </span>
      </aside>
    </div>
  );
}

/**
 * The Workflows rail (left edge): saved workflows as cards you drag onto a
 * character — or "Give to…" — plus the editor. The office never types a
 * workflow's steps; the agent is told the file's path and reads it.
 */
export function WorkflowRail({
  workflows,
  runs,
  agents,
  labelOf,
  onSave,
  onDelete,
  onAttach,
  onStopRun,
  notice,
  onClearNotice,
  onClose,
  onImport,
  onDraft,
  drafts,
  folders,
  canBrowseFolders,
}: WorkflowRailProps) {
  const [editing, setEditing] = useState<{ workflow: Workflow; unsure?: number[] } | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiText, setAiText] = useState('');
  const [aiFolder, setAiFolder] = useState(folders[0] ?? '');
  const [aiRead, setAiRead] = useState(true);
  const [aiRequest, setAiRequest] = useState<string | null>(null);
  const aiDraft = aiRequest ? drafts[aiRequest] : undefined;
  useEffect(() => {
    if (!aiDraft?.workflow) return;
    setEditing({ workflow: aiDraft.workflow, unsure: aiDraft.unsure });
    setAiOpen(false);
    setAiRequest(null);
    setAiText('');
  }, [aiDraft]);
  const [givingId, setGivingId] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const live = runs.filter((r) => r.state === 'running');

  return (
    <>
      <div
        className={`absolute flex flex-col bg-bg text-text ${
          full
            ? 'inset-0 z-58'
            : 'z-30 left-0 top-0 bottom-0 w-300 max-sm:w-full border-r-4 border-border'
        }`}
        data-testid="workflow-rail"
        data-full={full || undefined}
        onMouseDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col gap-8 px-12 py-10 border-b-2 border-border">
          <div className="flex items-center gap-6">
            <span className="text-lg">Workflows</span>
            <span className="text-2xs text-text-muted">{workflows.length}</span>
            <span className="flex-1" />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setFull((v) => !v)}
              title={full ? 'Back to the side rail' : 'Open as a full page'}
              aria-label={full ? 'Back to the side rail' : 'Open as a full page'}
              data-testid="workflow-full"
            >
              {full ? '⇲' : '⤢'}
            </Button>
            <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close workflows">
              ×
            </Button>
          </div>
          <div className="flex items-center gap-6 flex-wrap">
            {onSave && (
              <Button
                size="sm"
                variant="accent"
                className="whitespace-nowrap"
                onClick={() => setEditing({ workflow: { id: '', title: '', steps: [] } })}
                data-testid="workflow-new"
              >
                + New
              </Button>
            )}
            {onDraft && (
              <Button
                size="sm"
                className="whitespace-nowrap"
                onClick={() => setAiOpen((v) => !v)}
                title="Create a workflow with AI"
                data-testid="workflow-ai"
              >
                AI draft
              </Button>
            )}
            {onImport && (
              <label
                className="px-8 py-1 text-sm whitespace-nowrap bg-btn-bg border border-transparent hover:bg-btn-hover cursor-pointer"
                title="Import a workflow .md file"
              >
                Import
                <input
                  type="file"
                  accept=".md,text/markdown"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void file.text().then(onImport);
                    e.target.value = '';
                  }}
                />
              </label>
            )}
          </div>
        </div>
        {notice && (
          <div className="flex gap-6 items-start m-12 p-6 border border-status-permission bg-chat-permission text-2xs">
            <span className="flex-1">{notice}</span>
            <button
              className="bg-transparent border-0 text-text-muted cursor-pointer"
              onClick={onClearNotice}
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        )}
        {aiOpen && onDraft && (
          <div
            className={`flex flex-col gap-6 m-12 p-10 border border-accent bg-bg-dark ${full ? 'max-w-640' : ''}`}
            data-testid="workflow-ai-panel"
          >
            <span className="text-sm">
              <span className="px-4 mr-4 text-2xs bg-accent text-white">AI</span>Create a workflow
            </span>
            <textarea
              value={aiText}
              onChange={(e) => setAiText(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              rows={3}
              placeholder="How we ship a hotfix: branch off the release tag, fix, test, get my OK, then tag and deploy."
              className="bg-bg border border-border px-6 py-2 text-read-sm text-text font-reading resize-y"
            />
            <div className="flex flex-col gap-2 text-2xs text-text-muted">
              Project folder (optional)
              <FolderField
                value={aiFolder}
                onChange={setAiFolder}
                folders={folders}
                canBrowse={canBrowseFolders}
                optional
              />
            </div>
            <label className="flex items-center gap-6 text-2xs cursor-pointer">
              <input
                type="checkbox"
                checked={aiRead}
                onChange={(e) => setAiRead(e.target.checked)}
              />
              Let it read the project (real commands and paths)
            </label>
            {aiDraft?.error && <span className="text-2xs text-danger">{aiDraft.error}</span>}
            <Button
              size="sm"
              variant={aiText.trim() && !(aiRequest && !aiDraft) ? 'accent' : 'disabled'}
              disabled={!aiText.trim() || (aiRequest !== null && !aiDraft)}
              onClick={() => {
                const requestId = `r${Math.random().toString(36).slice(2, 10)}`;
                setAiRequest(requestId);
                onDraft({
                  requestId,
                  description: aiText.trim(),
                  folder: aiFolder.trim() || undefined,
                  readProject: aiRead,
                });
              }}
            >
              {aiRequest && !aiDraft ? 'Drafting…' : 'Draft workflow'}
            </Button>
            <span className="text-2xs text-text-muted">
              The draft opens in the editor. Nothing is saved until you press Save.
            </span>
          </div>
        )}
        <div
          className={`flex-1 min-h-0 overflow-y-auto p-12 ${
            full
              ? 'grid gap-12 content-start grid-cols-[repeat(auto-fill,minmax(280px,1fr))]'
              : 'flex flex-col gap-10'
          }`}
        >
          {workflows.length === 0 && (
            <span className="text-xs text-text-muted p-4">
              No workflows yet. A workflow is a list of steps you write once and give to any agent.
            </span>
          )}
          {workflows.map((w) => {
            const running = live.filter((r) => r.workflowId === w.id);
            const counts = KINDS.map((k) => ({
              ...k,
              count: w.steps.filter((st) => st.kind === k.kind).length,
            })).filter((k) => k.count > 0);
            return (
              <div
                key={w.id}
                draggable={!!onAttach}
                onDragStart={(e) => {
                  e.dataTransfer.setData(WORKFLOW_DRAG_MIME, w.id);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                className="flex flex-col gap-8 p-10 bg-bg-dark border border-border hover:border-accent shadow-pixel cursor-grab"
                data-testid="workflow-card"
              >
                <div className="flex items-start gap-6">
                  <span className="text-sm flex-1 min-w-0 break-words leading-tight">
                    {w.title}
                  </span>
                  {onAttach && (
                    <span className="text-xs text-text-muted" title="Drag onto a character">
                      ⠿
                    </span>
                  )}
                </div>
                <div className="flex gap-4 flex-wrap text-2xs">
                  <span className="px-4 border border-border text-text-muted">
                    {w.steps.length} steps
                  </span>
                  {counts.map((k) => (
                    <span key={k.kind} className={`px-4 border ${k.color}`}>
                      {k.count} {k.label}
                    </span>
                  ))}
                </div>
                {full && w.steps.length > 0 && (
                  <ol className="m-0 pl-0 list-none flex flex-col gap-2 text-xs">
                    {w.steps.slice(0, tunable('workflowPreviewSteps')).map((st, i) => (
                      <li key={i} className="flex gap-6 items-baseline min-w-0">
                        <span className="text-2xs text-text-muted w-16 shrink-0 text-right">
                          {i + 1}.
                        </span>
                        <span className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                          {st.text}
                        </span>
                        {st.kind !== 'do' && (
                          <span className={`px-2 text-2xs border ${kindClass(st.kind)}`}>
                            {st.kind}
                          </span>
                        )}
                      </li>
                    ))}
                    {w.steps.length > tunable('workflowPreviewSteps') && (
                      <li className="text-2xs text-text-muted pl-22">
                        +{w.steps.length - tunable('workflowPreviewSteps')} more
                      </li>
                    )}
                  </ol>
                )}
                {running.length > 0 && (
                  <span className="self-start px-4 text-2xs bg-accent text-white">
                    running · {running.map((r) => labelOf(r.agentId)).join(', ')}
                  </span>
                )}
                <div className="flex gap-6 flex-wrap relative mt-2">
                  {onAttach && (
                    <Button
                      size="sm"
                      variant="accent"
                      onClick={() => setGivingId(givingId === w.id ? null : w.id)}
                    >
                      Give to…
                    </Button>
                  )}
                  {onSave && (
                    <Button size="sm" onClick={() => setEditing({ workflow: w })}>
                      Edit
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      downloadText(
                        `${fileSlug(w.title)}.md`,
                        previewMarkdown(w.title, w.steps),
                        'text/markdown',
                      )
                    }
                    title="Save this workflow as a markdown file"
                  >
                    Export
                  </Button>
                  {givingId === w.id && (
                    <div className="absolute top-full left-0 mt-4 z-10 w-220 pixel-panel p-4 flex flex-col text-text">
                      {agents.length === 0 && (
                        <span className="text-2xs text-text-muted p-4">
                          No agent the office can type to. Start one with + Agent.
                        </span>
                      )}
                      {agents.map((a) => (
                        <button
                          key={a.id}
                          className="text-left px-6 py-2 bg-transparent border-0 text-xs text-text cursor-pointer hover:bg-bg-thumb"
                          onClick={() => {
                            onAttach?.(a.id, w.id);
                            setGivingId(null);
                          }}
                        >
                          {a.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {live.length > 0 && (
            <>
              <span
                className={`text-2xs text-text-muted uppercase mt-8 ${full ? 'col-span-full' : ''}`}
              >
                Running
              </span>
              {live.map((r) => {
                const p = runProgress(r);
                return (
                  <div
                    key={r.runId}
                    className="flex flex-col gap-2 p-6 border border-border bg-bg-dark text-xs"
                    data-testid="workflow-run"
                  >
                    <span>
                      {r.title} · {labelOf(r.agentId)}
                    </span>
                    <span className="text-2xs text-text-muted">
                      {p.done}/{p.total} steps
                      {p.waiting ? ` · waiting for you at step ${p.waiting}` : ''}
                    </span>
                    {onStopRun && (
                      <Button size="sm" className="self-start" onClick={() => onStopRun(r.runId)}>
                        Stop
                      </Button>
                    )}
                  </div>
                );
              })}
            </>
          )}
        </div>
        <div className="px-12 py-8 border-t-2 border-border text-2xs text-text-muted leading-snug">
          {full
            ? 'Give a workflow to an agent with “Give to…”, or go back to the rail and drag a card onto a character.'
            : 'Drag a card onto a character to give it that workflow.'}
        </div>
      </div>
      {editing && (
        <Editor
          key={editing.workflow.id || `new-${editing.unsure?.join('-') ?? ''}`}
          initial={editing.workflow}
          unsure={editing.unsure}
          onSave={
            onSave
              ? (w) => {
                  onSave(w);
                  setEditing(null);
                }
              : undefined
          }
          onCancel={() => setEditing(null)}
          onDelete={
            editing.workflow.id && onDelete
              ? () => {
                  onDelete(editing.workflow.id);
                  setEditing(null);
                }
              : undefined
          }
        />
      )}
    </>
  );
}
