/**
 * AUTO-GENERATED FROM core/asyncapi.yaml. DO NOT EDIT MANUALLY.
 *
 * Run `npm run asyncapi:generate` to regenerate.
 *
 * Source of truth: the yaml at core/asyncapi.yaml.
 * Editors and clients in any language can consume the spec directly.
 */

export type ServerMessage =
  | ProviderCapabilities
  | AgentCreated
  | AgentClosed
  | AgentSelected
  | ExistingAgents
  | AgentStatus
  | AgentToolStart
  | AgentToolDone
  | AgentToolsClear
  | AgentToolPermission
  | AgentToolPermissionClear
  | SubagentToolStart
  | SubagentToolDone
  | SubagentClear
  | SubagentToolPermission
  | AgentTeamInfo
  | AgentContextUsage
  | AgentChatEntry
  | AgentChatHistory
  | AgentChatQueue
  | AgentChatSendable
  | AgentTokenUsage
  | AgentRenamed
  | OfficeCapabilities
  | AgentScreen
  | StartAgentResult
  | AgentRelayState
  | AgentPrefs
  | AgentModels
  | ModelOptions
  | SlashCommands
  | PastSessions
  | AgentClearRequests
  | DocEdits
  | DocEditDefault
  | FilesLoaded
  | FileOpened
  | AgentPermissionAsk
  | AgentPermissionAnswered
  | FolderListing
  | BoardLoaded
  | FocusRequests
  | WorkflowsLoaded
  | WorkflowRuns
  | WorkflowNotice
  | TeamsLoaded
  | TeamRuns
  | TeamNotice
  | TeamDraft
  | WorkflowDraft
  | Proposals
  | TaskDeskLoaded
  | TaskDeskNotice
  | LayoutLoaded
  | FurnitureAssetsLoaded
  | CharacterSpritesLoaded
  | PetSpritesLoaded
  | FloorTilesLoaded
  | WallTilesLoaded
  | CarpetTilesLoaded
  | SettingsLoaded
  | HooksStatus
  | HooksConsentRequest
  | ExternalAssetDirectoriesUpdated
  | AreaMappingsLoaded
  | WorkspaceFolders
  | AgentDiagnostics;

export type ClientMessage =
  | WebviewReady
  | LaunchAgent
  | FocusAgent
  | CloseAgent
  | SaveAgentSeats
  | SaveLayout
  | SetSoundEnabled
  | SetLastSeenVersion
  | SetAlwaysShowLabels
  | SetGhostHeadlessAgents
  | SetHooksEnabled
  | HooksConsentResponse
  | SetHooksInfoShown
  | SetWatchAllSessions
  | ExportLayout
  | ImportLayout
  | OpenSessionsFolder
  | AddExternalAssetDirectory
  | RemoveExternalAssetDirectory
  | SaveAreaMappings
  | SetShowAreas
  | RequestDiagnostics
  | SendChatMessage
  | CancelChatMessage
  | SaveBoardPin
  | RemoveBoardPin
  | AnswerFocus
  | SaveWorkflow
  | DeleteWorkflow
  | AttachWorkflow
  | AnswerGate
  | StopWorkflowRun
  | ImportWorkflow
  | SaveTeam
  | DeleteTeam
  | StartTeam
  | StopTeam
  | ImportTeam
  | DraftTeam
  | DraftWorkflow
  | DecideHunk
  | ApplyProposal
  | DiscardProposal
  | UndoProposal
  | SaveDeskTask
  | RemoveDeskTask
  | DeskTaskAction
  | EditDeskSteps
  | AnswerDeskGate
  | SetDeskTaskAllow
  | SetAgentPickup
  | RenameAgent
  | StartAgent
  | SendAgentKeys
  | InterruptAgent
  | ClearAgentContext
  | AnswerClearRequest
  | SetAgentPrefs
  | LoadAgentModels
  | SetAgentModel
  | ListSlashCommands
  | ListPastSessions
  | SetDocEditDefault
  | UndoDocEdit
  | OpenOfficeFile
  | ForgetOfficeFile
  | PinOfficeFile
  | DeleteOfficeUpload
  | ClearBackups
  | AnswerScreenQuestion
  | SetAgentRelay
  | AnswerPermission
  | ListFolder;

export interface ProviderCapabilities {
  type: 'providerCapabilities';
  readingTools: string[];
  subagentToolNames: string[];
}

export interface AgentCreated {
  type: 'agentCreated';
  id: number;
  folderName?: string;
  isExternal?: boolean;
  palette?: number;
  hueShift?: number;
}

export interface AgentClosed {
  type: 'agentClosed';
  id: number;
}

export interface AgentSelected {
  type: 'agentSelected';
  id: number;
}

export interface ExistingAgents {
  type: 'existingAgents';
  agents: number[];
  agentMeta: Record<string, AgentSeatMeta>;
  folderNames: Record<string, string>;
  externalAgents: Record<string, boolean>;
}

export interface AgentSeatMeta {
  palette?: number;
  hueShift?: number;
  seatId?: string;
}

export interface AgentStatus {
  type: 'agentStatus';
  id: number;
  status: AgentActivityStatus;
  awaitingInput?: boolean;
}

export type AgentActivityStatus = 'active' | 'waiting';

export interface AgentToolStart {
  type: 'agentToolStart';
  id: number;
  toolId: string;
  status: string;
  toolName?: string;
  permissionActive?: boolean;
  runInBackground?: boolean;
  isTeammateSpawn?: boolean;
}

export interface AgentToolDone {
  type: 'agentToolDone';
  id: number;
  toolId: string;
}

export interface AgentToolsClear {
  type: 'agentToolsClear';
  id: number;
}

export interface AgentToolPermission {
  type: 'agentToolPermission';
  id: number;
}

export interface AgentToolPermissionClear {
  type: 'agentToolPermissionClear';
  id: number;
}

export interface SubagentToolStart {
  type: 'subagentToolStart';
  id: number;
  parentToolId: string;
  toolId: string;
  status: string;
}

export interface SubagentToolDone {
  type: 'subagentToolDone';
  id: number;
  parentToolId: string;
  toolId: string;
}

export interface SubagentClear {
  type: 'subagentClear';
  id: number;
  parentToolId: string;
}

export interface SubagentToolPermission {
  type: 'subagentToolPermission';
  id: number;
  parentToolId: string;
}

export interface AgentTeamInfo {
  type: 'agentTeamInfo';
  id: number;
  teamName?: string;
  agentName?: string;
  isTeamLead?: boolean;
  leadAgentId?: number;
  teamUsesTmux?: boolean;
}

export interface AgentContextUsage {
  type: 'agentContextUsage';
  id: number;
  contextTokens: number;
  maxContextTokens: number;
}

export interface AgentChatEntry {
  type: 'agentChatEntry';
  id: number;
  entry: ChatEntry;
}

export interface ChatEntry {
  entryId: string;
  role: ChatRole;
  text: string;
  source?: ChatSource;
  toolDone?: boolean;
  usage?: TokenUsage;
  timestamp?: string;
  edit?: ChatEdit;
}

export type ChatRole = 'user' | 'assistant' | 'tool';

export type ChatSource = 'terminal' | 'office';

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface ChatEdit {
  path: string;
  kind: ChatEditKind;
  hunks: ChatEditHunk[];
  clipped?: boolean;
}

export type ChatEditKind = 'edit' | 'write';

export interface ChatEditHunk {
  removed: string;
  added: string;
}

export interface AgentChatHistory {
  type: 'agentChatHistory';
  id: number;
  entries: ChatEntry[];
}

export interface AgentChatQueue {
  type: 'agentChatQueue';
  id: number;
  queued: QueuedChatMessage[];
  error?: string;
}

export interface QueuedChatMessage {
  queueId: string;
  text: string;
}

export interface AgentChatSendable {
  type: 'agentChatSendable';
  id: number;
  sendable: boolean;
}

export interface AgentTokenUsage {
  type: 'agentTokenUsage';
  id: number;
  totalTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  requests: number;
  burnPerMinute: number;
  partial?: boolean;
}

export interface AgentRenamed {
  type: 'agentRenamed';
  id: number;
  name: string;
}

export interface OfficeCapabilities {
  type: 'officeCapabilities';
  canStartAgents: boolean;
  privileged?: boolean;
  recentFolders: string[];
}

export interface AgentScreen {
  type: 'agentScreen';
  id: number;
  lines: string[];
  question?: ScreenQuestion;
}

export interface ScreenQuestion {
  key: string;
  prompt: string[];
  options: ScreenQuestionOption[];
}

export interface ScreenQuestionOption {
  number: number;
  label: string;
}

export interface StartAgentResult {
  type: 'startAgentResult';
  ok: boolean;
  error?: string;
}

export interface AgentRelayState {
  type: 'agentRelayState';
  enabled: boolean;
}

export interface AgentPrefs {
  type: 'agentPrefs';
  id: number;
  clearPolicy: AgentClearPolicy;
  docEditMode?: DocEditMode;
}

export type AgentClearPolicy = 'ask' | 'allow' | 'never';

export type DocEditMode = 'ask' | 'auto' | 'off';

export interface AgentModels {
  type: 'agentModels';
  id: number;
  options: ModelOption[];
  state: AgentModelsState;
  error?: string;
}

export interface ModelOption {
  number: number;
  label: string;
  detail?: string;
  current?: boolean;
}

export type AgentModelsState = 'idle' | 'loading' | 'switching';

export interface ModelOptions {
  type: 'modelOptions';
  providerId: string;
  options: ModelOption[];
}

export interface SlashCommands {
  type: 'slashCommands';
  id: number;
  commands: string[];
  error?: string;
}

export interface PastSessions {
  type: 'pastSessions';
  cwd: string;
  sessions: PastSession[];
  error?: string;
}

export interface PastSession {
  sessionId: string;
  title: string;
  firstPrompt?: string;
  updatedAt: string;
  open?: boolean;
}

export interface AgentClearRequests {
  type: 'agentClearRequests';
  requests: AgentClearRequest[];
}

export interface AgentClearRequest {
  agentId: number;
  reason?: string;
  at: string;
}

export interface DocEdits {
  type: 'docEdits';
  edits: DocEditNotice[];
}

export interface DocEditNotice {
  editId: string;
  path: string;
  who: string;
  agentId?: number;
  at: string;
  changes: string[];
  canUndo: boolean;
  undone: boolean;
}

export interface DocEditDefault {
  type: 'docEditDefault';
  mode: DocEditMode;
}

export interface FilesLoaded {
  type: 'filesLoaded';
  files: OfficeFile[];
  uploadsBytes: number;
  backups: BackupGroup[];
  backupsBytes: number;
}

export interface OfficeFile {
  fileId: string;
  path: string;
  name: string;
  source: OfficeFileSource;
  openedAt: string;
  editedAt?: string;
  size?: number;
  missing?: boolean;
  pinned: boolean;
}

export type OfficeFileSource = 'disk' | 'upload';

export interface BackupGroup {
  key: string;
  name: string;
  versions: number;
  bytes: number;
  newestAt: string;
}

export interface FileOpened {
  type: 'fileOpened';
  path: string;
  fileId?: string;
  error?: string;
}

export interface AgentPermissionAsk {
  type: 'agentPermissionAsk';
  id: number;
  requestId: string;
  toolName: string;
  detail?: string;
  providerId?: string;
  expiresAt?: number;
}

export interface AgentPermissionAnswered {
  type: 'agentPermissionAnswered';
  id: number;
  requestId: string;
  decision?: PermissionDecision;
}

export type PermissionDecision = 'allow' | 'deny' | 'terminal';

export interface FolderListing {
  type: 'folderListing';
  path: string;
  parent?: string;
  home?: string;
  entries: FolderEntry[];
  files?: FolderFile[];
  error?: string;
}

export interface FolderEntry {
  name: string;
  path: string;
  isProject?: boolean;
}

export interface FolderFile {
  name: string;
  path: string;
  size: number;
  modifiedAt?: string;
}

export interface BoardLoaded {
  type: 'boardLoaded';
  pins: BoardPin[];
}

export interface BoardPin {
  id: string;
  kind: BoardPinKind;
  title: string;
  value: string;
  detail?: string;
  scope: number[];
  createdAt: string;
}

export type BoardPinKind = 'link' | 'file' | 'snippet' | 'note';

export interface FocusRequests {
  type: 'focusRequests';
  requests: FocusRequest[];
}

export interface FocusRequest {
  requestId: string;
  pinId: string;
  path: string;
  agentId?: number;
  why?: string;
  lineStart?: number;
  lineEnd?: number;
  page?: number;
  cell?: string;
  state: FocusState;
  reply?: string;
  createdAt: string;
}

export type FocusState = 'waiting' | 'seen';

export interface WorkflowsLoaded {
  type: 'workflowsLoaded';
  workflows: Workflow[];
}

export interface Workflow {
  id: string;
  title: string;
  path?: string;
  steps: WorkflowStep[];
}

export interface WorkflowStep {
  kind: WorkflowStepKind;
  text: string;
  refs?: string[];
  show?: string;
}

export type WorkflowStepKind = 'do' | 'show' | 'gate';

export interface WorkflowRuns {
  type: 'workflowRuns';
  runs: WorkflowRun[];
}

export interface WorkflowRun {
  runId: string;
  workflowId: string;
  title: string;
  agentId: number;
  steps: WorkflowRunStep[];
  state: WorkflowRunState;
  startedAt: string;
  endedAt?: string;
}

export interface WorkflowRunStep {
  kind: WorkflowStepKind;
  text: string;
  refs?: string[];
  state: WorkflowRunStepState;
}

export type WorkflowRunStepState = 'pending' | 'done' | 'waiting' | 'skipped';

export type WorkflowRunState = 'running' | 'done' | 'stopped' | 'abandoned';

export interface WorkflowNotice {
  type: 'workflowNotice';
  error: string;
}

export interface TeamsLoaded {
  type: 'teamsLoaded';
  teams: TeamPreset[];
}

export interface TeamPreset {
  id: string;
  title: string;
  description?: string;
  goalTemplate?: string;
  relay?: boolean;
  members: TeamMember[];
}

export interface TeamMember {
  name: string;
  role: string;
  lead?: boolean;
  instructions: string;
  command?: string;
  palette?: number;
  workflowId?: string;
}

export interface TeamRuns {
  type: 'teamRuns';
  runs: TeamRun[];
}

export interface TeamRun {
  crewId: string;
  teamId: string;
  title: string;
  goal: string;
  folder: string;
  members: TeamRunMember[];
  startedAt: string;
  state: TeamRunState;
}

export interface TeamRunMember {
  name: string;
  role: string;
  lead?: boolean;
  palette?: number;
  agentId?: number;
  error?: string;
  benched?: boolean;
  startedAt?: string;
}

export type TeamRunState = 'running' | 'stopped';

export interface TeamNotice {
  type: 'teamNotice';
  message: string;
  error?: boolean;
}

export interface TeamDraft {
  type: 'teamDraft';
  requestId: string;
  team?: TeamPreset;
  workflows?: Workflow[];
  note?: string;
  error?: string;
}

export interface WorkflowDraft {
  type: 'workflowDraft';
  requestId: string;
  workflow?: Workflow;
  unsure?: number[];
  note?: string;
  error?: string;
}

export interface Proposals {
  type: 'proposals';
  proposals: Proposal[];
}

export interface Proposal {
  proposalId: string;
  path: string;
  agentId?: number;
  why?: string;
  state: ProposalState;
  hunks: ProposalHunk[];
  createdAt: string;
  note?: string;
  canUndo?: boolean;
}

export type ProposalState = 'open' | 'applied' | 'discarded';

export interface ProposalHunk {
  hunkId: string;
  oldStart: number;
  newStart: number;
  lines: ProposalLine[];
  decision: HunkDecision;
  reason?: string;
  where?: string;
  place?: DocPlaceRef;
}

export interface ProposalLine {
  kind: ProposalLineKind;
  text: string;
}

export type ProposalLineKind = 'context' | 'del' | 'add';

export type HunkDecision = 'pending' | 'accepted' | 'rejected';

export interface DocPlaceRef {
  para?: number;
  insertAfter?: number;
  slide?: number;
  shape?: string;
  sheet?: string;
  cell?: string;
}

export interface TaskDeskLoaded {
  type: 'taskDeskLoaded';
  tasks: DeskTask[];
  agents: DeskAgent[];
}

export interface DeskTask {
  id: string;
  num: number;
  kind: DeskTaskKind;
  title: string;
  body: string;
  priority: DeskTaskPriority;
  folder: DeskFolder;
  allow: number[];
  state: DeskTaskState;
  round: number;
  claimedBy?: number;
  owner?: string;
  queued?: boolean;
  attempts?: number;
  briefs: DeskBrief[];
  result?: DeskResult;
  log: DeskLogEntry[];
  createdAt: string;
  teamId?: string;
  crewId?: string;
  workflowId?: string;
  attachments?: DeskAttachment[];
}

export type DeskTaskKind = 'task' | 'issue' | 'feature';

export type DeskTaskPriority = 'p1' | 'p2';

export interface DeskFolder {
  root: string;
  name: string;
  isGit: boolean;
  branch?: string;
  subPath?: string;
}

export type DeskTaskState =
  'draft' | 'inbox' | 'looking' | 'brief' | 'ready' | 'working' | 'result' | 'done';

export interface DeskBrief {
  by: string;
  understanding: string;
  subtasks: DeskSubtask[];
  files: string[];
  questions: DeskQuestion[];
  risk: string;
  size: string;
  createdAt: string;
}

export interface DeskSubtask {
  id?: string;
  kind?: WorkflowStepKind;
  title: string;
  ref?: string;
  waiting?: boolean;
  ask?: string;
  skip: boolean;
  done: boolean;
  by: DeskSubtaskAuthor;
}

export type DeskSubtaskAuthor = 'agent' | 'you';

export interface DeskQuestion {
  q: string;
  a: string;
}

export interface DeskResult {
  by: string;
  summary: string;
  branch?: string;
  diffStat?: string;
  tests?: string;
}

export interface DeskLogEntry {
  at: string;
  who: string;
  kind: DeskLogKind;
  text: string;
}

export type DeskLogKind = 'agent' | 'verified' | 'rejected' | 'system';

export interface DeskAttachment {
  path: string;
  name: string;
}

export interface DeskAgent {
  id: number;
  root?: string;
  branch?: string;
  pickup: boolean;
  canReach: boolean;
}

export interface TaskDeskNotice {
  type: 'taskDeskNotice';
  error: string;
  taskId?: string;
}

export interface LayoutLoaded {
  type: 'layoutLoaded';
  layout: Record<string, any> | null;
  wasReset?: boolean;
}

export interface FurnitureAssetsLoaded {
  type: 'furnitureAssetsLoaded';
  catalog: FurnitureAssetMessage[];
  sprites: Record<string, string[][]>;
}

export interface FurnitureAssetMessage {
  id: string;
  name: string;
  label: string;
  category: string;
  file: string;
  width: number;
  height: number;
  footprintW: number;
  footprintH: number;
  isDesk: boolean;
  canPlaceOnWalls: boolean;
  groupId?: string;
  canPlaceOnSurfaces?: boolean;
  backgroundTiles?: number;
  orientation?: string;
  state?: string;
  mirrorSide?: boolean;
  rotationScheme?: string;
  animationGroup?: string;
  frame?: number;
}

export interface CharacterSpritesLoaded {
  type: 'characterSpritesLoaded';
  characters: CharacterSpriteSet[];
}

export interface CharacterSpriteSet {
  down: string[][][];
  up: string[][][];
  right: string[][][];
}

export interface PetSpritesLoaded {
  type: 'petSpritesLoaded';
  pets: PetSpriteFrameSet[];
  petNames: string[];
}

export interface PetSpriteFrameSet {
  walkDown: string[][][];
  idleDown: string[][][];
  walkUp: string[][][];
  idleUp: string[][][];
  walkRight: string[][][];
}

export interface FloorTilesLoaded {
  type: 'floorTilesLoaded';
  sprites: string[][][];
}

export interface WallTilesLoaded {
  type: 'wallTilesLoaded';
  sets: string[][][][];
}

export interface CarpetTilesLoaded {
  type: 'carpetTilesLoaded';
  sets: string[][][][];
}

export interface SettingsLoaded {
  type: 'settingsLoaded';
  soundEnabled: boolean;
  lastSeenVersion: string;
  extensionVersion: string;
  watchAllSessions: boolean;
  alwaysShowLabels: boolean;
  ghostHeadlessAgents: boolean;
  hooksEnabled: boolean;
  hooksInfoShown: boolean;
  externalAssetDirectories: string[];
  showAreas: boolean;
}

export interface HooksStatus {
  type: 'hooksStatus';
  providerId: string;
  installed: boolean;
}

export interface HooksConsentRequest {
  type: 'hooksConsentRequest';
  providerId: string;
  headline: string;
  disclosure: string;
}

export interface ExternalAssetDirectoriesUpdated {
  type: 'externalAssetDirectoriesUpdated';
  dirs: string[];
}

export interface AreaMappingsLoaded {
  type: 'areaMappingsLoaded';
  mappings: Record<string, string[]>;
}

export interface WorkspaceFolders {
  type: 'workspaceFolders';
  folders: WorkspaceFolder[];
}

export interface WorkspaceFolder {
  name: string;
  path: string;
}

export interface AgentDiagnostics {
  type: 'agentDiagnostics';
  agents: Record<string, any>[];
}

export interface WebviewReady {
  type: 'webviewReady';
}

export interface LaunchAgent {
  type: 'launchAgent';
  folderPath?: string;
  bypassPermissions?: boolean;
}

export interface FocusAgent {
  type: 'focusAgent';
  id: number;
}

export interface CloseAgent {
  type: 'closeAgent';
  id: number;
}

export interface SaveAgentSeats {
  type: 'saveAgentSeats';
  seats: Record<string, SeatAssignment>;
}

export interface SeatAssignment {
  palette: number;
  hueShift: number;
  seatId: string | null;
}

export interface SaveLayout {
  type: 'saveLayout';
  layout: Record<string, any>;
}

export interface SetSoundEnabled {
  type: 'setSoundEnabled';
  enabled: boolean;
}

export interface SetLastSeenVersion {
  type: 'setLastSeenVersion';
  version: string;
}

export interface SetAlwaysShowLabels {
  type: 'setAlwaysShowLabels';
  enabled: boolean;
}

export interface SetGhostHeadlessAgents {
  type: 'setGhostHeadlessAgents';
  enabled: boolean;
}

export interface SetHooksEnabled {
  type: 'setHooksEnabled';
  providerId: string;
  enabled: boolean;
}

export interface HooksConsentResponse {
  type: 'hooksConsentResponse';
  providerId: string;
  choice: HooksConsentChoice;
}

export type HooksConsentChoice = 'install' | 'notNow' | 'never';

export interface SetHooksInfoShown {
  type: 'setHooksInfoShown';
}

export interface SetWatchAllSessions {
  type: 'setWatchAllSessions';
  enabled: boolean;
}

export interface ExportLayout {
  type: 'exportLayout';
}

export interface ImportLayout {
  type: 'importLayout';
}

export interface OpenSessionsFolder {
  type: 'openSessionsFolder';
}

export interface AddExternalAssetDirectory {
  type: 'addExternalAssetDirectory';
  path?: string;
}

export interface RemoveExternalAssetDirectory {
  type: 'removeExternalAssetDirectory';
  path: string;
}

export interface SaveAreaMappings {
  type: 'saveAreaMappings';
  mappings: Record<string, string[]>;
}

export interface SetShowAreas {
  type: 'setShowAreas';
  enabled: boolean;
}

export interface RequestDiagnostics {
  type: 'requestDiagnostics';
}

export interface SendChatMessage {
  type: 'sendChatMessage';
  id: number;
  text: string;
}

export interface CancelChatMessage {
  type: 'cancelChatMessage';
  id: number;
  queueId: string;
}

export interface SaveBoardPin {
  type: 'saveBoardPin';
  pin: BoardPin;
}

export interface RemoveBoardPin {
  type: 'removeBoardPin';
  pinId: string;
  deleteFile?: boolean;
}

export interface AnswerFocus {
  type: 'answerFocus';
  requestId: string;
  reply?: string;
}

export interface SaveWorkflow {
  type: 'saveWorkflow';
  workflow: Workflow;
}

export interface DeleteWorkflow {
  type: 'deleteWorkflow';
  workflowId: string;
}

export interface AttachWorkflow {
  type: 'attachWorkflow';
  id: number;
  workflowId: string;
}

export interface AnswerGate {
  type: 'answerGate';
  runId: string;
  step: number;
  decision: GateDecision;
}

export type GateDecision = 'continue' | 'stop';

export interface StopWorkflowRun {
  type: 'stopWorkflowRun';
  runId: string;
}

export interface ImportWorkflow {
  type: 'importWorkflow';
  markdown: string;
}

export interface SaveTeam {
  type: 'saveTeam';
  team: TeamPreset;
}

export interface DeleteTeam {
  type: 'deleteTeam';
  teamId: string;
}

export interface StartTeam {
  type: 'startTeam';
  teamId: string;
  folder: string;
  goal: string;
}

export interface StopTeam {
  type: 'stopTeam';
  crewId: string;
}

export interface ImportTeam {
  type: 'importTeam';
  team: TeamPreset;
  workflows: Workflow[];
}

export interface DraftTeam {
  type: 'draftTeam';
  requestId: string;
  description: string;
  folder?: string;
  readProject?: boolean;
  previous?: TeamPreset;
  change?: string;
}

export interface DraftWorkflow {
  type: 'draftWorkflow';
  requestId: string;
  description: string;
  folder?: string;
  readProject?: boolean;
  previous?: Workflow;
  change?: string;
}

export interface DecideHunk {
  type: 'decideHunk';
  proposalId: string;
  hunkId: string;
  decision: HunkDecision;
  reason?: string;
}

export interface ApplyProposal {
  type: 'applyProposal';
  proposalId: string;
}

export interface DiscardProposal {
  type: 'discardProposal';
  proposalId: string;
}

export interface UndoProposal {
  type: 'undoProposal';
  proposalId: string;
}

export interface SaveDeskTask {
  type: 'saveDeskTask';
  taskId?: string;
  kind: DeskTaskKind;
  title: string;
  body: string;
  priority: DeskTaskPriority;
  folder: string;
  draft?: boolean;
  teamId?: string;
  workflowId?: string;
  attachments?: string[];
}

export interface RemoveDeskTask {
  type: 'removeDeskTask';
  taskId: string;
}

export interface DeskTaskAction {
  type: 'deskTaskAction';
  taskId: string;
  action: DeskHumanAction;
  note?: string;
  answers?: string[];
  subtasks?: DeskSubtask[];
}

export type DeskHumanAction = 'publish' | 'verified' | 'do' | 'rejected' | 'accept' | 'sendBack';

export interface EditDeskSteps {
  type: 'editDeskSteps';
  taskId: string;
  steps: DeskSubtask[];
}

export interface AnswerDeskGate {
  type: 'answerDeskGate';
  taskId: string;
  step: number;
  decision: GateDecision;
  note?: string;
}

export interface SetDeskTaskAllow {
  type: 'setDeskTaskAllow';
  taskId: string;
  allow: number[];
}

export interface SetAgentPickup {
  type: 'setAgentPickup';
  id: number;
  enabled: boolean;
}

export interface RenameAgent {
  type: 'renameAgent';
  id: number;
  name: string;
}

export interface StartAgent {
  type: 'startAgent';
  cwd: string;
  name?: string;
  command?: string;
  firstMessage?: string;
  skipPermissions?: boolean;
  resume?: string;
  model?: string;
}

export interface SendAgentKeys {
  type: 'sendAgentKeys';
  id: number;
  keys: AgentKey[];
}

export type AgentKey = 'enter' | 'escape' | 'up' | 'down' | 'tab' | '1' | '2' | '3' | 'y' | 'n';

export interface InterruptAgent {
  type: 'interruptAgent';
  id: number;
}

export interface ClearAgentContext {
  type: 'clearAgentContext';
  id: number;
  mode?: ClearMode;
}

export type ClearMode = 'clear' | 'compact';

export interface AnswerClearRequest {
  type: 'answerClearRequest';
  id: number;
  allow: boolean;
}

export interface SetAgentPrefs {
  type: 'setAgentPrefs';
  id: number;
  clearPolicy?: AgentClearPolicy;
  docEditMode?: DocEditMode;
}

export interface LoadAgentModels {
  type: 'loadAgentModels';
  id: number;
}

export interface SetAgentModel {
  type: 'setAgentModel';
  id: number;
  label: string;
}

export interface ListSlashCommands {
  type: 'listSlashCommands';
  id: number;
}

export interface ListPastSessions {
  type: 'listPastSessions';
  cwd: string;
}

export interface SetDocEditDefault {
  type: 'setDocEditDefault';
  mode: DocEditMode;
}

export interface UndoDocEdit {
  type: 'undoDocEdit';
  editId: string;
}

export interface OpenOfficeFile {
  type: 'openOfficeFile';
  path: string;
}

export interface ForgetOfficeFile {
  type: 'forgetOfficeFile';
  fileId: string;
}

export interface PinOfficeFile {
  type: 'pinOfficeFile';
  fileId: string;
  pinned: boolean;
}

export interface DeleteOfficeUpload {
  type: 'deleteOfficeUpload';
  fileId: string;
}

export interface ClearBackups {
  type: 'clearBackups';
  key?: string;
}

export interface AnswerScreenQuestion {
  type: 'answerScreenQuestion';
  id: number;
  key: string;
  option: number;
}

export interface SetAgentRelay {
  type: 'setAgentRelay';
  enabled: boolean;
}

export interface AnswerPermission {
  type: 'answerPermission';
  id: number;
  requestId: string;
  decision: PermissionDecision;
}

export interface ListFolder {
  type: 'listFolder';
  path?: string;
  files?: boolean;
}
