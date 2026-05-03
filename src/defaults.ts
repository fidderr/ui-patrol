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
  idleWait: 2000,
} as const;

/** How long to wait for an element to appear before marking it missing (ms) */
export const ELEMENT_WAIT = 5_000;

/** How long to wait for network to settle after an action (ms) */
export const NETWORK_IDLE_TIMEOUT = 5_000;

// ── Review defaults ─────────────────────────────────────────────

export const REVIEW_DEFAULTS = {
  apiUrl: 'http://localhost:8080/v1/chat/completions',
  model: 'local',
  timeout: 300_000,
} as const;

// ── Output defaults ─────────────────────────────────────────────

export const DEFAULT_OUTPUT_DIR = './ui-patrol';
export const DEFAULT_PAGES_PATH = 'pages.json';
