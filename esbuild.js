const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** Extension version read from package.json at build time, inlined via esbuild `define`. */
const pkgVersion = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'),
).version;
const versionDefine = {
  'process.env.PIXEL_AGENTS_VERSION': JSON.stringify(pkgVersion),
};

/**
 * Copy assets folder to dist/assets
 */
function copyAssets() {
  const srcDir = path.join(__dirname, 'webview-ui', 'public', 'assets');
  const dstDir = path.join(__dirname, 'dist', 'assets');

  if (fs.existsSync(srcDir)) {
    // Remove existing dist/assets if present
    if (fs.existsSync(dstDir)) {
      fs.rmSync(dstDir, { recursive: true });
    }

    // Copy recursively
    fs.cpSync(srcDir, dstDir, { recursive: true });
    console.log('✓ Copied assets/ → dist/assets/');
  } else {
    console.log('ℹ️  assets/ folder not found (optional)');
  }
}

/**
 * Bundle hook scripts (TypeScript) to dist/hooks via esbuild.
 * Produces one self-contained CJS file with shebang per provider
 * (claude-hook.js, codex-hook.js, gemini-hook.js, antigravity-hook.js) for the CLI to execute.
 */
function buildHooks() {
  const hookDir = path.join(__dirname, 'server', 'src', 'providers', 'hook');
  // Keyed by output name: with several entries esbuild would otherwise mirror
  // their source dirs under outdir, and dist/hooks/claude-hook.js must stay
  // exactly there (the installer's hook identity is that path).
  const entries = {};
  for (const id of ['claude', 'codex', 'gemini', 'antigravity']) {
    const entry = path.join(hookDir, id, 'hooks', `${id}-hook.ts`);
    if (fs.existsSync(entry)) entries[`${id}-hook`] = entry;
  }
  if (Object.keys(entries).length === 0) return;
  require('esbuild').buildSync({
    entryPoints: entries,
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outdir: path.join(__dirname, 'dist', 'hooks'),
    banner: { js: '#!/usr/bin/env node' },
  });
  console.log('✓ Built hooks/ → dist/hooks/');
}

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: 'esbuild-problem-matcher',

  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started');
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        console.error(`    ${location.file}:${location.line}:${location.column}:`);
      });
      console.log('[watch] build finished');
    });
  },
};

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['adapters/vscode/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    define: versionDefine,
    logLevel: 'silent',
    plugins: [
      /* add to the end of plugins array */
      esbuildProblemMatcherPlugin,
    ],
  });
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    // Copy assets and hooks after build
    copyAssets();
    buildHooks();
    await buildCli();
    await buildUninstall();
    await buildElectron();
  }
}

/** Bundle the Electron shell. It only spawns dist/cli.js, so it sits next to it. */
async function buildElectron() {
  await esbuild.build({
    entryPoints: ['adapters/electron/main.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    platform: 'node',
    outfile: 'dist/electron.js',
    external: ['electron'],
    define: versionDefine,
    logLevel: 'silent',
  });
}

/** Bundle the vscode:uninstall hook — plain Node, runs after extension removal. */
async function buildUninstall() {
  await esbuild.build({
    entryPoints: ['adapters/vscode/uninstall.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: false,
    platform: 'node',
    outfile: 'dist/uninstall.js',
    define: versionDefine,
    logLevel: 'silent',
  });
}

/** Bundle the standalone CLI entry point. */
async function buildCli() {
  await esbuild.build({
    entryPoints: ['server/src/cli.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    platform: 'node',
    outfile: 'dist/cli.js',
    // node-pty is native (optionalDependency): resolved at runtime, never bundled.
    external: ['fastify', '@fastify/websocket', '@fastify/static', '@fastify/cors', 'node-pty'],
    define: versionDefine,
    logLevel: 'silent',
  });
  if (!production) {
    console.log('[build] CLI bundled: dist/cli.mjs');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
