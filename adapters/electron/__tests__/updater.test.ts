import { describe, expect, it, vi } from 'vitest';

// updater.ts pulls in electron for the banner window and the restart dialog;
// only its pure parts are under test here.
vi.mock('electron', () => ({
  app: { getVersion: () => '2.4.4', relaunch: () => {}, quit: () => {} },
  BrowserWindow: class {},
  dialog: { showMessageBox: () => Promise.resolve({ response: 1 }) },
  shell: { openExternal: () => Promise.resolve() },
}));

const { INSTALL_TRIGGER_URL, macBannerHtml, parseInstallOutput } = await import('../updater.js');

const UPDATE = { version: '2.5.0', url: 'https://example.test/releases/v2.5.0' };

describe('macBannerHtml', () => {
  it('offers one install button and no command to copy', () => {
    const html = macBannerHtml(UPDATE);
    expect(html).toContain('Install update');
    expect(html).toContain(INSTALL_TRIGGER_URL);
    expect(html).not.toContain('Copy command');
    expect(html).not.toContain('curl -fsSL');
  });

  it('escapes what the release feed supplied', () => {
    const html = macBannerHtml({ version: '2.5.0"><script>x()</script>', url: UPDATE.url });
    expect(html).not.toContain('<script>x()');
  });
});

describe('parseInstallOutput', () => {
  it("keeps the installer's own step lines", () => {
    expect(parseInstallOutput('==> Verifying checksum...\n')).toEqual([
      { step: 'Verifying checksum...' },
    ]);
  });

  it("reads curl's percentage off a carriage-return progress bar", () => {
    expect(parseInstallOutput('######             12.5%\r#########      41.0%')).toEqual([
      { percent: 12.5 },
      { percent: 41 },
    ]);
  });

  it('reports a failure as an error', () => {
    expect(parseInstallOutput('error: checksum verification FAILED')).toEqual([
      { error: 'checksum verification FAILED' },
    ]);
  });

  it('drops blank lines and chatter that says nothing', () => {
    expect(parseInstallOutput('\n  \nmounting /dev/disk4\n')).toEqual([]);
  });

  it('bounds a percentage to 0-100', () => {
    expect(parseInstallOutput('500%')).toEqual([{ percent: 100 }]);
  });
});
