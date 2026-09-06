/**
 * Locate and launch Chrome with the DevTools port open.
 *
 * The profile directory is persistent and per-workspace, mirroring the QA
 * driver's model: you log the tenant in once by hand and the session survives
 * across runs. It is deliberately *not* your everyday Chrome profile — Chrome
 * refuses `--remote-debugging-port` on an already-running default profile, and
 * we should not be attaching a debugger to your personal browsing.
 */
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';

const CANDIDATES: Record<string, string[]> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ],
};

/** First Chrome-family binary that exists on this platform, if any. */
export function findChrome(platform: string = process.platform, exists = fs.existsSync): string | undefined {
  return (CANDIDATES[platform] ?? []).find((p) => exists(p));
}

export interface LaunchOptions {
  executable: string;
  port: number;
  /** Persistent profile so the tenant login survives between runs. */
  userDataDir: string;
  /** Opened in the first tab. */
  url?: string;
}

/**
 * The argv we launch with. Split out from {@link launchChrome} so the flags are
 * assertable in tests without spawning a browser.
 */
export function chromeArgs(opts: LaunchOptions): string[] {
  const args = [
    `--remote-debugging-port=${opts.port}`,
    `--user-data-dir=${opts.userDataDir}`,
    // Without this, Chrome 136+ refuses to expose the debugging port at all.
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
  ];
  if (opts.url) args.push(opts.url);
  return args;
}

/** Spawn Chrome detached, so closing VS Code doesn't kill the session mid-test. */
export function launchChrome(opts: LaunchOptions): ChildProcess {
  const child = spawn(opts.executable, chromeArgs(opts), { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

/** Poll the DevTools port until it answers, or give up. */
export async function waitForPort(
  probe: () => Promise<boolean>,
  timeoutMs = 20_000,
  intervalMs = 300
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
