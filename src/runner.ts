import * as fs from 'fs';
import * as path from 'path';
import type { Page, Browser, BrowserContext } from '@playwright/test';
import { createConsoleCapture, type ConsoleCapture } from './helpers/console-capture.js';
import {
  type PageConfig,
  type RunnerConfig,
  getNavScreenshotPath,
  getActionScreenshotPath,
} from './config.js';
import { RUNNER_DEFAULTS, ELEMENT_WAIT, NETWORK_IDLE_TIMEOUT, DEFAULT_OUTPUT_DIR } from './defaults.js';

// ── Types ───────────────────────────────────────────────────────

export interface LogEntry {
  page: string;
  pageName: string;
  action: 'navigate' | 'click' | 'type' | 'missing';
  elementLabel?: string;
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

export class PatrolRunner {
  private config: Required<
    Pick<RunnerConfig, 'baseUrl' | 'viewportWidth' | 'viewportHeight' | 'browser' | 'headless' | 'fullPage' | 'idleWait'>
  > & {
    device?: string;
    ignoreHTTPSErrors?: boolean;
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
      idleWait: config.idleWait ?? RUNNER_DEFAULTS.idleWait,
      device: config.device,
      ignoreHTTPSErrors: config.ignoreHTTPSErrors,
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
    fs.mkdirSync(this.screenshotDir, { recursive: true });
    fs.mkdirSync(this.logDir, { recursive: true });

    const gitignorePath = path.join(this.outputDir, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, '*\n', 'utf-8');
    }

    this.hasSession = false;
    if (fs.existsSync(this.sessionStatePath)) {
      fs.unlinkSync(this.sessionStatePath);
    }

    let context: BrowserContext | null = null;
    let page: Page | null = null;

    for (let pi = 0; pi < pages.length; pi++) {
      const pageConfig = pages[pi];

      if (pageConfig.clearSession) {
        console.log(`  🔓 Clearing session`);
        if (context) {
          await context.close();
          context = null;
          page = null;
        }
        if (fs.existsSync(this.sessionStatePath)) {
          fs.unlinkSync(this.sessionStatePath);
        }
        this.hasSession = false;
      }

      if (!context) {
        const opts = this.buildContextOptions();
        if (this.hasSession && fs.existsSync(this.sessionStatePath)) {
          (opts as Record<string, unknown>).storageState = this.sessionStatePath;
        }
        context = await browser.newContext(opts);
        page = await context.newPage();
      }

      await this.runPage(page!, pageConfig, pi, pages.length);

      if (pageConfig.saveSession && context) {
        console.log(`  💾 Saving session`);
        await context.storageState({ path: this.sessionStatePath });
        this.hasSession = true;
        await context.close();
        context = null;
        page = null;
      }
    }

    if (context) {
      await context.close();
    }

    const result = this.buildResult();
    this.writeLog(result);
    this.writePageConfigs(pages);
    this.printSummary(result);
    return result;
  }

  private async waitForIdle(page: Page, pageConfig?: PageConfig): Promise<void> {
    try {
      await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_TIMEOUT });
    } catch {
      // Network didn't fully settle (WebSocket, SSE, polling) — move on.
    }
    const wait = pageConfig?.idleWait ?? this.config.idleWait;
    if (wait > 0) {
      await page.waitForTimeout(wait);
    }
  }

  private async runPage(page: Page, pageConfig: PageConfig, pageIndex: number, totalPages: number): Promise<void> {
    const consoleCapture = createConsoleCapture(page);
    const base = this.config.baseUrl;
    const prefix = `[${pageIndex + 1}/${totalPages}]`;

    console.log(`\n${prefix} 📄 ${pageConfig.name} (${pageConfig.path})`);

    const navStart = Date.now();
    await page.goto(`${base}${pageConfig.path}`, { waitUntil: 'networkidle' });
    await this.waitForIdle(page, pageConfig);

    const navSs = getNavScreenshotPath(pageConfig);
    const navFullPath = path.join(this.screenshotDir, navSs);
    fs.mkdirSync(path.dirname(navFullPath), { recursive: true });
    await page.screenshot({ path: navFullPath, fullPage: pageConfig.fullPage ?? this.config.fullPage });

    const navMs = Date.now() - navStart;
    console.log(`  📸 navigate (${navMs}ms)`);

    this.addEntry({
      page: pageConfig.path,
      pageName: pageConfig.name,
      action: 'navigate',
      screenshot: navSs,
      browserConsole: this.filterExpectedErrors(consoleCapture.flush(), pageConfig),
    });

    await this.runActionGroups(page, pageConfig, consoleCapture);
    consoleCapture.detach();
  }

  private async runActionGroups(
    page: Page,
    pageConfig: PageConfig,
    consoleCapture: ReturnType<typeof createConsoleCapture>,
  ): Promise<void> {
    const base = this.config.baseUrl;

    for (let gi = 0; gi < pageConfig.actionGroups.length; gi++) {
      const group = pageConfig.actionGroups[gi];

      if (gi > 0) {
        await page.goto(`${base}${pageConfig.path}`, { waitUntil: 'networkidle' });
        await this.waitForIdle(page, pageConfig);
      }

      for (let ai = 0; ai < group.actions.length; ai++) {
        const action = group.actions[ai];

        try {
          const actionStart = Date.now();
          const loc = page.locator(action.selector).first();
          const isFound = await loc
            .waitFor({ state: 'visible', timeout: ELEMENT_WAIT })
            .then(() => true)
            .catch(() => false);

          if (!isFound) {
            console.log(`  ⚪ MISSING: ${action.label}`);
            this.addEntry({
              page: pageConfig.path,
              pageName: pageConfig.name,
              action: 'missing',
              elementLabel: action.label,
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

          if (action.waitAfter) {
            await page.waitForTimeout(action.waitAfter);
          } else {
            await this.waitForIdle(page, pageConfig);
          }

          const ss = getActionScreenshotPath(pageConfig, group, action, ai);
          const ssFullPath = path.join(this.screenshotDir, ss);
          fs.mkdirSync(path.dirname(ssFullPath), { recursive: true });

          if (action.screenshotSelector) {
            const target = page.locator(action.screenshotSelector).first();
            const isVisible = await target.isVisible().catch(() => false);
            if (isVisible) {
              await target.screenshot({ path: ssFullPath });
            } else {
              await page.screenshot({ path: ssFullPath, fullPage: pageConfig.fullPage ?? this.config.fullPage });
            }
          } else {
            await page.screenshot({ path: ssFullPath, fullPage: pageConfig.fullPage ?? this.config.fullPage });
          }

          this.addEntry({
            page: pageConfig.path,
            pageName: pageConfig.name,
            action: action.typeText !== undefined ? 'type' : 'click',
            elementLabel: action.label,
            screenshot: ss,
            browserConsole: this.filterExpectedErrors(consoleCapture.flush(), pageConfig),
          });

          const actionMs = Date.now() - actionStart;
          const actionType = action.typeText !== undefined ? 'type' : 'click';
          console.log(`  📸 ${actionType}: ${action.label} (${actionMs}ms)`);

          if (action.navigatesAway) {
            await page.goto(`${base}${pageConfig.path}`, { waitUntil: 'networkidle' });
            await this.waitForIdle(page, pageConfig);
          }
        } catch (err) {
          console.log(`  ❌ ERROR: ${action.label} — ${String(err).substring(0, 100)}`);
          this.addEntry({
            page: pageConfig.path,
            pageName: pageConfig.name,
            action: 'click',
            elementLabel: `${action.label} (error: ${String(err)})`,
            screenshot: '',
            browserConsole: this.filterExpectedErrors(consoleCapture.flush(), pageConfig),
          });
        }
      }
    }
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

  private filterExpectedErrors(capture: ConsoleCapture, pageConfig: PageConfig): ConsoleCapture {
    if (!pageConfig.expectedErrors?.length) return capture;
    const patterns = pageConfig.expectedErrors.map((p) => new RegExp(p));
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

  private writeLog(result: RunResult): void {
    fs.writeFileSync(path.join(this.logDir, 'ui-patrol-log.json'), JSON.stringify(result, null, 2), 'utf-8');
  }

  private writePageConfigs(pages: PageConfig[]): void {
    fs.writeFileSync(path.join(this.logDir, 'ui-patrol-pages.json'), JSON.stringify(pages, null, 2), 'utf-8');
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
          console.log(`  ⚪ [${entry.pageName}] ${entry.elementLabel}`);
        }
      }
    }

    if (s.totalErrors > 0) {
      console.log('\n🔴 ERRORS:');
      for (const entry of result.entries) {
        if (entry.browserConsole.errors.length > 0) {
          console.log(`\n  📸 ${entry.screenshot || '(no screenshot)'}`);
          console.log(`     ${entry.pageName} — ${entry.action}${entry.elementLabel ? ': ' + entry.elementLabel : ''}`);
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
