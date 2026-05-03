# ui-patrol

Framework-agnostic UI testing tool with LLM-powered visual review.

Navigates your pages, clicks elements, fills forms, takes screenshots, captures browser console errors — and optionally sends screenshots to an LLM to verify everything looks right.

Works with any app that renders in a browser: Laravel, Django, Express, Vue, React, Next.js, Rust Tauri, Dioxus, Yew, Flask, static sites — anything with a URL.

## Install

```bash
npm install -D ui-patrol
npx playwright install chromium
```

On install, the package automatically:
- Creates `ui-patrol.config.ts` (or `.js` if no TypeScript) with all options
- Creates `pages.json` with an example flow (guest → login → auth → logout)
- Adds npm scripts: `patrol`, `patrol:review`, `patrol:full`

## Quick Start

```bash
# Edit pages.json to match your app, then:
npm run patrol              # take screenshots
npm run patrol:review       # LLM review existing screenshots
npm run patrol:full         # screenshots + LLM review in one go
```

Or with npx directly:

```bash
npx ui-patrol run             # take screenshots
npx ui-patrol run --review    # screenshots + LLM review
npx ui-patrol review          # LLM review on existing screenshots
npx ui-patrol generate /login # auto-generate page config from a live URL
npx ui-patrol init            # regenerate config
npx ui-patrol example         # regenerate example pages.json
```

## How It Works

1. You provide page configs as JSON (file, directory, or stdin)
2. Pages execute in the order you provide them
3. For each page: navigate → wait for network idle → wait `idleWait` → screenshot
4. For each action: click/type → wait for network idle → wait `idleWait` → screenshot
5. Browser console errors and warnings are captured per page/action
6. `saveSession` / `clearSession` flags control auth state between pages
7. With `--review`: screenshots + expectations are sent to an LLM for visual verification

---

## Pages JSON Reference

Pages are the input. Provide them as a JSON file, a directory of JSON files, or piped via stdin.

Default location: `pages.json` in project root.

### PageConfig

Each page is an object in the array. Pages execute in order.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `path` | `string` | **yes** | — | URL path to visit (e.g., `"/login"`) |
| `name` | `string` | **yes** | — | Human-readable page name |
| `phase` | `string` | **yes** | — | Screenshot folder name (e.g., `"guest"`, `"auth"`) |
| `expectation` | `string` | **yes** | — | What the page should look like (for LLM review) |
| `checks` | `string[]` | **yes** | — | Plain English checks for the LLM to verify |
| `actionGroups` | `ActionGroup[]` | **yes** | — | Groups of UI interactions (can be empty `[]`) |
| `saveSession` | `boolean` | no | `false` | Save browser session (cookies, localStorage) after this page |
| `clearSession` | `boolean` | no | `false` | Wipe saved session before this page |
| `idleWait` | `number` | no | config value | Override idle wait for this page (ms) |
| `fullPage` | `boolean` | no | config value | Override full-page screenshot (`false` for viewport-only) |
| `expectedErrors` | `string[]` | no | `[]` | Regex patterns for expected console errors to ignore |

### ActionGroup

Groups of chained actions. Between groups, the page reloads for a clean state. Within a group, actions run sequentially without reload.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `description` | `string` | **yes** | What this group tests |
| `actions` | `Action[]` | **yes** | Chained actions |

### Action

A single UI interaction (click or type).

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `label` | `string` | **yes** | — | Human-readable label |
| `selector` | `string` | **yes** | — | CSS selector to find the element |
| `expectation` | `string` | **yes** | — | What the screenshot should show after this action |
| `checks` | `string[]` | **yes** | — | Plain English checks for the LLM |
| `typeText` | `string` | no | — | Fill element with this text instead of clicking |
| `navigatesAway` | `boolean` | no | `false` | Reload original page URL after taking the screenshot |
| `waitAfter` | `number` | no | — | Explicit wait in ms (skips network idle wait) |
| `screenshotSelector` | `string` | no | — | CSS selector of element to screenshot instead of full page |

### Session Management

Login is just a page with actions and `saveSession: true`. No separate auth config needed.

- **`saveSession: true`** — After this page runs (including its actions), cookies and localStorage are saved. All following pages use that session.
- **`clearSession: true`** — Before this page runs, the saved session is wiped. This page and all following pages run without authentication.

You can have multiple login/logout cycles in one run:

```json
[
  { "phase": "guest", "path": "/", ... },
  { "phase": "login", "path": "/login", "saveSession": true, ... },
  { "phase": "user", "path": "/profile", ... },
  { "phase": "logout", "path": "/", "clearSession": true, ... },
  { "phase": "admin-login", "path": "/login", "saveSession": true, ... },
  { "phase": "admin", "path": "/admin", ... }
]
```

### Waiting Behavior

After every navigation and action:
1. Wait for **network idle** (Playwright waits until zero network requests for 500ms — handles async API calls automatically)
2. Wait an extra **`idleWait`** buffer for the UI to re-render (default: 2 seconds)
3. Take screenshot

Override per page with `idleWait`, or per action with `waitAfter` (which replaces the network idle + idleWait with a fixed delay).

### Focused Screenshots

For small UI elements like dropdowns or popovers, use `screenshotSelector` on an action to capture just that element instead of the full page:

```json
{
  "label": "Open role filter",
  "selector": "button.filter-toggle",
  "screenshotSelector": ".floating-panel",
  "expectation": "Dropdown with role checkboxes",
  "checks": ["dropdown is open"]
}
```

### Screenshot Paths

Screenshots are auto-organized:

```
{outputDir}/screenshots/{phase}/{page-slug}/navigate.png
{outputDir}/screenshots/{phase}/{page-slug}/{group-slug}/{index}.{action-slug}.png
```

---

## Config File Reference

Place `ui-patrol.config.ts` (or `.js` / `.json`) in your project root. Auto-detected by the CLI. Run `npx ui-patrol init` to generate one with all options.

The config supports TypeScript — use `defineConfig()` for type checking and autocomplete:

```typescript
import { defineConfig } from 'ui-patrol';

export default defineConfig({
  runner: {
    baseUrl: process.env.CI ? 'http://app:8000' : 'http://localhost:8000',
  },
  review: {
    apiKey: process.env.UI_PATROL_API_KEY,
  },
});
```

**No fields are required.** Every field has a sensible default.

### Top-Level

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `outputDir` | `string` | `"./ui-patrol"` | Parent folder for all generated output (screenshots, logs) |
| `pages` | `string` | `"pages.json"` | Path to pages JSON file or directory of JSON files |
| `generateDir` | `string` | `"."` | Directory where `generate` saves page configs |
| `runner` | `object` | `{}` | Runner configuration (see below) |
| `review` | `object` | `{}` | LLM review configuration (see below) |

### `runner`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `baseUrl` | `string` | `"http://localhost:8000"` | Base URL of your application |
| `browser` | `string` | `"chromium"` | Playwright browser: `"chromium"`, `"firefox"`, or `"webkit"` |
| `headless` | `boolean` | `true` | Run browser without visible window |
| `viewportWidth` | `number` | `1280` | Browser viewport width in pixels |
| `viewportHeight` | `number` | `720` | Browser viewport height in pixels |
| `fullPage` | `boolean` | `true` | Take full-page screenshots (`false` for viewport-only) |
| `idleWait` | `number` | `2000` | Ms to wait after network idle before screenshotting |
| `device` | `string` | — | Playwright device emulation (e.g., `"iPhone 14"`, `"Pixel 7"`) |
| `ignoreHTTPSErrors` | `boolean` | `false` | Ignore self-signed certificate errors |

### `review`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `apiUrl` | `string` | `"http://localhost:8080/v1/chat/completions"` | OpenAI-compatible API endpoint |
| `apiKey` | `string` | — | API key (use env var in TS config, or `--api-key` flag) |
| `model` | `string` | `"local"` | Model name to use |
| `instructions` | `string` | built-in | Custom LLM prompt (inline text or file path) |
| `timeout` | `number` | `300000` | Request timeout in ms |

### Compatible LLM Servers

Any OpenAI-compatible `/v1/chat/completions` endpoint works:

| Server | API URL | Key needed? |
|---|---|---|
| llama.cpp (default) | `http://localhost:8080/v1/chat/completions` | No |
| LM Studio | `http://localhost:1234/v1/chat/completions` | No |
| Ollama | `http://localhost:11434/v1/chat/completions` | No |
| OpenAI | `https://api.openai.com/v1/chat/completions` | Yes |
| OpenRouter | `https://openrouter.ai/api/v1/chat/completions` | Yes |
| Groq | `https://api.groq.com/openai/v1/chat/completions` | Yes |

---

## CLI Reference

### Commands

| Command | Description |
|---|---|
| `ui-patrol run [options]` | Navigate pages, click elements, take screenshots |
| `ui-patrol run --review [options]` | Same + LLM review after |
| `ui-patrol review [options]` | LLM review on existing screenshots |
| `ui-patrol generate <url> [options]` | Auto-generate page config from a live URL |
| `ui-patrol init` | Generate config file with all options |
| `ui-patrol example` | Generate example `pages.json` |
| `ui-patrol help` | Show help |

### npm Scripts (auto-added on install)

| Script | Command |
|---|---|
| `npm run patrol` | `ui-patrol run` |
| `npm run patrol:review` | `ui-patrol review` |
| `npm run patrol:full` | `ui-patrol run --review` |

Pass extra flags with `--`: `npm run patrol -- --page "Login"`

### Run Options

| Flag | Description |
|---|---|
| `--pages <path>` | JSON file, directory, or `"-"` for stdin |
| `--config <path>` | Path to config file |
| `--output-dir <dir>` | Override output directory |
| `--base-url <url>` | Override base URL |
| `--page <name>` | Only run a specific page by name |
| `--browser <name>` | Browser: chromium, firefox, webkit |
| `--headed` | Run browser with visible window |
| `--device <name>` | Device emulation |
| `--viewport-only` | Viewport-only screenshots |
| `--review` | Also run LLM review after screenshots |

### Review Options

| Flag | Description |
|---|---|
| `--pages <path>` | JSON file, directory, or `"-"` for stdin |
| `--output-dir <dir>` | Override output directory |
| `--api-url <url>` | Override LLM API URL |
| `--api-key <key>` | API key (prefer env var instead) |
| `--model <name>` | Override model name |
| `--instructions <path>` | Custom LLM instruction file or inline text |
| `--page <name>` | Only review a specific page |
| `--report <path>` | Override report output path |

### Generate Options

| Flag | Description |
|---|---|
| `<url>` | URL path to crawl (e.g., `/login`, `/dashboard`) |
| `--ai` | Use LLM to fill expectations and checks (keeps heuristic grouping) |
| `--smart` | Use LLM for everything: fill + reorganize + detect flows |
| `--phase <name>` | Override phase/folder name (default: derived from URL) |
| `--name <name>` | Override page name (default: derived from URL) |
| `--output <path>` | Output file path (default: auto-named in project root) |
| `--api-url <url>` | LLM API URL (for `--ai` and `--smart`) |
| `--api-key <key>` | LLM API key (for `--ai` and `--smart`) |
| `--model <name>` | LLM model (for `--ai` and `--smart`) |

### Examples

```bash
# Basic
ui-patrol run --pages ./pages.json
ui-patrol run --pages ./pages.json --review

# Override base URL
ui-patrol run --base-url http://localhost:1420

# Directory of page files
ui-patrol run --pages ./my-pages/

# Single page
ui-patrol run --page "Admin Dashboard"

# Firefox, visible window
ui-patrol run --browser firefox --headed

# Mobile emulation
ui-patrol run --device "iPhone 14"

# Review existing screenshots
ui-patrol review
ui-patrol review --page "Dashboard"

# Generate page configs from live URLs
ui-patrol generate /login                          # heuristic only, no LLM
ui-patrol generate /login --ai                     # LLM fills expectations/checks
ui-patrol generate /login --smart                  # LLM fills + reorganizes + detects flows
ui-patrol generate /login --smart --output pages/login.json

# Pipe from any language
php artisan generate:pages | ui-patrol run --pages -
python generate_pages.py | ui-patrol run --pages -
cargo run --bin pages | ui-patrol run --pages -
```

---

## Auto-Generate Page Configs

Instead of writing `pages.json` by hand, use `generate` to crawl a live URL and create the config automatically.

### Three modes

```bash
# 1. Heuristic only — fast, no LLM needed
ui-patrol generate /login

# 2. AI — heuristic grouping + LLM fills expectations and checks
ui-patrol generate /login --ai

# 3. Smart — heuristic + LLM fills + LLM reorganizes into logical test flows
ui-patrol generate /login --smart
```

**Heuristic mode** crawls the page, finds all interactive elements (buttons, links, inputs, tabs), and groups them intelligently:
- Detects login forms (email + password + submit) and creates a "Login flow" with pre-filled credentials
- Groups form inputs with their submit button
- Filters out header chrome (theme toggles, language switchers)
- Separates content links from navigation

**AI mode** does everything heuristic does, then sends a screenshot to the LLM to fill in expectations and checks for each action.

**Smart mode** does everything AI does, then sends the filled config back to the LLM for a second pass to reorganize groups into logical test flows (validation first, then main flow, then secondary actions), remove duplicates, and add page-level flags like `saveSession` on login pages.

### Output location

By default, files are saved to the project root with an auto-generated name. Override with `--output`:

```bash
ui-patrol generate /login --output pages/login.json
```

Or set a default directory in your config:

```typescript
export default defineConfig({
  generateDir: './generated-pages',
});
```

---

## Output Structure

```
ui-patrol/
├── .gitignore                    # auto-created, ignores all output
├── screenshots/
│   ├── {phase}/
│   │   └── {page-slug}/
│   │       ├── navigate.png
│   │       └── {group-slug}/
│   │           ├── 1.{action-slug}.png
│   │           └── 2.{action-slug}.png
└── logs/
    ├── ui-patrol-log.json        # run results (entries, errors, summary)
    ├── ui-patrol-pages.json      # saved page configs from last run
    └── ui-patrol-review.json     # LLM review report
```

---

## Programmatic Usage

### One-liner: run + LLM review

```typescript
import { patrol, type PageConfig } from 'ui-patrol';

const pages: PageConfig[] = [
  { path: '/', name: 'Home', phase: 'guest', expectation: 'Homepage', checks: ['layout looks correct'], actionGroups: [] },
];

const { run, review } = await patrol(pages, {
  baseUrl: 'http://localhost:3000',
  review: true,
});

console.log(`Errors: ${run.summary.totalErrors}`);
console.log(`LLM: ${review?.summary.failed} failed`);
```

### Inside a Playwright test

```typescript
import { test, expect } from '@playwright/test';
import { patrol, type PageConfig } from 'ui-patrol';

const pages: PageConfig[] = [ /* your pages */ ];

test('full UI patrol with LLM review', async ({ browser }) => {
  test.setTimeout(120_000);

  const { run, review } = await patrol(pages, {
    baseUrl: 'http://localhost:3000',
    playwrightBrowser: browser,
    review: true,
  });

  expect(run.summary.totalErrors).toBe(0);
  expect(run.summary.elementsMissing).toBe(0);
  expect(review?.summary.failed).toBe(0);
});
```

### Run only (no LLM)

```typescript
const { run } = await patrol(pages, { baseUrl: 'http://localhost:3000' });
```

### Override review settings programmatically

```typescript
const { run, review } = await patrol(pages, {
  review: true,
  reviewConfig: { apiUrl: 'https://api.openai.com/v1/chat/completions' },
});
```

---

## Generating Pages JSON

The package only cares about valid JSON. Generate it however you want:

- **Hand-written** — just write `pages.json`
- **TypeScript** — use the exported `PageConfig` type for autocomplete, serialize to JSON
- **PHP** — `json_encode()` an array
- **Python** — `json.dump()` a dict
- **Rust** — `serde_json::to_string()` a struct
- **Pipe from any language** — `your-command | ui-patrol run --pages -`

## License

MIT
