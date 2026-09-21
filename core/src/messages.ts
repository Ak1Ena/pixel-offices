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
  | AgentPermissionAsk
  | AgentPermissionAnswered
  | FolderListing
  | BoardLoaded
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
  | SaveDeskTask
  | RemoveDeskTask
  | DeskTaskAction
  | SetDeskTaskAllow
  | SetAgentPickup
  | RenameAgent
  | StartAgent
  | SendAgentKeys
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
}

export type ChatRole = 'user' | 'assistant' | 'tool';

export type ChatSource = 'terminal' | 'office';

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
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
  error?: string;
}

export interface FolderEntry {
  name: string;
  path: string;
  isProject?: boolean;
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

export type DeskTaskState = 'inbox' | 'looking' | 'brief' | 'ready' | 'working' | 'result' | 'done';

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
  title: string;
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
}

export interface SaveDeskTask {
  type: 'saveDeskTask';
  taskId?: string;
  kind: DeskTaskKind;
  title: string;
  body: string;
  priority: DeskTaskPriority;
  folder: string;
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

export type DeskHumanAction = 'verified' | 'do' | 'rejected' | 'accept' | 'sendBack';

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
}

export interface SendAgentKeys {
  type: 'sendAgentKeys';
  id: number;
  keys: AgentKey[];
}

export type AgentKey = 'enter' | 'escape' | 'up' | 'down' | 'tab' | '1' | '2' | '3' | 'y' | 'n';

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
}
