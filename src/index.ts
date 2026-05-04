/**
 * ui-patrol
 *
 * Framework-agnostic UI testing tool with LLM-powered visual review.
 * Navigates pages, clicks elements, takes screenshots, captures errors,
 * and optionally reviews screenshots with an LLM.
 *
 * @example CLI usage
 * ```bash
 * ui-patrol run --pages ./pages.json --base-url http://localhost:3000
 * ui-patrol review
 * ```
 *
 * @example Programmatic: run + review in one call
 * ```ts
 * import { patrol, type PageConfig } from 'ui-patrol';
 *
 * const pages: PageConfig[] = [
 *   { path: '/', name: 'Home', phase: 'guest', expectation: 'Homepage', checks: [], actionGroups: [] },
 * ];
 *
 * const { run, review } = await patrol(pages, {
 *   baseUrl: 'http://localhost:3000',
 *   review: true,
 * });
 *
 * // In a test:
 * expect(run.summary.totalErrors).toBe(0);
 * expect(review.summary.failed).toBe(0);
 * ```
 *
 * @example Programmatic: run only
 * ```ts
 * import { PatrolRunner } from 'ui-patrol';
 *
 * const runner = new PatrolRunner({ baseUrl: 'http://localhost:3000' });
 * const result = await runner.launch(pages);
 * ```
 */

import type { Browser } from '@playwright/test';
import type { PageConfig, RunnerConfig, ReviewConfig } from './config.js';
import type { RunResult } from './runner.js';
import type { ReviewReport } from './reviewer.js';
import { DEFAULT_OUTPUT_DIR } from './defaults.js';
import { PatrolRunner } from './runner.js';
import { PatrolReviewer } from './reviewer.js';

// Config types and helpers
export {
  resolvePaths,
  defineConfig,
  slugify,
  getNavScreenshotPath,
  getActionScreenshotPath,
} from './config.js';

export type {
  PageConfig,
  Action,
  ActionGroup,
  RunnerConfig,
  ReviewConfig,
  PatrolConfig,
} from './config.js';

export {
  RUNNER_DEFAULTS,
  REVIEW_DEFAULTS,
  GENERATE_DEFAULTS,
  DEFAULT_OUTPUT_DIR,
  DEFAULT_PAGES_PATH,
} from './defaults.js';

// Runner
export { PatrolRunner } from './runner.js';
export type { RunResult, LogEntry } from './runner.js';

// Reviewer
export { PatrolReviewer } from './reviewer.js';
export type { ReviewItem, ReviewResult, ReviewReport } from './reviewer.js';

// Discover
export { generatePage, type DiscoverOptions } from './generate.js';

// Console capture helper
export { createConsoleCapture } from './helpers/console-capture.js';
export type { ConsoleCapture, ConsoleFinding } from './helpers/console-capture.js';

// LLM knowledge (central prompts and instructions)
export { REVIEWER_INSTRUCTIONS, JSON_SCHEMA_REFERENCE } from './llm-knowledge.js';

// ── Patrol options & result ─────────────────────────────────────

export interface PatrolOptions extends RunnerConfig {
  /** Enable LLM review after taking screenshots */
  review?: boolean;
  /** Override review configuration */
  reviewConfig?: ReviewConfig;
  /** Pass an existing Playwright Browser instance (e.g., from a Playwright test) */
  playwrightBrowser?: Browser;
  /** Override the output directory */
  outputDir?: string;
  /** Only run/review a specific page by name */
  page?: string;
}

export interface PatrolResult {
  run: RunResult;
  review: ReviewReport | null;
}

/**
 * Run ui-patrol and optionally review screenshots with an LLM — all in one call.
 *
 * @example In a Playwright test
 * ```ts
 * test('ui patrol', async ({ browser }) => {
 *   const { run, review } = await patrol(pages, {
 *     baseUrl: 'http://localhost:3000',
 *     playwrightBrowser: browser,
 *     review: true,
 *   });
 *   expect(run.summary.totalErrors).toBe(0);
 *   expect(run.summary.elementsMissing).toBe(0);
 *   expect(review?.summary.failed).toBe(0);
 * });
 * ```
 */
export async function patrol(pages: PageConfig[], options: PatrolOptions = {}): Promise<PatrolResult> {
  const {
    review,
    reviewConfig,
    playwrightBrowser,
    outputDir,
    page: pageFilter,
    ...runnerConfig
  } = options;

  const outDir = outputDir ?? DEFAULT_OUTPUT_DIR;

  // Filter pages if requested
  let filteredPages = pages;
  if (pageFilter) {
    const filter = pageFilter.toLowerCase();
    filteredPages = pages.filter((p) => p.name.toLowerCase() === filter);
  }

  // Run
  const runner = new PatrolRunner(runnerConfig, outDir);
  let runResult: RunResult;

  if (playwrightBrowser) {
    runResult = await runner.run(playwrightBrowser, filteredPages);
  } else {
    runResult = await runner.launch(filteredPages);
  }

  // Review (if enabled)
  let reviewResult: ReviewReport | null = null;

  if (review) {
    const screenshotDir = `${outDir}/screenshots`;
    const reviewer = new PatrolReviewer(reviewConfig ?? {});
    const items = reviewer.buildReviewItems(filteredPages, screenshotDir);
    reviewResult = await reviewer.review(items, { pageFilter });
  }

  return { run: runResult, review: reviewResult };
}
