/**
 * JSON schema types for page configurations.
 *
 * Users generate this JSON however they want — from TypeScript, PHP, Python,
 * Rust, hand-written, whatever. The package only cares about valid JSON.
 */

// ── Page config types ───────────────────────────────────────────

export interface Action {
  /** Human-readable label for this action */
  label: string;
  /** CSS selector to find the element */
  selector: string;
  /** If true, the action navigates away — page will be reloaded to the original URL after screenshot */
  navigatesAway?: boolean;
  /** If set, fills the element with this text instead of clicking */
  typeText?: string;
  /** Milliseconds to wait after the action before taking a screenshot. If not set, uses the default wait strategy (network idle + DOM settle + idleWait). */
  waitAfter?: number;
  /**
   * CSS selector of the element to screenshot instead of the full page.
   * Useful for dropdowns, popovers, modals — captures just the relevant area.
   * If not set, takes a full page (or viewport) screenshot.
   */
  screenshotSelector?: string;
  /**
   * Which match to interact with when the selector matches multiple elements.
   * 0-based index. Default: 0 (first match).
   * Use this instead of relying on implicit .first() when your selector isn't unique.
   */
  nth?: number;
  /**
   * Save the browser session (cookies, localStorage) after this action completes.
   * Use on the submit action of a login flow so subsequent pages run authenticated.
   * The session persists for all following pages until a `clearSession` action is encountered.
   */
  saveSession?: boolean;
  /**
   * Clear the saved browser session after this action completes.
   * Use on a logout action to wipe cookies/localStorage so subsequent pages run as guest.
   */
  clearSession?: boolean;
  /** What the screenshot should show after this action (for LLM review) */
  expectation: string;
  /** Visual check categories the LLM should evaluate (for LLM review) */
  checks: string[];
}

export interface ActionGroup {
  /** Human-readable description of what this group tests */
  description: string;
  /** Chained actions within this group (no page reload between them) */
  actions: Action[];
}

export interface PageConfig {
  /** URL path to visit (e.g., "/login", "/admin/dashboard") */
  path: string;
  /** Human-readable page name */
  name: string;
  /**
   * Screenshot folder name. Used as the top-level directory for this page's screenshots.
   * You choose the name — "guest", "auth", "admin", "mobile", whatever makes sense.
   * Screenshots go to: {outputDir}/screenshots/{phase}/{page-slug}/...
   */
  phase: string;
  /** What the page should look like on initial load (for LLM review) */
  expectation: string;
  /** Visual check categories for the navigation screenshot (for LLM review) */
  checks: string[];
  /**
   * Regex patterns (as strings) for browser console errors that are expected on this page.
   * Matched errors are excluded from the error count.
   */
  expectedErrors?: string[];
  /**
   * Extra milliseconds to wait after the DOM has settled on this page.
   * Runs after network idle + DOM settle detection. Default: 0 (off).
   */
  idleWait?: number;
  /**
   * Override how long the DOM must be quiet before this page is considered settled (ms).
   * Default: 200.
   */
  domSettleTimeout?: number;
  /**
   * Override the maximum time to wait for the DOM to settle on this page (ms).
   * Default: 5000.
   */
  domSettleMax?: number;
  /**
   * CSS selector to wait for instead of the default wait strategy (networkidle + DOM settle + idleWait).
   * The runner waits until this selector is visible before taking screenshots.
   * Much more reliable for SPAs with websockets, polling, or SSE.
   */
  waitForSelector?: string;
  /**
   * Number of retries when locating an element before marking it missing.
   * Each retry waits for the element wait timeout. Default: 2.
   */
  retries?: number;
  /**
   * Override full-page screenshot for this page.
   * Set to false to capture only the visible viewport instead of the full scrollable page.
   */
  fullPage?: boolean;
  /** Action groups. Between groups the page reloads. Within a group, actions chain. */
  actionGroups: ActionGroup[];
}

// ── Runner config ───────────────────────────────────────────────

export interface RunnerConfig {
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
  /** Take full-page screenshots (default: true). Set to false for viewport-only. */
  fullPage?: boolean;
  /** Device emulation preset name (e.g., "iPhone 14", "Pixel 7"). Overrides viewport. */
  device?: string;
  /** Whether to ignore HTTPS errors (useful for self-signed certs, default: false) */
  ignoreHTTPSErrors?: boolean;
  /**
   * Extra milliseconds to wait after the DOM has settled, before taking a screenshot.
   * Runs after network idle + DOM settle detection. Useful as a final safety buffer
   * for pages with delayed rendering that MutationObserver can't catch (e.g. canvas, WebGL).
   * Default: 0 (off). Can be overridden per page via PageConfig.idleWait.
   */
  idleWait?: number;
  /**
   * How long the DOM must be quiet (no mutations) before the page is considered settled (ms).
   * After network goes idle, the runner watches for DOM changes via MutationObserver.
   * Once nothing changes for this duration, it takes the screenshot.
   * Default: 200. Can be overridden per page via PageConfig.domSettleTimeout.
   */
  domSettleTimeout?: number;
  /**
   * Maximum time to wait for the DOM to settle after network idle (ms).
   * If the DOM keeps changing beyond this (e.g. animations, live tickers),
   * the runner gives up and takes the screenshot anyway.
   * Default: 5000. Can be overridden per page via PageConfig.domSettleMax.
   */
  domSettleMax?: number;
  /**
   * Global CSS selector to wait for instead of the default wait strategy (networkidle + DOM settle + idleWait).
   * The runner waits until this selector is visible before taking screenshots.
   * Can be overridden per page via PageConfig.waitForSelector.
   */
  waitForSelector?: string;
  /**
   * Number of retries when locating an element before marking it missing.
   * Each retry waits for the element wait timeout. Default: 2.
   * Can be overridden per page via PageConfig.retries.
   */
  retries?: number;
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
   * Example: "E-commerce platform with product catalog, shopping cart, and checkout flow."
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
  return `${slugify(page.phase)}/${slugify(page.name)}/${slugify(group.description)}/${actionIndex + 1}.${slugify(action.label)}.png`;
}

// ── Config helper ───────────────────────────────────────────────

export function defineConfig(config: PatrolConfig): PatrolConfig {
  return config;
}
