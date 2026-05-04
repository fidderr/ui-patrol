/**
 * JSON schema types for page configurations.
 *
 * Users generate this JSON however they want — from TypeScript, PHP, Python,
 * Rust, hand-written, whatever. The package only cares about valid JSON.
 */

// ── Shared options ──────────────────────────────────────────────
// Behavioral fields shared across Action, PageConfig, and RunnerConfig.

export interface SharedOptions {
  /** Ms the network must be quiet (zero pending requests) before considered settled. Default: 100. */
  networkIdleWait?: number;
  /** Max ms to wait for network to settle. Gives up if requests keep firing. Default: 5000. */
  networkIdleMax?: number;
  /** Ms the DOM must be quiet (no mutations) before considered settled. Default: 100. */
  domIdleWait?: number;
  /** Max ms to wait for DOM to settle. Gives up if DOM keeps changing. Default: 5000. */
  domIdleMax?: number;
  /** CSS selector to also wait for after networkidle + DOM settle. All three run in sequence. */
  waitForSelector?: string;
  /** Take full-page screenshots (true) or viewport-only (false). Default: true. */
  fullPage?: boolean;
  /** Number of retries when locating an element before marking it missing. Default: 2. */
  retries?: number;
  /** Set to false to skip taking screenshots. Actions still run. Default: true. */
  screenshot?: boolean;
  /**
   * CSS selector of the element to screenshot instead of the full page.
   * Useful for dropdowns, popovers, modals — captures just the relevant area.
   */
  screenshotSelector?: string;
}

// ── Testable options ────────────────────────────────────────────
// Extends SharedOptions with fields needed for anything that produces
// a screenshot and gets reviewed: pages and actions.

export interface TestableOptions extends SharedOptions {
  /** Human-readable name. */
  name: string;
  /** What the screenshot should show (for LLM review). */
  expectation: string;
  /** Plain English checks the LLM reviewer should evaluate. */
  checks: string[];
  /**
   * Regex patterns for console errors that are expected.
   * Matched errors are excluded from the error count.
   * Each level filters its own errors independently (no cascade).
   */
  expectedErrors?: string[];
}

// ── Page config types ───────────────────────────────────────────

export interface Action extends TestableOptions {
  /** CSS selector to find the element */
  selector: string;
  /** If true, the action navigates away — page will be reloaded to the original URL after screenshot */
  navigatesAway?: boolean;
  /** If set, fills the element with this text instead of clicking */
  typeText?: string;
  /**
   * Which match to interact with when the selector matches multiple elements.
   * 0-based index. Default: 0 (first match).
   */
  nth?: number;
  /**
   * Save the browser session (cookies, localStorage) after this action completes.
   * Use on the submit action of a login flow so subsequent pages run authenticated.
   */
  saveSession?: boolean;
  /**
   * Clear the saved browser session after this action completes.
   * Use on a logout action to wipe cookies/localStorage so subsequent pages run as guest.
   */
  clearSession?: boolean;
}

export interface ActionGroup {
  /** Human-readable description of what this group tests */
  description: string;
  /** Chained actions within this group (no page reload between them) */
  actions: Action[];
}

export interface PageConfig extends TestableOptions {
  /** URL path to visit (e.g., "/login", "/admin/dashboard") */
  path: string;
  /**
   * Screenshot folder name. Used as the top-level directory for this page's screenshots.
   * You choose the name — "guest", "auth", "admin", "mobile", whatever makes sense.
   */
  phase: string;
  /** Action groups. Between groups the page reloads. Within a group, actions chain. */
  actionGroups: ActionGroup[];
}

// ── Runner config ───────────────────────────────────────────────

export interface RunnerConfig extends SharedOptions {
  /** Base URL of the application (default: "http://localhost:8000") */
  baseUrl?: string;
  /** Viewport width (default: 1280) */
  viewportWidth?: number;
  /** Viewport height (default: 720) */
  viewportHeight?: number;
  /** Playwright browser to use: "chromium", "firefox", or "webkit" (default: "chromium") */
  browser?: 'chromium' | 'firefox' | 'webkit';
  /** Run browser in headless mode (default: true) */
  headless?: boolean;
  /** Device emulation preset name (e.g., "iPhone 14", "Pixel 7"). Overrides viewport. */
  device?: string;
  /** Whether to ignore HTTPS errors (useful for self-signed certs, default: false) */
  ignoreHTTPSErrors?: boolean;
}

// ── Review config ───────────────────────────────────────────────

export interface ReviewConfig {
  /**
   * API URL for the OpenAI-compatible chat completions endpoint.
   * Default: "http://localhost:8080/v1/chat/completions" (llama.cpp)
   */
  apiUrl?: string;
  /** API key (only needed for hosted services). In TS configs, read from process.env directly. */
  apiKey?: string;
  /** Model name. */
  model?: string;
  /** Custom LLM instruction prompt. Can be inline text or a file path. */
  instructions?: string;
  /** Request timeout in milliseconds (default: 300000) */
  timeout?: number;
  /**
   * A description of your application, included in LLM prompts to give the
   * reviewer context about what it's looking at.
   */
  appDescription?: string;
}

// ── Unified project config ──────────────────────────────────────

export { DEFAULT_OUTPUT_DIR } from './defaults.js';
import { DEFAULT_OUTPUT_DIR } from './defaults.js';

export interface PatrolConfig {
  outputDir?: string;
  pages?: string;
  /** Directory where `generate` saves generated page configs. Default: "." (project root) */
  generateDir?: string;
  runner?: RunnerConfig;
  review?: ReviewConfig;
}

export function resolvePaths(config: PatrolConfig): {
  outputDir: string;
  screenshotDir: string;
  logDir: string;
} {
  const outputDir = config.outputDir ?? DEFAULT_OUTPUT_DIR;
  return {
    outputDir,
    screenshotDir: `${outputDir}/screenshots`,
    logDir: `${outputDir}/logs`,
  };
}

// ── Screenshot path helpers ─────────────────────────────────────

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function getNavScreenshotPath(page: PageConfig): string {
  return `${slugify(page.phase)}/${slugify(page.name)}/navigate.png`;
}

export function getActionScreenshotPath(
  page: PageConfig,
  group: ActionGroup,
  action: Action,
  actionIndex: number,
): string {
  return `${slugify(page.phase)}/${slugify(page.name)}/${slugify(group.description)}/${actionIndex + 1}.${slugify(action.name)}.png`;
}

// ── Config helper ───────────────────────────────────────────────

export function defineConfig(config: PatrolConfig): PatrolConfig {
  return config;
}
