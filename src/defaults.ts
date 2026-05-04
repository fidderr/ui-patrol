/**
 * Single source of truth for all default values.
 * Used by the runner, reviewer, CLI init command, and README.
 */

// ── Runner defaults ─────────────────────────────────────────────

export const RUNNER_DEFAULTS = {
  baseUrl: 'http://localhost:8000',
  viewportWidth: 1280,
  viewportHeight: 720,
  browser: 'chromium' as const,
  headless: true,
  fullPage: true,
  /**
   * How long the DOM must be quiet (no mutations) before we consider the page settled (ms).
   * After network goes idle, we watch for DOM changes. Once nothing changes for this
   * duration, we take the screenshot.
   */
  domSettleTimeout: 200,
  /**
   * Maximum time to wait for the DOM to settle after network idle (ms).
   * If the DOM keeps changing beyond this, we give up and move on.
   */
  domSettleMax: 5000,
} as const;

/** How long to wait for an element to appear before marking it missing (ms) */
export const ELEMENT_WAIT = 5_000;

/** Default number of retries for locating an element before marking it missing */
export const ELEMENT_RETRIES = 2;

/** How long to wait for network to settle after an action (ms) */
export const NETWORK_IDLE_TIMEOUT = 5_000;

// ── Review defaults ─────────────────────────────────────────────

export const REVIEW_DEFAULTS = {
  apiUrl: 'http://localhost:8080/v1/chat/completions',
  model: 'local',
  timeout: 300_000,
  maxTokens: 1024,
  temperature: 0.1,
} as const;

// ── Generate defaults ───────────────────────────────────────────

export const GENERATE_DEFAULTS = {
  maxTokens: 4096,
  temperature: 0.2,
  /** Max chars of visible page text to include in LLM context */
  visibleTextLimit: 2000,
} as const;

// ── CLI defaults ────────────────────────────────────────────────

/** Timeout for loading TS/JS config files via tsx (ms) */
export const CONFIG_LOAD_TIMEOUT = 10_000;

// ── Output defaults ─────────────────────────────────────────────

export const DEFAULT_OUTPUT_DIR = './ui-patrol';
export const DEFAULT_PAGES_PATH = 'pages.json';
