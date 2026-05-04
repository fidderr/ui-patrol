#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { PatrolRunner } from '../runner.js';
import { PatrolReviewer } from '../reviewer.js';
import { generatePage } from '../generate.js';
import type { PageConfig, PatrolConfig, ReviewConfig, RunnerConfig } from '../config.js';
import { resolvePaths } from '../config.js';
import {
  RUNNER_DEFAULTS,
  REVIEW_DEFAULTS,
  DEFAULT_OUTPUT_DIR,
  DEFAULT_PAGES_PATH,
  ELEMENT_RETRIES,
  CONFIG_LOAD_TIMEOUT,
} from '../defaults.js';

// ── Config file names (checked in order) ────────────────────────

const CONFIG_FILE_NAMES = [
  'ui-patrol.config.ts',
  'ui-patrol.config.js',
  'ui-patrol.config.json',
];

// ── Helpers ─────────────────────────────────────────────────────

function usage(): void {
  console.log(`
ui-patrol — Framework-agnostic UI testing tool with LLM-powered visual review

USAGE:
  ui-patrol run     [options]   Navigate pages, click elements, take screenshots
  ui-patrol review  [options]   Send screenshots to an LLM for visual review
  ui-patrol generate <url>      Auto-generate page config from a live URL
  ui-patrol init                Create a starter ui-patrol.config.ts
  ui-patrol example             Create an example pages.json showing the full flow

CONFIG FILE:
  Place a ui-patrol.config.ts (or .js / .json) in your project root.
  The CLI auto-detects it. All CLI flags override config file values.

  All generated output (screenshots, logs) goes into a single folder.
  Default: ./ui-patrol/

RUN OPTIONS:
  --pages <path>        JSON file, directory, or "-" for stdin (piped JSON)
  --config <path>       Path to config file (default: auto-detect)
  --output-dir <dir>    Parent folder for all output (default: ./ui-patrol)
  --base-url <url>      Base URL (default: http://localhost:8000)
  --page <name>         Only run a specific page by name
  --browser <name>      Browser: chromium, firefox, webkit (default: chromium)
  --headed              Run browser in headed mode (visible window)
  --device <name>       Device emulation (e.g., "iPhone 14", "Pixel 7")
  --viewport-only       Take viewport-only screenshots (disables full-page)
  --review              Also run LLM review after taking screenshots

REVIEW OPTIONS:
  --pages <path>        JSON file, directory, or "-" for stdin
  --output-dir <dir>    Parent folder for all output (default: ./ui-patrol)
  --api-url <url>       OpenAI-compatible API URL (default: http://localhost:8080/v1/chat/completions)
  --api-key <key>       API key (or set UI_PATROL_API_KEY env var, only needed for hosted services)
  --model <name>        Model name
  --instructions <path> Custom LLM instruction file
  --page <name>         Only review a specific page by name
  --report <path>       Output report path

EXAMPLES:
  ui-patrol run --pages ./pages.json
  ui-patrol run --pages ./pages.json --base-url http://localhost:1420
  ui-patrol run --browser firefox --headed --pages ./pages/
  ui-patrol review
  ui-patrol review --page "Admin Dashboard"

  # Pipe JSON from any language
  php artisan generate:pages | ui-patrol run --pages -
  python generate_pages.py | ui-patrol run --pages -
  cargo run --bin pages | ui-patrol run --pages -

  ui-patrol init
  ui-patrol example

RUN OPTIONS (continued):
  --wait-for <selector> Wait for this CSS selector instead of the default wait strategy
  --retries <n>         Retries per element before marking missing (default: 2)

GENERATE OPTIONS:
  ui-patrol generate <url>      Crawl a URL and generate a page config
  --ai                          Use LLM to fill expectations and checks (keeps heuristic grouping)
  --smart                       Use LLM for everything (regroup + fill expectations + detect flows)
  --phase <name>                Phase/folder name (default: derived from URL)
  --name <name>                 Page name (default: derived from URL)
  --output <path>               Output file (default: auto-named in root or generateDir)
  --dry-run                     Print generated config to stdout instead of writing a file
  --api-url <url>               LLM API URL (for --ai and --smart)
  --api-key <key>               LLM API key (for --ai and --smart)
  --model <name>                LLM model (for --ai and --smart)
`);
}

function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith('--') && i + 1 < args.length && !args[i + 1].startsWith('--')) {
      result[arg.slice(2)] = args[i + 1];
      i++;
    } else if (arg.startsWith('--')) {
      result[arg.slice(2)] = 'true';
    } else if (!result['_command']) {
      result['_command'] = arg;
    } else if (!result['_arg']) {
      result['_arg'] = arg;
    }
  }

  return result;
}


async function loadConfigFile(explicitPath?: string): Promise<PatrolConfig> {
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    if (!fs.existsSync(resolved)) {
      console.error(`Config file not found: ${resolved}`);
      return process.exit(1) as never;
    }
    console.log(`Using config: ${resolved}`);
    return await loadConfig(resolved);
  }

  for (const name of CONFIG_FILE_NAMES) {
    const filePath = path.resolve(name);
    if (fs.existsSync(filePath)) {
      console.log(`Using config: ${filePath}`);
      return await loadConfig(filePath);
    }
  }

  return {};
}

/**
 * Load a config file. Supports .ts, .js (via dynamic import) and .json.
 */
async function loadConfig(filePath: string): Promise<PatrolConfig> {
  if (filePath.endsWith('.json')) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as PatrolConfig;
  }

  // TS/JS config — use dynamic import
  const fileUrl = `file://${path.resolve(filePath).replace(/\\/g, '/')}`;

  try {
    const mod = (await import(fileUrl)) as { default?: PatrolConfig } & PatrolConfig;
    return mod.default ?? mod;
  } catch {
    // If native import fails (TS without tsx), try via tsx
    const { execSync } = await import('child_process');

    try {
      const output = execSync(
        `npx tsx -e "import c from '${filePath.replace(/\\/g, '/')}'; process.stdout.write(JSON.stringify(c))"`,
        { encoding: 'utf-8', timeout: CONFIG_LOAD_TIMEOUT },
      );
      return JSON.parse(output) as PatrolConfig;
    } catch (err) {
      console.error(`Failed to load config file: ${filePath}`);
      console.error('For .ts configs, install tsx: npm install -D tsx');
      console.error(String(err));
      return process.exit(1) as never;
    }
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', reject);

    if (process.stdin.isTTY) {
      resolve('');
    }
  });
}

function parsePageJson(raw: string, source: string): PageConfig[] {
  try {
    const content = JSON.parse(raw) as PageConfig | PageConfig[];
    const pages: PageConfig[] = Array.isArray(content) ? content : [content];

    if (pages.length === 0) {
      console.error(`No page configs found in ${source}`);
      return process.exit(1) as never;
    }

    return pages;
  } catch (err) {
    console.error(`Invalid JSON from ${source}: ${err}`);
    return process.exit(1) as never;
  }
}

async function loadPages(pagesPath: string): Promise<PageConfig[]> {
  if (pagesPath === '-' || pagesPath === 'stdin') {
    const raw = await readStdin();
    if (!raw.trim()) {
      console.error('No input received from stdin.');
      process.exit(1);
    }
    return parsePageJson(raw, 'stdin');
  }

  const resolved = path.resolve(pagesPath);

  if (!fs.existsSync(resolved)) {
    console.error(`Pages path not found: ${resolved}`);
    process.exit(1);
  }

  if (fs.statSync(resolved).isDirectory()) {
    const files = fs
      .readdirSync(resolved)
      .filter((f: string) => f.endsWith('.json'))
      .sort();

    const pages: PageConfig[] = [];

    for (const file of files) {
      try {
        const content = JSON.parse(
          fs.readFileSync(path.join(resolved, file), 'utf-8'),
        ) as PageConfig | PageConfig[];
        const items: PageConfig[] = Array.isArray(content) ? content : [content];

        // Only include files that look like page configs (have path, name, phase)
        const validPages = items.filter(
          (item): item is PageConfig =>
            typeof item === 'object' &&
            item !== null &&
            'path' in item &&
            'name' in item &&
            'phase' in item,
        );

        if (validPages.length > 0) {
          pages.push(...validPages);
        }
      } catch {
        // Skip files that aren't valid JSON
      }
    }

    if (pages.length === 0) {
      console.error(`No valid page config JSON found in: ${resolved}`);
      process.exit(1);
    }

    return pages;
  }

  const raw = fs.readFileSync(resolved, 'utf-8');
  return parsePageJson(raw, resolved);
}


// ── Commands ────────────────────────────────────────────────────

function initCommand(): void {
  const hasTypeScript = fs.existsSync('tsconfig.json');
  const ext = hasTypeScript ? 'ts' : 'js';
  const configPath = `ui-patrol.config.${ext}`;

  if (fs.existsSync(configPath)) {
    console.log(`Config file already exists: ${configPath}`);
    process.exit(0);
  }

  // Also check if the other variant exists
  const altPath = `ui-patrol.config.${hasTypeScript ? 'js' : 'ts'}`;
  if (fs.existsSync(altPath)) {
    console.log(`Config file already exists: ${altPath}`);
    process.exit(0);
  }

  const importLine = hasTypeScript
    ? `import { defineConfig } from 'ui-patrol';`
    : `// @ts-check\n/** @type {import('ui-patrol').PatrolConfig} */`;

  const exportLine = hasTypeScript ? 'export default defineConfig({' : 'export default {';
  const closeLine = hasTypeScript ? '});' : '};';

  const content = `${importLine}

${exportLine}
  // Parent folder for all generated output (screenshots, logs)
  outputDir: '${DEFAULT_OUTPUT_DIR}',

  // Path to pages JSON file or directory. Default: "${DEFAULT_PAGES_PATH}"
  // pages: './${DEFAULT_PAGES_PATH}',

  runner: {
    // Base URL of your application
    baseUrl: '${RUNNER_DEFAULTS.baseUrl}',

    // Playwright browser: "chromium", "firefox", or "webkit"
    browser: '${RUNNER_DEFAULTS.browser}',

    // Run browser without visible window
    headless: ${RUNNER_DEFAULTS.headless},

    // Take full-page screenshots (false for viewport-only)
    fullPage: ${RUNNER_DEFAULTS.fullPage},

    // Ms the DOM must be quiet before taking screenshots (default: ${RUNNER_DEFAULTS.domSettleTimeout})
    // domSettleTimeout: ${RUNNER_DEFAULTS.domSettleTimeout},

    // Max ms to wait for DOM to settle (default: ${RUNNER_DEFAULTS.domSettleMax})
    // domSettleMax: ${RUNNER_DEFAULTS.domSettleMax},

    // Extra ms to wait after DOM settles — final buffer for canvas/WebGL (default: 0, off)
    // idleWait: 0,

    // CSS selector to wait for instead of DOM settle detection (most reliable for SPAs)
    // waitForSelector: '#app',

    // Retries per element before marking it missing (default: ${ELEMENT_RETRIES})
    // retries: ${ELEMENT_RETRIES},

    // Viewport size (default: ${RUNNER_DEFAULTS.viewportWidth}x${RUNNER_DEFAULTS.viewportHeight})
    // viewportWidth: ${RUNNER_DEFAULTS.viewportWidth},
    // viewportHeight: ${RUNNER_DEFAULTS.viewportHeight},

    // Device emulation (e.g., "iPhone 14", "Pixel 7")
    // device: 'iPhone 14',

    // Ignore self-signed certificate errors
    // ignoreHTTPSErrors: true,
  },

  review: {
    // OpenAI-compatible API endpoint
    apiUrl: '${REVIEW_DEFAULTS.apiUrl}',

    // Describe your app so the LLM reviewer understands what it's looking at
    // appDescription: 'E-commerce platform with product catalog, shopping cart, and checkout flow.',

    // API key from environment variable (only needed for hosted services)
    // apiKey: process.env.UI_PATROL_API_KEY,

    // Model name
    // model: 'gpt-4o',

    // Custom LLM instructions (inline text or file path)
    // instructions: './my-llm-prompt.md',

    // Request timeout in ms
    // timeout: ${REVIEW_DEFAULTS.timeout},
  },
${closeLine}
`;

  fs.writeFileSync(configPath, content, 'utf-8');
  console.log(
    `Created ${configPath}${hasTypeScript ? '' : ' (no tsconfig.json found, using JS)'}`,
  );
  console.log(`\nOutput will go to: ${DEFAULT_OUTPUT_DIR}/`);
  console.log('\nNext steps:');
  console.log(`  1. Edit ${configPath}`);
  console.log('  2. Create a pages.json (or run: npx ui-patrol example)');
  console.log('  3. Run: npx ui-patrol run');
}

function exampleCommand(): void {
  const filePath = 'pages.json';

  if (fs.existsSync(filePath)) {
    console.log(`File already exists: ${filePath}`);
    process.exit(0);
  }

  const examplePages: PageConfig[] = [
    {
      path: '/',
      name: 'Homepage',
      phase: 'guest',
      expectation:
        'Public homepage with navigation, hero section, and login/register links visible.',
      checks: [
        'page layout looks correct, nothing overlapping or broken',
        'login and register links are visible',
      ],
      actionGroups: [
        {
          description: 'Click login link',
          actions: [
            {
              label: 'Login link',
              selector: 'a[href="/login"]',
              navigatesAway: true,
              expectation: 'Navigated to the login page. Login form is visible.',
              checks: ['page changed to login form'],
            },
          ],
        },
      ],
    },
    {
      path: '/login',
      name: 'Login page',
      phase: 'guest',
      expectation:
        'Login form with email and password fields, a submit button, and a forgot password link.',
      checks: ['form fields are visible with labels', 'submit button is present'],
      actionGroups: [
        {
          description: 'Submit empty form to trigger validation',
          actions: [
            {
              label: 'Submit empty form',
              selector: 'button[type="submit"]',
              expectation: 'Validation errors appear below the email and password fields.',
              checks: ['red or warning-colored error messages are visible'],
            },
          ],
        },
      ],
    },
    {
      path: '/login',
      name: 'Login as user',
      phase: 'login',
      expectation:
        'Login form. Actions will fill credentials and submit to create an authenticated session.',
      checks: [],
      actionGroups: [
        {
          description: 'Fill credentials and submit',
          actions: [
            {
              label: 'Fill email',
              selector: '#email',
              typeText: 'user@example.com',
              expectation: 'Email field is filled with user@example.com.',
              checks: [],
            },
            {
              label: 'Fill password',
              selector: '#password',
              typeText: 'password',
              expectation: 'Password field is filled.',
              checks: [],
            },
            {
              label: 'Click login',
              selector: 'button[type="submit"]',
              waitAfter: 3000,
              saveSession: true,
              expectation: 'Redirected to the authenticated homepage or dashboard.',
              checks: ['no longer on the login page'],
            },
          ],
        },
      ],
    },
    {
      path: '/',
      name: 'Homepage (authenticated)',
      phase: 'auth',
      expectation:
        'Homepage with authenticated navigation. Profile and logout links visible. No login/register links.',
      checks: ['profile or account link is visible', 'no login or register links'],
      actionGroups: [],
    },
    {
      path: '/logout',
      name: 'Logout',
      phase: 'logout',
      expectation: 'Logged out. Redirected to the public homepage or login page.',
      checks: ['page shows guest/public content'],
      actionGroups: [
        {
          description: 'Trigger logout',
          actions: [
            {
              label: 'Navigate to logout',
              selector: 'a[href="/logout"]',
              clearSession: true,
              expectation: 'Session cleared. Redirected to public page.',
              checks: ['page shows guest/public content'],
            },
          ],
        },
      ],
    },
    {
      path: '/',
      name: 'Homepage (guest again)',
      phase: 'guest-after-logout',
      expectation:
        'Back to the public homepage. Login and register links visible again. No profile or logout links.',
      checks: ['login and register links are back', 'no profile or logout links'],
      actionGroups: [],
    },
  ];

  fs.writeFileSync(filePath, JSON.stringify(examplePages, null, 2) + '\n', 'utf-8');
  console.log(`Created ${filePath}`);
  console.log('\nThis example shows:');
  console.log('  1. Guest pages — visit homepage and login page without auth');
  console.log('  2. Login flow — fill credentials, submit with saveSession: true on the action');
  console.log('  3. Authenticated pages — visit pages with the saved session');
  console.log('  4. Logout — click logout with clearSession: true on the action');
  console.log('  5. Guest again — verify auth is gone');
  console.log('\nEdit the selectors and URLs to match your app, then run:');
  console.log('  npx ui-patrol run');
}


async function runCommand(args: Record<string, string>): Promise<void> {
  const fileConfig = await loadConfigFile(args['config']);

  // CLI --output-dir overrides config
  if (args['output-dir']) {
    fileConfig.outputDir = args['output-dir'];
  }

  const paths = resolvePaths(fileConfig);

  // Pages: CLI flag > config file > default (pages.json in root)
  const pagesArg = args['pages'] ?? fileConfig.pages ?? DEFAULT_PAGES_PATH;
  let allPages = await loadPages(pagesArg);

  if (args['page']) {
    const filter = args['page'].toLowerCase();
    allPages = allPages.filter((p) => p.name.toLowerCase() === filter);
    if (allPages.length === 0) {
      console.error(`No page found matching "${args['page']}".`);
      process.exit(1);
    }
  }

  console.log(`Loaded ${allPages.length} page(s)`);
  console.log(`Output: ${path.resolve(paths.outputDir)}/`);

  const runnerConfig: RunnerConfig = { ...fileConfig.runner };
  if (args['base-url']) runnerConfig.baseUrl = args['base-url'];
  if (args['browser']) runnerConfig.browser = args['browser'] as RunnerConfig['browser'];
  if (args['headed']) runnerConfig.headless = false;
  if (args['device']) runnerConfig.device = args['device'];
  if (args['viewport-only']) runnerConfig.fullPage = false;
  if (args['wait-for']) runnerConfig.waitForSelector = args['wait-for'];
  if (args['retries']) runnerConfig.retries = parseInt(args['retries'], 10);

  const runner = new PatrolRunner(runnerConfig, paths.outputDir);
  const result = await runner.launch(allPages);

  let hasFailures = result.summary.totalErrors > 0 || result.summary.elementsMissing > 0;

  // --review: also run LLM review on the screenshots
  if (args['review']) {
    const fileReview: ReviewConfig = fileConfig.review ?? {};
    const reviewConfig: ReviewConfig = {
      apiUrl: args['api-url'] ?? fileReview.apiUrl,
      apiKey: args['api-key'] ?? fileReview.apiKey,
      model: args['model'] ?? fileReview.model,
      instructions: args['instructions'] ?? fileReview.instructions,
      appDescription: fileReview.appDescription,
    };

    const reviewer = new PatrolReviewer(reviewConfig);
    const items = reviewer.buildReviewItems(allPages, paths.screenshotDir);

    const displayUrl =
      reviewConfig.apiUrl ?? process.env.LLM_API_URL ?? 'http://localhost:8080/v1/chat/completions';
    console.log(`\nLLM Review: ${displayUrl}`);
    console.log(`Reviewing ${items.length} screenshot(s)...\n`);

    const report = await reviewer.review(items, {
      pageFilter: args['page'],
      onProgress: (index, total, item, reviewResult) => {
        const label = item.elementLabel
          ? `${item.page} — ${item.action}: ${item.elementLabel}`
          : `${item.page} — ${item.action}`;
        const prefix = `[${index + 1}/${total}]`;

        if (reviewResult.verdict === 'pass') {
          console.log(`${prefix} ✓ PASS  ${label}`);
          console.log(`         ${reviewResult.reasoning}`);
        } else {
          console.log(`${prefix} ✗ FAIL  ${label}`);
          console.log(`         ${reviewResult.reasoning}`);
          for (const issue of reviewResult.issues) {
            console.log(`         - ${issue}`);
          }
        }
        console.log();
      },
    });

    fs.mkdirSync(paths.logDir, { recursive: true });
    const reportPath = path.join(paths.logDir, 'ui-patrol-review.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');

    console.log('═══════════════════════════════════════');
    console.log('  Visual Review Report');
    console.log(
      `  Total: ${report.summary.total} | Passed: ${report.summary.passed} | Failed: ${report.summary.failed}`,
    );
    console.log('═══════════════════════════════════════');

    if (report.summary.failed > 0) hasFailures = true;
  }

  process.exit(hasFailures ? 1 : 0);
}

async function reviewCommand(args: Record<string, string>): Promise<void> {
  const fileConfig = await loadConfigFile(args['config']);

  if (args['output-dir']) {
    fileConfig.outputDir = args['output-dir'];
  }

  const paths = resolvePaths(fileConfig);

  // Load pages: CLI flag > config file > saved from last run > default (current directory)
  let pages: PageConfig[];
  const pagesArg = args['pages'] ?? fileConfig.pages;

  if (pagesArg) {
    pages = await loadPages(pagesArg);
  } else {
    const savedPath = path.join(path.resolve(paths.logDir), 'ui-patrol-pages.json');

    if (fs.existsSync(savedPath)) {
      console.log(`Using page configs from last run: ${savedPath}`);
      pages = JSON.parse(fs.readFileSync(savedPath, 'utf-8')) as PageConfig[];
    } else {
      // Fall back to default pages.json
      pages = await loadPages(DEFAULT_PAGES_PATH);
    }
  }

  const fileReview: ReviewConfig = fileConfig.review ?? {};

  // Build review config: CLI > config file > defaults
  const reviewConfig: ReviewConfig = {
    apiUrl: args['api-url'] ?? fileReview.apiUrl,
    apiKey: args['api-key'] ?? fileReview.apiKey,
    model: args['model'] ?? fileReview.model,
    instructions: args['instructions'] ?? fileReview.instructions,
    appDescription: fileReview.appDescription,
  };

  const reviewer = new PatrolReviewer(reviewConfig);
  const items = reviewer.buildReviewItems(pages, paths.screenshotDir);

  const displayUrl =
    reviewConfig.apiUrl ?? process.env.LLM_API_URL ?? 'http://localhost:8080/v1/chat/completions';
  console.log(`API: ${displayUrl}`);
  console.log(`Model: ${reviewConfig.model ?? 'default'}`);
  console.log(`Reviewing ${items.length} screenshot(s)...\n`);

  const report = await reviewer.review(items, {
    pageFilter: args['page'],
    onProgress: (index, total, item, result) => {
      const label = item.elementLabel
        ? `${item.page} — ${item.action}: ${item.elementLabel}`
        : `${item.page} — ${item.action}`;
      const prefix = `[${index + 1}/${total}]`;

      if (result.verdict === 'pass') {
        console.log(`${prefix} ✓ PASS  ${label}`);
        console.log(`         ${result.reasoning}`);
      } else {
        console.log(`${prefix} ✗ FAIL  ${label}`);
        console.log(`         ${result.reasoning}`);
        for (const issue of result.issues) {
          console.log(`         - ${issue}`);
        }
      }
      console.log();
    },
  });

  fs.mkdirSync(paths.logDir, { recursive: true });
  const reportPath = args['report'] ?? path.join(paths.logDir, 'ui-patrol-review.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');

  console.log('═══════════════════════════════════════');
  console.log('  Visual Review Report');
  console.log(
    `  Total: ${report.summary.total} | Passed: ${report.summary.passed} | Failed: ${report.summary.failed}`,
  );
  console.log('═══════════════════════════════════════');
  console.log(`Report saved to: ${reportPath}`);

  process.exit(report.summary.failed > 0 ? 1 : 0);
}

// ── Generate command ─────────────────────────────────────────────

async function generateCommand(args: Record<string, string>): Promise<void> {
  const fileConfig = await loadConfigFile(args['config']);
  const url = args['_arg'];

  if (!url) {
    console.error('Error: provide a URL. Example: ui-patrol generate /dashboard');
    process.exit(1);
  }

  const fileReview: ReviewConfig = fileConfig.review ?? {};

  const mode = args['smart'] ? 'smart' : args['ai'] ? 'ai' : 'none';

  const config = await generatePage(url, {
    baseUrl: args['base-url'] ?? fileConfig.runner?.baseUrl,
    browser: (args['browser'] as 'chromium' | 'firefox' | 'webkit') ?? fileConfig.runner?.browser,
    headless: !args['headed'],
    phase: args['phase'],
    name: args['name'],
    mode,
    review: {
      apiUrl: args['api-url'] ?? fileReview.apiUrl,
      apiKey: args['api-key'] ?? fileReview.apiKey,
      model: args['model'] ?? fileReview.model,
    },
  });

  const json = JSON.stringify([config], null, 2) + '\n';

  // --dry-run: print to stdout and exit
  if (args['dry-run']) {
    process.stdout.write(json);
    return;
  }

  // Output: --output flag > generateDir from config > current directory
  const outputPath = args['output'];
  if (outputPath) {
    const dir = path.dirname(outputPath);
    if (dir !== '.') fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outputPath, json, 'utf-8');
    console.log(`\n✅ Saved to ${outputPath}`);
  } else {
    const generateDir = fileConfig.generateDir ?? '.';
    const filename = `${config.phase}-${config.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.json`;
    const filePath = path.join(generateDir, filename);
    if (generateDir !== '.') fs.mkdirSync(generateDir, { recursive: true });
    fs.writeFileSync(filePath, json, 'utf-8');
    console.log(`\n✅ Saved to ${filePath}`);
  }
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args['_command'];

  if (!command || command === 'help' || args['help']) {
    usage();
    process.exit(0);
  }

  switch (command) {
    case 'init':
      initCommand();
      break;
    case 'example':
      exampleCommand();
      break;
    case 'run':
      await runCommand(args);
      break;
    case 'review':
      await reviewCommand(args);
      break;
    case 'generate':
      await generateCommand(args);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      usage();
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
