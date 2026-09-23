<h1 align="center">
  <a href="https://github.com/pixel-agents-hq/pixel-agents/discussions">
    <img src="webview-ui/public/banner.png" alt="Pixel Agents">
  </a>
</h1>

<h2 align="center">The most playful way to orchestrate your agents</h2>

<div align="center">

[![version](https://img.shields.io/endpoint?url=https%3A%2F%2Fgist.githubusercontent.com%2Fpablodelucca%2F3cd28398fa4a2c0a636e1d51d41aee39%2Fraw%2Fversion.json)](https://github.com/pixel-agents-hq/pixel-agents/releases)
[![marketplaces](https://img.shields.io/endpoint?url=https%3A%2F%2Fgist.githubusercontent.com%2Fpablodelucca%2F3cd28398fa4a2c0a636e1d51d41aee39%2Fraw%2Finstalls.json)](https://marketplace.visualstudio.com/items?itemName=pablodelucca.pixel-agents)
[![npm downloads](https://img.shields.io/endpoint?url=https%3A%2F%2Fgist.githubusercontent.com%2Fpablodelucca%2F3cd28398fa4a2c0a636e1d51d41aee39%2Fraw%2Fnpm-downloads.json)](https://www.npmjs.com/package/pixel-agents)
[![stars](https://img.shields.io/github/stars/pixel-agents-hq/pixel-agents?logo=github&color=0183ff&style=flat)](https://github.com/pixel-agents-hq/pixel-agents/stargazers)
[![license](https://img.shields.io/github/license/pixel-agents-hq/pixel-agents?color=0183ff&style=flat)](https://github.com/pixel-agents-hq/pixel-agents/blob/main/LICENSE)
[![discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white&style=flat)](https://discord.gg/Yk7jXebv9H)

</div>

<div align="center">
<a href="https://marketplace.visualstudio.com/items?itemName=pablodelucca.pixel-agents">🛒 VS Code Marketplace</a> • <a href="https://open-vsx.org/extension/pablodelucca/pixel-agents">🛒 Open VSX</a> • <a href="https://www.npmjs.com/package/pixel-agents">📦 npm</a> • <a href="https://discord.gg/Yk7jXebv9H">👾 Discord</a> • <a href="https://github.com/pixel-agents-hq/pixel-agents/discussions">💬 Discussions</a> • <a href="CONTRIBUTING.md">🤝 Contributing</a> • <a href="CHANGELOG.md">📋 Changelog</a>
</div>

<br/>

> **This repository is Pixel Office** (`@ak1ena/pixel-office`, command `pixel-office`), a fork of Pixel Agents. On top of the office it adds chat with your agents, a task desk, workflows and teams, a document viewer and editor for Word, PowerPoint and Excel, and more. See [Pixel Office features](#pixel-office-features) and [Working with agents](#working-with-agents). Install it from the [releases](https://github.com/Ak1Ena/pixel-offices/releases), not from npm.

Pixel Agents turns the AI coding agents running in your terminals into animated pixel-art characters working in a tiny office. They walk to their desks, sit down, type when they're editing files, read when they're searching, and flag you visually when they're stuck waiting for input.

It ships in two forms from the same codebase:

- **VS Code extension** — [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=pablodelucca.pixel-agents) and [Open VSX](https://open-vsx.org/extension/pablodelucca/pixel-agents). Agents launch into VS Code terminals; characters render in the panel area.
- **Standalone CLI** — `npx pixel-agents` starts a local server and serves the same office as a browser app, useful for tmux, remote, and non-VS Code workflows.

The architecture is fully agent-agnostic and editor-agnostic: a typed `HookProvider` interface defines the integration boundary so adding a new AI tool is a single subdirectory of code. Claude Code is the reference implementation today; Codex, Gemini, Cursor, and others are on the roadmap.

![Pixel Agents screenshot](webview-ui/public/office.png)

## Features

- **One agent, one character** — every Claude Code terminal gets its own animated character
- **Live activity tracking** — characters animate based on what the agent is actually doing (writing, reading, running commands)
- **Office layout editor** — design your office with floors, walls, and furniture using a built-in editor
- **Speech bubbles** — visual indicators when an agent is waiting for input or awaiting permission
- **Sound notifications** — optional chimes when an agent finishes its turn or requests permission
- **Sub-agents and Agent Teams** — see ephemeral sub-agents and persistent Claude teammates as separate characters, including team roles and lifecycle changes
- **Persistent layouts** — your office design is saved and shared across VS Code windows
- **Shared layout and assets** — import/export layouts and load external character, pet, and furniture packs
- **Areas** — paint named areas onto the office, map workspace folders to them, and new agents sit inside the areas mapped to their folder
- **Diverse characters** — 6 diverse characters. These are based on the amazing work of [JIK-A-4, Metro City](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack).

### Pixel Office features

- **Chat with your agents** — click a character to open its chat card (or **Messages** for long reads); send messages, **■ Stop** a turn, answer permission prompts and on-screen questions from the office.
- **Start agents from the office** — **+ Agent** runs Claude (or `agy`) in a folder you pick, no terminal needed. `pixel-office claude` runs one in your own terminal that the office can still type into.
- **Clear context** — **⋯ → Clear context…** runs `/clear` (or `/compact`) after the current turn. Agents can ask to clear themselves (`pixel-office clear`); per agent you choose Ask me / Allow / Never.
- **Task desk** — cards (task / issue / feature) that agents in the card's folder pick up: they look, write a brief with **steps**, you approve, they build. Steps are `do`, `gate` (the agent waits for your Continue / Stop) or `show` (it opens a file for you); drag to reorder, edit them before and during the build, save them as a workflow.
- **Workflows and teams** — reusable step lists you hand to an agent, and team presets whose lead calls teammates in with `@name`.
- **Documents** — open Word, PowerPoint, Excel, PDF, CSV, text and images in the office. Word is laid out like Word; pick paragraphs, slides, cells or lines and ask an agent about them (only the place is sent, never the text). Edit in place with backup and Undo.
- **Agent chat beside a document** — talk to one agent about the open file; its suggested changes appear in the document itself (deleted text red, new text green) with Accept / Reject and Apply.
- **Agents edit documents** — `pixel-office doc edit` changes one paragraph, text box or cell and keeps the rest of the file as it was. Per agent: **Ask before applying**, **Auto-accept** or **Read only**.
- **Files** — the documents you opened, suggestions waiting for review, uploaded copies and backups in one rail, separate from the whiteboard (agents only see what you **Pin to board**).
- **Whiteboard, "show me", review changes** — shared pins agents can read; agents point you at a spot in a file (`pixel-office show`) or suggest a change for you to review (`pixel-office propose`).
- **Settings** — text size and fonts, **Advanced** limits and sizes, per-agent settings (⚙), the City Office or the original office layout.

<p align="center">
  <img src="webview-ui/public/characters.png" alt="Pixel Agents characters" width="320" height="72" style="image-rendering: pixelated;">
</p>

## Where This Is Going

The vision is: play a game, build a product. Two goals follow from it: to build a familiar, intuitive interface for running and orchestrating a lot of agents; and to make the hours you spend doing it feel less like administration and more like play.

Roughly three stages get there:

1. **Everywhere, with everything.** Today it's Claude Code in VS Code or the browser. It should be whatever agent you run, wherever you work. A new CLI is a subdirectory, not a rewrite — this is where help is most useful right now.
2. **Actually a game.** Health bars for rate limits and token budgets. Scores for whatever you care about. Furniture that _does_ things. Offices you open like save files, one per project.
3. **Expand the orchestration frontier.** Orchestrator characters. Form a team by dragging a box around them. Hand work between agents. Point them at a board and let them pick up tasks themselves.

Most of this is still ahead. See [Issues](https://github.com/pixel-agents-hq/pixel-agents/issues) and [Discussions](https://github.com/pixel-agents-hq/pixel-agents/discussions) for what's open, and [CONTRIBUTING.md](CONTRIBUTING.md) to jump in.

## Requirements

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and configured
- **VS Code extension:** VS Code 1.105.0 or later
- **Standalone CLI:** Node.js 20 or later
- Windows, Linux, or macOS

## Getting Started

### VS Code extension

1. Install Pixel Agents from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=pablodelucca.pixel-agents) or [Open VSX](https://open-vsx.org/extension/pablodelucca/pixel-agents).
2. Open the **Pixel Agents** panel beside the terminal.
3. Click **+ Agent** to launch Claude Code. In a multi-root workspace, select the folder first.

To use Claude with `--dangerously-skip-permissions`, hover over **+ Agent** to find the **Skip permissions mode** button. Only use this when you accept the security implications.

Pixel Agents also detects Claude sessions started outside the extension. Turn on **Settings → Watch All Sessions** to include sessions from other workspaces.

### Standalone CLI (Pixel Office)

Pixel Office is not on npm. Install a release tarball (see [releases](https://github.com/Ak1Ena/pixel-offices/releases) for the newest):

```bash
npm install -g https://github.com/Ak1Ena/pixel-offices/releases/download/v2.2.2/ak1ena-pixel-office-2.2.2.tgz
```

Or run it from source (`npm link` puts your checkout's `pixel-office` on your PATH; run `npm run compile` again after pulling):

```bash
git clone https://github.com/Ak1Ena/pixel-offices.git
cd pixel-offices
npm install
npm run compile
npm link
```

Then start the office from the project whose agents you want to see:

```bash
cd /path/to/your/project
pixel-office
```

It picks a free local port, opens the office in your browser and prints the link. Start agents with **+ Agent** in the office, or with `pixel-office claude` in any terminal. Use a fixed address or port when needed:

```bash
pixel-office --port 3100
pixel-office --host 127.0.0.1 --port 3100
pixel-office --lan        # also reachable from a phone on the same Wi-Fi
pixel-office --help
```

The default bind address is `127.0.0.1`. Binding to `0.0.0.0` exposes the UI and WebSocket to the local network; do this only on a trusted network.

Open the URL the CLI prints - it carries a `?token=` for this session. Any browser can watch the office without it, but installing or removing hooks (which edits your agent tool's own settings file, like the `~/.claude/settings.json`) is only offered to a session that has the token, so an untokened client on the network cannot approve it. Open the bare address instead and the hooks toggle in Settings is refused, and reports the actual install state rather than appearing to work.

Treat that URL as a secret: the token is a bearer capability, not proof of being local. Whoever holds it can approve the hook install from anywhere the server is reachable — so don't paste the URL into a shared channel, and note that it also lands in your browser history and (unredacted) in the server's own request log.

Pass `--no-open` to not open the browser.

### Running the extension and standalone together

The extension and standalone CLI can run at the same time. Each server registers under `~/.pixel-agents/servers/`; the hook script sends events to all active registrations. VS Code and standalone keep separate agents, seats, and settings while using the shared office layout.

Stop a standalone server with **Ctrl+C**. It removes only its own registration.

## Working with agents

**Which agents you can talk to.** The office can type into an agent only if it can reach its terminal:

| How the agent runs                     | Chat, Stop, Clear, task desk           | After the office stops                                                               |
| -------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------ |
| **+ Agent** (the office runs it)       | ✓                                      | It stops with the office. Resume it with `pixel-office claude --resume <session id>` |
| `pixel-office claude` in your terminal | ✓                                      | Keeps running and reconnects to the next office on its own                           |
| VS Code terminal (extension)           | ✓                                      | —                                                                                    |
| Plain `claude` in another terminal     | read-only (the office only watches it) | Keeps running                                                                        |

**Commands your agents use.** Agents started from the office are told about these; you can run them too:

```bash
pixel-office agents                          # who is in the office
pixel-office task show|brief|step|gate|done  # answer a task desk card
pixel-office doc outline FILE                # numbered paragraphs / slides / cells
pixel-office doc read FILE --para 3-4        # read one place (also --slide N, --cell B2:C9)
pixel-office doc edit FILE --para 3 --text "…" [--wait]   # change one place
pixel-office show FILE --lines 40-58 --why "…"            # point the human at a spot
pixel-office propose FILE --from NEWFILE --why "…"         # suggest a change to a text file
pixel-office board add|list|detail|rm        # the shared whiteboard
pixel-office workflow step|gate|show         # report progress on a workflow
pixel-office clear [--reason "…"]            # ask for a fresh context
```

**Where the office keeps things** (`~/.pixel-agents/`): the layout, whiteboard, task desk, workflows and teams, `files.json` (documents you opened — paths only), `suggestions.json` (suggestions waiting for review), `files/` (uploaded copies) and `backups/` (the version before each write; the last 5 per file are kept for 7 days).

## Customizing the Office

Click **Layout** to edit the office:

- Paint floor patterns and walls, with color and contrast controls.
- Place, rotate, recolor, select, and remove furniture.
- Paint auto-tiling carpets and customize their main and accent colors.
- Add animated pets; click a pet in the office to interact with it.
- Create named **Areas**, paint their tiles, and assign workspace folders to them.
- Undo/redo changes, then import or export the complete layout as JSON.

Layouts can grow to 64×64 tiles by clicking the ghost border outside the current grid.

### Office assets

Bundled furniture, floors, walls, carpets, characters, and pets live under `webview-ui/public/assets/`. Furniture manifests describe sprites, rotation groups, state groups, and animation frames.

Use **Settings → Add Asset Directory** to load external characters, pets, and furniture. See [docs/external-assets.md](docs/external-assets.md) for furniture directory structure and manifest details. The visual asset manager at `scripts/asset-manager.html` helps create furniture manifests.

## How It Works

Pixel Agents uses two Claude Code detection paths:

- **Hooks mode** (default) — a hook script receives Claude events such as `SessionStart`, `PreToolUse`, `PermissionRequest`, and `Stop`. It discovers active Pixel Agents servers and sends authenticated events to each one.
- **Heuristic mode** (fallback) — when hooks are unavailable, the runtime infers agent status by scanning Claude's JSONL session transcripts under `~/.claude/projects/`. Transcripts are also read in hooks mode for details not present in an event.

The Claude provider normalizes both sources into a shared `AgentEvent` model. `AgentRuntime` updates the central state store, and the active transport sends typed messages to the React webview. The office renders through Canvas 2D with pathfinding and character state machines.

Pixel Agents does not modify Claude Code. Its hook configuration and persistent data live under `~/.claude/` and `~/.pixel-agents/` respectively.

### Architecture

- **`core/`** — provider, adapter, transport, schema, and AsyncAPI message contracts with no runtime side effects.
- **`server/`** — shared Fastify server, agent runtime, persistence, Claude provider, transcript scanning, and standalone CLI.
- **`adapters/vscode/`** — the VS Code adapter: terminal, persistence, and webview bridge.
- **`webview-ui/`** — React 19, Vite, Canvas 2D, and adapter-specific transports for VS Code and browser WebSocket clients.

The extension and CLI are bundled with esbuild; the webview is built with Vite. Unit tests use Vitest and Node's test runner, and end-to-end coverage uses Playwright against VS Code and standalone.

## Development

```bash
git clone https://github.com/pixel-agents-hq/pixel-agents.git
cd pixel-agents
npm install
npm run build
```

Press **F5** in VS Code to launch the Extension Development Host. To run the standalone bundle built from source:

```bash
node dist/cli.js
```

Common checks:

```bash
npm run check-types
npm run lint
npm test
npm run e2e
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and [e2e/README.md](e2e/README.md) for the end-to-end suite.

### Hosted Test Reports

Build the combined Allure report locally and stage it for Vercel:

```bash
npm run test
npm run e2e
npm run e2e -- --attach-videos-on-success
npm run vercel:prepare
```

Use `npm run test:report` to build the combined report without preparing the Vercel output, then `npm run test:report:open` to serve it locally.

The staged output serves the combined `e2e`, `server`, and `webview` Allure report at `/reports/allure/`; it does not include a standalone webview preview. GitHub Actions creates a Vercel Preview deployment only for same-repository pull requests targeting `main`. The deploy job expects `VERCEL_TOKEN`, `VERCEL_ORG_ID`, and `VERCEL_PROJECT_ID` secrets and skips fork pull requests.

## Troubleshooting

- **Standalone will not start:** verify Node.js 20+, omit `--port` to choose a free port, or select another fixed port.
- **An agent is missing:** confirm **Settings → Instant Detection (Hooks)** is on and that the session belongs to the current workspace. Enable **Watch All Sessions** if needed.
- **The UI looks disconnected:** open **Settings → Debug View** to inspect the server connection, transcript path, and latest agent data.
- **You can't message an agent / a task desk card never gets picked up:** that agent is a read-only session (plain `claude` in another terminal). Start it with `pixel-office claude` or **+ Agent** instead; the task desk won't let a card wait on read-only agents.
- **A document looks wrong:** Word opens in the **Document** tab laid out like Word; **Paragraphs** is the numbered list used for picking and editing. Older `.doc`, `.ppt` and `.xls` files need saving as `.docx`, `.pptx` or `.xlsx` first.
- **Agents from last time are still in the office:** agents from other terminals come back because they are still running. Remove a character with **⋯ → Remove agent…** on its chat card.
- **Extension and standalone are both running:** this is supported. Current versions create separate files under `~/.pixel-agents/servers/`; stopping one does not remove the other.

## Community & Contributing

Join the [Discord](https://discord.gg/Yk7jXebv9H) to chat with other users and follow development. Use [Issues](https://github.com/pixel-agents-hq/pixel-agents/issues) to report bugs or request features, and [Discussions](https://github.com/pixel-agents-hq/pixel-agents/discussions) for questions and ideas.

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request and read our [Code of Conduct](CODE_OF_CONDUCT.md) before participating.

## Supporting the Project

<a href="https://github.com/sponsors/pablodelucca">
  <img src="https://img.shields.io/badge/Sponsor-GitHub-ea4aaa?logo=github" alt="GitHub Sponsors">
</a>
<a href="https://ko-fi.com/pablodelucca">
  <img src="https://img.shields.io/badge/Support-Ko--fi-ff5e5b?logo=ko-fi" alt="Ko-fi">
</a>

## Star History

<a href="https://www.star-history.com/?repos=pixel-agents-hq%2Fpixel-agents&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=pixel-agents-hq/pixel-agents&type=date&theme=dark&legend=bottom-right&sealed_token=Vn3YGMuZ_HFZAf56zIUQGCBJDYtDq38sOReKlcxWklxR_ilwVLynb7CPraf5uPhnAU7fwHXXoO88tzLkq9tpEYIExl4N8tcXOmu0ehAXPu5DdXNwjixYsxb00LSfeJ25f_jLkcZcTpRKLKYOb9p4_dR1jjAyrWDs7aicdbqejaDtLcVyj-oSoKkBfrS5" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=pixel-agents-hq/pixel-agents&type=date&legend=bottom-right&sealed_token=Vn3YGMuZ_HFZAf56zIUQGCBJDYtDq38sOReKlcxWklxR_ilwVLynb7CPraf5uPhnAU7fwHXXoO88tzLkq9tpEYIExl4N8tcXOmu0ehAXPu5DdXNwjixYsxb00LSfeJ25f_jLkcZcTpRKLKYOb9p4_dR1jjAyrWDs7aicdbqejaDtLcVyj-oSoKkBfrS5" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=pixel-agents-hq/pixel-agents&type=date&legend=bottom-right&sealed_token=Vn3YGMuZ_HFZAf56zIUQGCBJDYtDq38sOReKlcxWklxR_ilwVLynb7CPraf5uPhnAU7fwHXXoO88tzLkq9tpEYIExl4N8tcXOmu0ehAXPu5DdXNwjixYsxb00LSfeJ25f_jLkcZcTpRKLKYOb9p4_dR1jjAyrWDs7aicdbqejaDtLcVyj-oSoKkBfrS5" />
 </picture>
</a>

## License

Pixel Agents is available under the [MIT License](LICENSE).
