import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import * as crypto from 'crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import * as fs from 'fs';

import type { BoardPin } from '../../core/src/messages.js';
import type { AgentRuntime } from './agentRuntime.js';
import type { AgentStateStore } from './agentStateStore.js';
import { isViewableName, resolvePinFile, saveUploadedFile } from './boardFiles.js';
import type {
  AssetCache,
  ReloadAssetsSideEffect,
  SetHooksEnabledSideEffect,
} from './clientMessageHandler.js';
import { handleClientMessage } from './clientMessageHandler.js';
import {
  BOARD_FILE_API_PREFIX,
  BOARD_FILE_MAX_BYTES,
  HOOK_API_PREFIX,
  LAUNCHER_API_PREFIX,
  LAUNCHER_POLL_TIMEOUT_MS,
  LAUNCHER_SESSION_ID_PATTERN,
  MAX_HOOK_BODY_SIZE,
  WS_CLOSE_FORBIDDEN_ORIGIN,
  WS_CLOSE_UNAUTHORIZED,
} from './constants.js';
import type { LauncherHub } from './launcherHub.js';
import type { AgentState } from './types.js';

/** Options for creating the HTTP + WebSocket server. */
export interface HttpServerOptions {
  /** true = VS Code embedded mode (ephemeral port, no static, quiet logging) */
  embedded: boolean;
  /** Host to bind to. Default: '127.0.0.1' */
  host?: string;
  /** Port to listen on. Default: 0 (auto-assign) */
  port?: number;
  /** Bearer auth token for hook and WebSocket endpoints */
  token: string;
  /** AgentStateStore for WebSocket broadcast piping */
  store: AgentStateStore;
  /** Shared agent lifecycle core (for toggle side effects + standalone restore). Optional in embedded mode. */
  runtime?: AgentRuntime;
  /** Path to SPA dist directory for static serving (standalone only) */
  staticDir?: string;
  /** Cached assets loaded at startup (standalone only) */
  assetCache?: AssetCache;
  /** Callback when a hook event is received */
  onHookEvent?: (providerId: string, event: Record<string, unknown>) => void;
  /** Invoked when setHooksEnabled is toggled via WebSocket. Standalone installs/uninstalls hooks here. */
  onSetHooksEnabled?: SetHooksEnabledSideEffect;
  /** Invoked when an external asset directory is added/removed. Standalone reloads + re-broadcasts assets here. */
  onReloadAssets?: ReloadAssetsSideEffect;
  /** Sessions started with `pixel-agents claude` poll here for office input. */
  launchers?: LauncherHub;
  /** Current whiteboard pins, for serving file pins to the document viewer. */
  getBoardPins?: () => BoardPin[];
  /** Add a whiteboard pin (used when a file is uploaded). Returns false when rejected. */
  saveBoardPin?: (pin: BoardPin) => boolean;
  /** A launcher polled: make sure its session is in the office (runtime.adoptLaunchedSession). */
  onLauncherPoll?: (sessionId: string, cwd: string) => void;
}

/** Result of createHttpServer(). */
export interface HttpServerHandle {
  app: FastifyInstance;
  port: number;
}

const startTime = Date.now();

/**
 * Create a Fastify server with hook endpoint, health check, and WebSocket support.
 *
 * All Fastify-specific code lives in this file. The rest of the server layer is
 * framework-agnostic. If Fastify is ever replaced, only this file changes.
 */
export async function createHttpServer(options: HttpServerOptions): Promise<HttpServerHandle> {
  const app = Fastify({
    // Per-request JSON logs bury the office link the CLI prints; opt back in
    // with PIXEL_OFFICE_VERBOSE=1 when debugging the server.
    logger: !options.embedded && !!process.env['PIXEL_OFFICE_VERBOSE'],
    bodyLimit: MAX_HOOK_BODY_SIZE,
  });

  await app.register(fastifyCors, { origin: true });
  await app.register(fastifyWebsocket);

  // Static SPA serving (standalone mode only)
  if (!options.embedded && options.staticDir) {
    await app.register(fastifyStatic, {
      root: options.staticDir,
      prefix: '/',
    });
    // HTML5 history fallback: serve index.html for unmatched routes
    app.setNotFoundHandler((_req, reply) => {
      reply.sendFile('index.html');
    });
  }

  // ── Routes ──────────────────────────────────────────────────

  registerHealthRoute(app);
  registerHookRoute(app, options);
  registerLauncherRoutes(app, options);
  registerBoardFileRoute(app, options);
  registerBoardUploadRoute(app, options);
  registerWebSocketRoute(app, options);

  // ── Listen ──────────────────────────────────────────────────

  await app.listen({ host: options.host ?? '127.0.0.1', port: options.port ?? 0 });
  const address = app.server.address();
  const port = typeof address === 'object' ? (address?.port ?? 0) : 0;

  return { app, port };
}

// ── Health ──────────────────────────────────────────────────────

function registerHealthRoute(app: FastifyInstance): void {
  app.get('/api/health', async () => ({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    pid: process.pid,
  }));
}

// ── Hook Events ────────────────────────────────────────────────

function registerHookRoute(app: FastifyInstance, options: HttpServerOptions): void {
  app.post<{
    Params: { providerId: string };
    Body: Record<string, unknown>;
  }>(
    `${HOOK_API_PREFIX}/:providerId`,
    {
      preHandler: bearerAuth(options.token),
      schema: {
        params: {
          type: 'object',
          properties: {
            providerId: { type: 'string', pattern: '^[a-z0-9-]+$' },
          },
          required: ['providerId'],
        },
      },
    },
    async (request, reply) => {
      const { providerId } = request.params;
      const event = request.body;

      if (event.session_id && event.hook_event_name) {
        options.onHookEvent?.(providerId, event);
      }

      reply.send('ok');
    },
  );
}

// ── Launcher ───────────────────────────────────────────────────

/**
 * `pixel-agents claude` long-polls for text to type into the pty it owns.
 * Bearer-authenticated with the server token (read from the 0600 registry
 * entry, like the hook script). Browsers are refused outright: a request
 * carrying an Origin header is never the launcher, and this channel ends in a
 * live terminal.
 */
function registerLauncherRoutes(app: FastifyInstance, options: HttpServerOptions): void {
  const { launchers } = options;
  if (!launchers) return;
  const params = {
    type: 'object',
    properties: { sessionId: { type: 'string', pattern: LAUNCHER_SESSION_ID_PATTERN } },
    required: ['sessionId'],
  };
  const noBrowsers = async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.headers.origin !== undefined) reply.code(403).send('forbidden');
  };

  app.get<{ Params: { sessionId: string }; Querystring: { cwd?: string } }>(
    `${LAUNCHER_API_PREFIX}/:sessionId/input`,
    {
      preHandler: [noBrowsers, bearerAuth(options.token)],
      schema: {
        params,
        querystring: {
          type: 'object',
          properties: { cwd: { type: 'string', maxLength: 4096 } },
        },
      },
    },
    async (request) => {
      const { sessionId } = request.params;
      const cwd = request.query.cwd;
      if (cwd) options.onLauncherPoll?.(sessionId, cwd);
      const texts = await launchers.poll(
        sessionId,
        LAUNCHER_POLL_TIMEOUT_MS,
        () => !request.raw.socket.destroyed,
      );
      return { texts };
    },
  );

  app.delete<{ Params: { sessionId: string } }>(
    `${LAUNCHER_API_PREFIX}/:sessionId`,
    { preHandler: [noBrowsers, bearerAuth(options.token)], schema: { params } },
    async (request) => {
      launchers.end(request.params.sessionId);
      return { ok: true };
    },
  );
}

// ── Whiteboard files ───────────────────────────────────────────

/** The document viewer fetches a pinned file by PIN id (see boardFiles.ts). Token required. */
function registerBoardFileRoute(app: FastifyInstance, options: HttpServerOptions): void {
  const { getBoardPins } = options;
  if (!getBoardPins) return;
  app.get<{ Params: { pinId: string } }>(
    `${BOARD_FILE_API_PREFIX}/:pinId`,
    {
      preHandler: bearerAuth(options.token),
      schema: {
        params: {
          type: 'object',
          properties: { pinId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' } },
          required: ['pinId'],
        },
      },
    },
    async (request, reply) => {
      const file = resolvePinFile(getBoardPins(), request.params.pinId);
      if (!file.ok) return reply.code(file.status).send({ error: file.error });
      return reply
        .header('Content-Type', file.contentType)
        .header('Content-Length', file.size)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Disposition', 'inline')
        .header('Cache-Control', 'no-store')
        .send(fs.createReadStream(file.filePath));
    },
  );
}

/** Upload a document from the browser: stored locally and pinned to the whiteboard. Token required. */
function registerBoardUploadRoute(app: FastifyInstance, options: HttpServerOptions): void {
  const { saveBoardPin } = options;
  if (!saveBoardPin) return;
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) =>
    done(null, body),
  );
  app.post<{ Querystring: { name?: string }; Body: Buffer }>(
    BOARD_FILE_API_PREFIX,
    {
      preHandler: bearerAuth(options.token),
      bodyLimit: BOARD_FILE_MAX_BYTES,
      schema: {
        querystring: {
          type: 'object',
          properties: { name: { type: 'string', minLength: 1, maxLength: 255 } },
          required: ['name'],
        },
      },
    },
    async (request, reply) => {
      const name = request.query.name ?? '';
      if (!Buffer.isBuffer(request.body)) return reply.code(400).send({ error: 'No file sent.' });
      if (!isViewableName(name)) {
        return reply.code(415).send({
          error: 'The viewer opens PDF, Word (.docx), Excel (.xlsx), CSV, text and image files.',
        });
      }
      const id = `pin_${crypto.randomUUID().replace(/-/g, '')}`;
      const filePath = saveUploadedFile(name, request.body, id);
      if (!filePath) return reply.code(400).send({ error: 'Could not store that file.' });
      const pin: BoardPin = {
        id,
        kind: 'file',
        title: name.slice(0, 200),
        value: filePath,
        scope: [],
        createdAt: new Date().toISOString(),
      };
      if (!saveBoardPin(pin)) return reply.code(400).send({ error: 'The whiteboard is full.' });
      return { pin };
    },
  );
}

// ── WebSocket ──────────────────────────────────────────────────

function registerWebSocketRoute(app: FastifyInstance, options: HttpServerOptions): void {
  app.get('/ws', { websocket: true }, (socket, request) => {
    // CONNECTION gate. Embedded (VS Code) requires the Bearer token. Standalone
    // requires a same-origin handshake instead (isAllowedWebSocketOrigin), so a
    // non-browser local client with no Origin can still watch the office. What
    // may be DONE over an accepted connection is a separate question, decided
    // below.
    if (options.embedded) {
      if (!timingSafeStringEqual(request.headers.authorization ?? '', `Bearer ${options.token}`)) {
        socket.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
        return;
      }
    } else if (!isAllowedWebSocketOrigin(request.headers.origin, request.headers.host)) {
      socket.close(WS_CLOSE_FORBIDDEN_ORIGIN, 'forbidden origin');
      return;
    }

    // Both modes prove privilege with the SAME out-of-band secret, differently
    // carried: embedded sends the Bearer token it was handed in-process;
    // standalone sends the `?token=` the CLI printed in the local URL and the
    // SPA forwarded on this handshake. Nothing about a network POSITION is
    // consulted, because every position is reproducible by a forwarder.
    const privileged = options.embedded || standaloneTokenValid(request.url, options.token);

    const { store } = options;

    // Pipe store events to WebSocket client
    const onAgentAdded = (id: number, agent: AgentState) => {
      safeSend(socket, {
        type: 'agentCreated',
        id,
        folderName: agent.folderName,
        isExternal: agent.isExternal || undefined,
        isTeammate: agent.leadAgentId !== undefined || undefined,
        teammateName: agent.agentName,
        parentAgentId: agent.leadAgentId,
        teamName: agent.teamName,
        hooksOnly: agent.hooksOnly || undefined,
        palette: agent.palette,
        hueShift: agent.hueShift,
      });
    };

    const onAgentRemoved = (id: number) => {
      safeSend(socket, { type: 'agentClosed', id });
    };

    const onBroadcast = (message: Record<string, unknown>) => {
      safeSend(socket, message);
    };

    store.on('agentAdded', onAgentAdded);
    store.on('agentRemoved', onAgentRemoved);
    store.on('broadcast', onBroadcast);

    // Handle incoming client messages
    socket.on('message', (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (!options.embedded && msg.type) {
          console.log('[Pixel Agents] WS client message:', msg.type);
        }
        handleClientMessage(msg, (m) => safeSend(socket, m), {
          store,
          runtime: options.runtime,
          cache: options.assetCache ?? null,
          onSetHooksEnabled: options.onSetHooksEnabled,
          onReloadAssets: options.onReloadAssets,
          privileged,
        });
      } catch {
        // Malformed JSON, ignore
      }
    });

    socket.on('close', () => {
      store.off('agentAdded', onAgentAdded);
      store.off('agentRemoved', onAgentRemoved);
      store.off('broadcast', onBroadcast);
    });
  });
}

/**
 * Standalone `/ws` CONNECTION gate: is this handshake same-origin?
 *
 * WebSocket connects are NOT subject to CORS, so without this any web page the
 * user happens to visit could open a socket to 127.0.0.1 and start talking.
 * Comparing Origin's host against the request's own Host header makes the check
 * same-origin by construction — it tracks whatever --host/--port the server was
 * bound to with zero configuration, and treats `localhost` and `127.0.0.1`
 * correctly (a browser derives both headers from the URL that loaded the SPA).
 *
 * A missing Origin still connects: non-browser local clients send none, and the
 * standalone server's read surface is deliberately open to whatever address it
 * was told to bind (`--host 0.0.0.0` exposes the SPA to the LAN by design).
 *
 * This gate is NOT sufficient for privileged actions and never was. Both header
 * values are attacker-supplied, so a DNS-rebound page (`evil.com` → 127.0.0.1)
 * sends `Origin: http://evil.com:PORT` AND `Host: evil.com:PORT` and passes
 * equality. See standaloneTokenValid for what actually guards consent.
 */
export function isAllowedWebSocketOrigin(
  origin: string | undefined,
  host: string | undefined,
): boolean {
  if (origin === undefined || origin === '') return true;
  try {
    return new URL(origin).host === host;
  } catch {
    // An unparseable Origin is not a same-origin browser request.
    return false;
  }
}

/**
 * Whether this socket may send PRIVILEGED messages — the ones that reach
 * outside `~/.pixel-agents/`. Today that is `setHooksEnabled`, which grants
 * durable, machine-wide consent to modify `~/.claude/settings.json` and
 * installs (or removes) a 12-event hook set.
 *
 * The handshake must carry the server token in its `?token=` query. That token
 * is minted at startup (server.ts), printed by the CLI inside the LOCAL url it
 * emits to the operator's terminal, and forwarded by the SPA loaded from that
 * url (webview-ui/src/transport/index.ts). It is the Jupyter model.
 *
 * Why a secret rather than a network position: EVERY position is reproducible.
 * The predecessor of this function required a loopback peer address AND a
 * loopback `Host`, on the theory that only a real local browser satisfies both.
 * A dumb TCP forwarder bound to the LAN, piping bytes verbatim to 127.0.0.1,
 * presents the server exactly what the SPA presents — `remoteAddress` is
 * 127.0.0.1 because the forwarder terminated the hop there, and `Host` is
 * whatever the remote client typed. Reproduced against the real `dist/cli.js`:
 * a client on another machine acquired consent and a 12-event install. Peer
 * address and Host/Origin are all carried BY the channel a proxy speaks, so the
 * gate must ride something the channel never carries — an out-of-band secret
 * the operator's own URL delivers and the forwarded attacker never sees.
 *
 * A tokenless client is not locked out of Pixel Agents — it connects and
 * watches the office exactly as before (the connection gate,
 * isAllowedWebSocketOrigin, is separate and unchanged). It simply cannot
 * approve a change to a file in someone's home directory.
 */
function standaloneTokenValid(url: string | undefined, expected: string): boolean {
  // Defensive: an empty configured token would otherwise privilege every
  // handshake that omits the query (both sides compare equal as '').
  if (!expected) return false;
  let provided: string;
  try {
    // Parsed against a dummy base because `request.url` is path-relative. Read
    // from the raw url rather than a framework-parsed query so the gate does
    // not depend on @fastify/websocket populating one on the upgrade request.
    provided = new URL(url ?? '', 'http://localhost').searchParams.get('token') ?? '';
  } catch {
    return false;
  }
  return timingSafeStringEqual(provided, expected);
}

// ── Auth Helper ────────────────────────────────────────────────

/** Constant-time string compare, length-guarded (timingSafeEqual throws on a
 *  length mismatch). One implementation for all three token comparisons. */
function timingSafeStringEqual(actual: string, expected: string): boolean {
  const actualBuf = Buffer.from(actual);
  const expectedBuf = Buffer.from(expected);
  return actualBuf.length === expectedBuf.length && crypto.timingSafeEqual(actualBuf, expectedBuf);
}

function bearerAuth(expectedToken: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!timingSafeStringEqual(request.headers.authorization ?? '', `Bearer ${expectedToken}`)) {
      reply.code(401).send('unauthorized');
    }
  };
}

// ── Utilities ──────────────────────────────────────────────────

function safeSend(
  socket: { send: (data: string) => void; readyState: number },
  message: Record<string, unknown>,
): void {
  // WebSocket.OPEN = 1
  if (socket.readyState === 1) {
    socket.send(JSON.stringify(message));
  }
}
