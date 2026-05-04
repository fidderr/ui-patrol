import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import * as path from 'path';
import type { Page, Browser, BrowserContext } from '@playwright/test';
import { createConsoleCapture, type ConsoleCapture } from './helpers/console-capture.js';
import {
  type Action,
  type PageConfig,
  type RunnerConfig,
  getNavScreenshotPath,
  getActionScreenshotPath,
} from './config.js';
import { RUNNER_DEFAULTS, ELEMENT_WAIT, ELEMENT_RETRIES, DEFAULT_OUTPUT_DIR } from './defaults.js';

// ── Types ───────────────────────────────────────────────────────

export interface LogEntry {
  page: string;
  pageName: string;
  action: 'navigate' | 'click' | 'type' | 'missing';
  elementName?: string;
  screenshot: string;
  browserConsole: ConsoleCapture;
}

export interface RunResult {
  timestamp: string;
  entries: LogEntry[];
  summary: {
    pagesVisited: number;
    elementsClicked: number;
    elementsMissing: number;
    totalErrors: number;
    totalWarnings: number;
  };
}

// ── Runner ──────────────────────────────────────────────────────

interface BrowserHandle {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

export class PatrolRunner {
  private config: Required<
    Pick<RunnerConfig, 'baseUrl' | 'viewportWidth' | 'viewportHeight' | 'browser' | 'headless' | 'fullPage'>
  > & {
    device?: string;
    ignoreHTTPSErrors?: boolean;
    waitForSelector?: string;
    retries?: number;
    networkIdleWait: number;
    domIdleWait: number;
    domIdleMax: number;
    screenshot?: boolean;
    screenshotSelector?: string;
  };

  private outputDir: string;
  private screenshotDir: string;
  private logDir: string;

  private entries: LogEntry[] = [];
  private pagesVisited = 0;
  private elementsClicked = 0;
  private elementsMissing = 0;
  private totalErrors = 0;
  private totalWarnings = 0;
  private sessionStatePath: string;
  private hasSession = false;

  constructor(config: RunnerConfig = {}, outputDir?: string) {
    this.config = {
      baseUrl: config.baseUrl ?? RUNNER_DEFAULTS.baseUrl,
      viewportWidth: config.viewportWidth ?? RUNNER_DEFAULTS.viewportWidth,
      viewportHeight: config.viewportHeight ?? RUNNER_DEFAULTS.viewportHeight,
      browser: config.browser ?? RUNNER_DEFAULTS.browser,
      headless: config.headless ?? RUNNER_DEFAULTS.headless,
      fullPage: config.fullPage ?? RUNNER_DEFAULTS.fullPage,
      device: config.device,
      ignoreHTTPSErrors: config.ignoreHTTPSErrors,
      waitForSelector: config.waitForSelector,
      retries: config.retries,
      networkIdleWait: config.networkIdleWait ?? RUNNER_DEFAULTS.networkIdleWait,
      domIdleWait: config.domIdleWait ?? RUNNER_DEFAULTS.domIdleWait,
      domIdleMax: config.domIdleMax ?? RUNNER_DEFAULTS.domIdleMax,
      screenshot: config.screenshot,
      screenshotSelector: config.screenshotSelector,
    };

    this.outputDir = outputDir ?? DEFAULT_OUTPUT_DIR;
    this.screenshotDir = path.join(this.outputDir, 'screenshots');
    this.logDir = path.join(this.outputDir, 'logs');
    this.sessionStatePath = path.join(this.logDir, 'session-state.json');
  }

  async launch(pages: PageConfig[]): Promise<RunResult> {
    const pw = await import('playwright');
    const browserType = pw[this.config.browser];
    const browser = await browserType.launch({ headless: this.config.headless });
    try {
      return await this.run(browser, pages);
    } finally {
      await browser.close();
    }
  }

  async run(browser: Browser, pages: PageConfig[]): Promise<RunResult> {
    this.reset();
    await fs.mkdir(this.screenshotDir, { recursive: true });
    await fs.mkdir(this.logDir, { recursive: true });

    const gitignorePath = path.join(this.outputDir, '.gitignore');
    if (!existsSync(gitignorePath)) {
      await fs.writeFile(gitignorePath, '*\n', 'utf-8');
    }

    this.hasSession = false;
    if (existsSync(this.sessionStatePath)) {
      await fs.unlink(this.sessionStatePath);
    }

    let handle = await this.createHandle(browser);

    for (let pi = 0; pi < pages.length; pi++) {
      handle = await this.runPage(handle, pages[pi], pi, pages.length);
    }

    await handle.context.close();

    const result = this.buildResult();
    await this.writeLog(result);
    await this.writePageConfigs(pages);
    this.printSummary(result);
    return result;
  }

  private async createHandle(browser: Browser): Promise<BrowserHandle> {
    const opts = this.buildContextOptions();
    if (this.hasSession && existsSync(this.sessionStatePath)) {
      (opts as Record<string, unknown>).storageState = this.sessionStatePath;
    }
    const context = await browser.newContext(opts);
    const page = await context.newPage();
    return { browser, context, page };
  }

  private async saveSession(handle: BrowserHandle): Promise<BrowserHandle> {
    console.log(`  💾 Saving session`);
    await handle.context.storageState({ path: this.sessionStatePath });
    this.hasSession = true;
    await handle.context.close();
    return this.createHandle(handle.browser);
  }

  private async clearSession(handle: BrowserHandle): Promise<BrowserHandle> {
    console.log(`  🔓 Clearing session`);
    await handle.context.close();
    if (existsSync(this.sessionStatePath)) {
      await fs.unlink(this.sessionStatePath);
    }
    this.hasSession = false;
    return this.createHandle(handle.browser);
  }

  /**
   * Resolve wait parameters.
   * For page navigation: page → config → defaults.
   * For actions: action → config → defaults (page does not affect actions).
   */
  private resolveWaitParams(pageConfig: PageConfig, action?: Action) {
    if (action) {
      return {
        networkIdleWait: action.networkIdleWait ?? this.config.networkIdleWait,
        domIdleWait: action.domIdleWait ?? this.config.domIdleWait,
        domIdleMax: action.domIdleMax ?? this.config.domIdleMax,
        waitForSelector: action.waitForSelector ?? this.config.waitForSelector,
      };
    }
    return {
      networkIdleWait: pageConfig.networkIdleWait ?? this.config.networkIdleWait,
      domIdleWait: pageConfig.domIdleWait ?? this.config.domIdleWait,
      domIdleMax: pageConfig.domIdleMax ?? this.config.domIdleMax,
      waitForSelector: pageConfig.waitForSelector ?? this.config.waitForSelector,
    };
  }

  /**
   * Wait for the page to be ready for interaction/screenshots.
   *
   * All strategies run in sequence (AND, not OR):
   * 1. Wait for network idle
   * 2. Wait for DOM to settle (MutationObserver)
   * 3. If `waitForSelector` is set, wait for that selector to be visible
   */
  private async waitForIdle(page: Page, pageConfig: PageConfig, action?: Action): Promise<void> {
    const { networkIdleWait, domIdleWait, domIdleMax, waitForSelector } = this.resolveWaitParams(pageConfig, action);

    // 1. Network idle
    try {
      await page.waitForLoadState('networkidle', { timeout: networkIdleWait });
    } catch {
      // Network didn't fully settle — move on.
    }

    // 2. DOM settle
    await page.evaluate(({ domIdleWait, domIdleMax }) => {
      return new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const maxTimer = setTimeout(() => {
          observer.disconnect();
          resolve();
        }, domIdleMax);

        const observer = new MutationObserver(() => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            observer.disconnect();
            clearTimeout(maxTimer);
            resolve();
          }, domIdleWait);
        });

        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
        });

        timer = setTimeout(() => {
          observer.disconnect();
          clearTimeout(maxTimer);
          resolve();
        }, domIdleWait);
      });
    }, { domIdleWait, domIdleMax });

    // 3. Wait for selector (if set)
    if (waitForSelector) {
      try {
        await page.locator(waitForSelector).first().waitFor({ state: 'visible', timeout: networkIdleWait });
      } catch {
        // Selector didn't appear in time — move on.
      }
    }
  }

  // ── Reusable helpers ──────────────────────────────────────────

  /** Navigate to a URL and wait for the page to settle. */
  private async navigateTo(page: Page, url: string, pageConfig: PageConfig, action?: Action): Promise<void> {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await this.waitForIdle(page, pageConfig, action);
  }

  /** Take a screenshot, respecting screenshotSelector and fullPage options. */
  private async captureScreenshot(
    page: Page,
    filePath: string,
    opts: { screenshotSelector?: string; fullPage?: boolean },
  ): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    if (opts.screenshotSelector) {
      const target = page.locator(opts.screenshotSelector).nth(0);
      const isVisible = await target.isVisible().catch(() => false);
      if (isVisible) {
        await target.screenshot({ path: filePath });
        return;
      }
    }

    await page.screenshot({ path: filePath, fullPage: opts.fullPage });
  }

  // ── Page + Action execution ─────────────────────────────────

  private async runPage(
    handle: BrowserHandle,
    pageConfig: PageConfig,
    pageIndex: number,
    totalPages: number,
  ): Promise<BrowserHandle> {
    const consoleCapture = createConsoleCapture(handle.page);
    const base = this.config.baseUrl;
    const prefix = `[${pageIndex + 1}/${totalPages}]`;

    console.log(`\n${prefix} 📄 ${pageConfig.name} (${pageConfig.path})`);

    const navStart = Date.now();
    await this.navigateTo(handle.page, `${base}${pageConfig.path}`, pageConfig);

    const navSs = getNavScreenshotPath(pageConfig);
    const navFullPath = path.join(this.screenshotDir, navSs);
    const takeNavScreenshot = pageConfig.screenshot ?? this.config.screenshot ?? true;

    if (takeNavScreenshot) {
      await this.captureScreenshot(handle.page, navFullPath, {
        screenshotSelector: pageConfig.screenshotSelector ?? this.config.screenshotSelector,
        fullPage: pageConfig.fullPage ?? this.config.fullPage,
      });
    }

    const navMs = Date.now() - navStart;
    console.log(`  📸 navigate (${navMs}ms)`);

    this.addEntry({
      page: pageConfig.path,
      pageName: pageConfig.name,
      action: 'navigate',
      screenshot: takeNavScreenshot ? navSs : '',
      browserConsole: this.filterExpectedErrors(consoleCapture.flush(), pageConfig.expectedErrors),
    });

    handle = await this.runActionGroups(handle, pageConfig, consoleCapture);
    consoleCapture.detach();
    return handle;
  }

  private async locateWithRetry(
    page: Page,
    selector: string,
    nth: number,
    maxRetries: number,
  ): Promise<import('@playwright/test').Locator | null> {
    const loc = page.locator(selector).nth(nth);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const isFound = await loc
        .waitFor({ state: 'visible', timeout: ELEMENT_WAIT })
        .then(() => true)
        .catch(() => false);

      if (isFound) return loc;

      if (attempt < maxRetries) {
        console.log(`    ↻ Retry ${attempt + 1}/${maxRetries} for: ${selector}`);
      }
    }

    return null;
  }

  private async runActionGroups(
    handle: BrowserHandle,
    pageConfig: PageConfig,
    consoleCapture: ReturnType<typeof createConsoleCapture>,
  ): Promise<BrowserHandle> {
    const base = this.config.baseUrl;

    for (let gi = 0; gi < pageConfig.actionGroups.length; gi++) {
      const group = pageConfig.actionGroups[gi];

      if (gi > 0) {
        await this.navigateTo(handle.page, `${base}${pageConfig.path}`, pageConfig);
      }

      for (let ai = 0; ai < group.actions.length; ai++) {
        const action = group.actions[ai];
        const maxRetries = action.retries ?? this.config.retries ?? ELEMENT_RETRIES;
        const nth = action.nth ?? 0;

        try {
          const actionStart = Date.now();
          const loc = await this.locateWithRetry(handle.page, action.selector, nth, maxRetries);

          if (!loc) {
            console.log(`  ⚪ MISSING: ${action.name}`);
            this.addEntry({
              page: pageConfig.path,
              pageName: pageConfig.name,
              action: 'missing',
              elementName: action.name,
              screenshot: '',
              browserConsole: { errors: [], warnings: [] },
            });
            continue;
          }

          if (action.typeText !== undefined) {
            await loc.fill(action.typeText);
          } else {
            await loc.click();
          }

          await this.waitForIdle(handle.page, pageConfig, action);

          const ss = getActionScreenshotPath(pageConfig, group, action, ai);
          const ssFullPath = path.join(this.screenshotDir, ss);
          const takeScreenshot = action.screenshot ?? this.config.screenshot ?? true;

          if (takeScreenshot) {
            await this.captureScreenshot(handle.page, ssFullPath, {
              screenshotSelector: action.screenshotSelector ?? this.config.screenshotSelector,
              fullPage: action.fullPage ?? this.config.fullPage,
            });
          }

          this.addEntry({
            page: pageConfig.path,
            pageName: pageConfig.name,
            action: action.typeText !== undefined ? 'type' : 'click',
            elementName: action.name,
            screenshot: takeScreenshot ? ss : '',
            browserConsole: this.filterExpectedErrors(consoleCapture.flush(), action.expectedErrors),
          });

          const actionMs = Date.now() - actionStart;
          const actionType = action.typeText !== undefined ? 'type' : 'click';
          console.log(`  📸 ${actionType}: ${action.name} (${actionMs}ms)`);

          // Session management — happens immediately after the action
          if (action.saveSession) {
            consoleCapture.detach();
            handle = await this.saveSession(handle);
            consoleCapture = createConsoleCapture(handle.page);
            await this.navigateTo(handle.page, `${base}${pageConfig.path}`, pageConfig);
          }

          if (action.clearSession) {
            consoleCapture.detach();
            handle = await this.clearSession(handle);
            consoleCapture = createConsoleCapture(handle.page);
            await this.navigateTo(handle.page, `${base}${pageConfig.path}`, pageConfig);
          }

          if (action.navigatesAway && !action.saveSession && !action.clearSession) {
            await this.navigateTo(handle.page, `${base}${pageConfig.path}`, pageConfig);
          }
        } catch (err) {
          console.log(`  ❌ ERROR: ${action.name} — ${String(err).substring(0, 100)}`);
          this.addEntry({
            page: pageConfig.path,
            pageName: pageConfig.name,
            action: 'click',
            elementName: `${action.name} (error: ${String(err)})`,
            screenshot: '',
            browserConsole: this.filterExpectedErrors(consoleCapture.flush(), action.expectedErrors),
          });
        }
      }
    }

    return handle;
  }

  private buildContextOptions(): Record<string, unknown> {
    const opts: Record<string, unknown> = {};
    if (this.config.device) {
      try {
        const pw = require('playwright');
        const device = pw.devices[this.config.device];
        if (device) {
          Object.assign(opts, device);
        } else {
          console.warn(`⚠ Unknown device "${this.config.device}", using viewport instead.`);
          opts.viewport = { width: this.config.viewportWidth, height: this.config.viewportHeight };
        }
      } catch {
        opts.viewport = { width: this.config.viewportWidth, height: this.config.viewportHeight };
      }
    } else {
      opts.viewport = { width: this.config.viewportWidth, height: this.config.viewportHeight };
    }
    if (this.config.ignoreHTTPSErrors) opts.ignoreHTTPSErrors = true;
    return opts;
  }

  private filterExpectedErrors(capture: ConsoleCapture, expectedErrors?: string[]): ConsoleCapture {
    if (!expectedErrors?.length) return capture;
    const patterns = expectedErrors.map((p) => new RegExp(p));
    return {
      errors: capture.errors.filter((e) => !patterns.some((re) => re.test(e.text))),
      warnings: capture.warnings,
    };
  }

  private reset(): void {
    this.entries = [];
    this.pagesVisited = 0;
    this.elementsClicked = 0;
    this.elementsMissing = 0;
    this.totalErrors = 0;
    this.totalWarnings = 0;
  }

  private addEntry(entry: LogEntry): void {
    this.entries.push(entry);
    if (entry.action === 'navigate') this.pagesVisited++;
    if (entry.action === 'click' || entry.action === 'type') this.elementsClicked++;
    if (entry.action === 'missing') this.elementsMissing++;
    this.totalErrors += entry.browserConsole.errors.length;
    this.totalWarnings += entry.browserConsole.warnings.length;
  }

  private buildResult(): RunResult {
    return {
      timestamp: new Date().toISOString(),
      entries: this.entries,
      summary: {
        pagesVisited: this.pagesVisited,
        elementsClicked: this.elementsClicked,
        elementsMissing: this.elementsMissing,
        totalErrors: this.totalErrors,
        totalWarnings: this.totalWarnings,
      },
    };
  }

  private async writeLog(result: RunResult): Promise<void> {
    await fs.writeFile(path.join(this.logDir, 'ui-patrol-log.json'), JSON.stringify(result, null, 2), 'utf-8');
  }

  private async writePageConfigs(pages: PageConfig[]): Promise<void> {
    await fs.writeFile(path.join(this.logDir, 'ui-patrol-pages.json'), JSON.stringify(pages, null, 2), 'utf-8');
  }

  private printSummary(result: RunResult): void {
    const s = result.summary;
    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║           UI PATROL SUMMARY              ║');
    console.log('╠══════════════════════════════════════════╣');
    console.log(`║  Pages visited:     ${String(s.pagesVisited).padStart(4)}`);
    console.log(`║  Elements clicked:  ${String(s.elementsClicked).padStart(4)}`);
    console.log(`║  Elements missing:  ${String(s.elementsMissing).padStart(4)}`);
    console.log(`║  Errors:            ${String(s.totalErrors).padStart(4)}`);
    console.log(`║  Warnings:          ${String(s.totalWarnings).padStart(4)}`);
    console.log('╚══════════════════════════════════════════╝');

    if (s.elementsMissing > 0) {
      console.log('\n🟠 MISSING ELEMENTS:');
      for (const entry of result.entries) {
        if (entry.action === 'missing') {
          console.log(`  ⚪ [${entry.pageName}] ${entry.elementName}`);
        }
      }
    }

    if (s.totalErrors > 0) {
      console.log('\n🔴 ERRORS:');
      for (const entry of result.entries) {
        if (entry.browserConsole.errors.length > 0) {
          console.log(`\n  📸 ${entry.screenshot || '(no screenshot)'}`);
          console.log(`     ${entry.pageName} — ${entry.action}${entry.elementName ? ': ' + entry.elementName : ''}`);
          for (const err of entry.browserConsole.errors) {
            console.log(`     ❌ ${err.text.substring(0, 200)}`);
          }
        }
      }
    }

    if (s.totalErrors === 0 && s.totalWarnings === 0 && s.elementsMissing === 0) {
      console.log('\n✅ All clean — no errors, warnings, or missing elements.');
    }
  }
}
