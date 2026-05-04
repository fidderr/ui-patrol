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
3. For each page: navigate → wait for network idle → wait for DOM to settle → screenshot
4. For each action: click/type → wait for network idle → wait for DOM to settle → screenshot
5. Browser console errors and warnings are captured per page and per action
6. `saveSession` / `clearSession` on actions control auth state between pages
7. With `--review`: screenshots + expectations are sent to an LLM for visual verification

### Wait Strategy

After every navigation and action, the runner waits for the page to be ready:

1. **Network idle** — Tracks all pending network requests. Once zero requests are in flight for `networkIdleWait` ms (default: 100ms), the network is considered settled. If a new request starts during the quiet period, the timer resets. Safety cap: `networkIdleMax` (default: 20000ms).
2. **DOM settle** — A MutationObserver watches the DOM. Once no mutations happen for `domIdleWait` ms (default: 100ms), the page is considered settled. If the DOM changes during the quiet period, the timer resets. Safety cap: `domIdleMax` (default: 20000ms).
3. **waitForSelector** — If set, waits for the specified CSS selector to be visible after network idle and DOM settle.
4. **Screenshot**

All three run in sequence (AND, not OR). `waitForSelector` is an additional check on top of the default strategy, not a replacement.

---

## Pages JSON Reference

Pages are the input. Provide them as a JSON file, a directory of JSON files, or piped via stdin.

Default location: `pages.json` in project root.

### PageConfig

Each page is an object in the array. Pages execute in order.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | `string` | **yes** | URL path to visit (e.g., `"/login"`) |
| `name` | `string` | **yes** | Human-readable page name |
| `phase` | `string` | **yes** | Screenshot folder name (e.g., `"guest"`, `"auth"`) |
| `expectation` | `string` | **yes** | What the page should look like (for LLM review) |
| `checks` | `string[]` | **yes** | Plain English checks for the LLM to verify |
| `actionGroups` | `ActionGroup[]` | **yes** | Groups of UI interactions (can be empty `[]`) |
| `expectedErrors` | `string[]` | no | Regex patterns for expected console errors on page navigation |
| `networkIdleWait` | `number` | no | Override: ms the network must be quiet before settled |
| `networkIdleMax` | `number` | no | Override: max ms to wait for network to settle |
| `domIdleWait` | `number` | no | Override: ms the DOM must be quiet before settled |
| `domIdleMax` | `number` | no | Override: max ms to wait for DOM to settle |
| `waitForSelector` | `string` | no | Override: CSS selector to also wait for after networkidle + DOM settle |
| `fullPage` | `boolean` | no | Override: `false` for viewport-only screenshots |
| `retries` | `number` | no | Override: retries per element before marking missing |
| `screenshot` | `boolean` | no | `false` to skip screenshots on this page |
| `screenshotSelector` | `string` | no | CSS selector of element to screenshot instead of full page |

Page-level options only affect the page navigation screenshot. They do **not** cascade to actions — actions use their own values or fall back to the config.

### ActionGroup

Groups of chained actions. Between groups, the page reloads for a clean state. Within a group, actions run sequentially without reload.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `description` | `string` | **yes** | What this group tests |
| `actions` | `Action[]` | **yes** | Chained actions |

### Action

A single UI interaction (click or type).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | **yes** | Human-readable name |
| `selector` | `string` | **yes** | CSS selector to find the element |
| `expectation` | `string` | **yes** | What the screenshot should show after this action |
| `checks` | `string[]` | **yes** | Plain English checks for the LLM |
| `typeText` | `string` | no | Fill element with this text instead of clicking |
| `nth` | `number` | no | 0-based index when selector matches multiple elements (default: 0) |
| `navigatesAway` | `boolean` | no | Reload original page URL after taking the screenshot |
| `saveSession` | `boolean` | no | Save browser session after this action completes |
| `clearSession` | `boolean` | no | Clear browser session after this action completes |
| `expectedErrors` | `string[]` | no | Regex patterns for expected console errors after this action |
| `networkIdleWait` | `number` | no | Override: ms the network must be quiet before settled |
| `networkIdleMax` | `number` | no | Override: max ms to wait for network to settle |
| `domIdleWait` | `number` | no | Override: ms the DOM must be quiet before settled |
| `domIdleMax` | `number` | no | Override: max ms to wait for DOM to settle |
| `waitForSelector` | `string` | no | Override: CSS selector to also wait for after networkidle + DOM settle |
| `fullPage` | `boolean` | no | Override: `false` for viewport-only screenshots |
| `retries` | `number` | no | Override: retries per element before marking missing |
| `screenshot` | `boolean` | no | `false` to skip the screenshot (action still runs) |
| `screenshotSelector` | `string` | no | CSS selector of element to screenshot instead of full page |

### Option Cascade

Optional fields cascade: **action → config → defaults** for actions, **page → config → defaults** for page navigation. Page settings do not affect actions.

### Session Management

Session control is action-level. Put `saveSession` on the action that triggers login (e.g., the submit button click), and `clearSession` on the action that triggers logout.

```json
[
  {
    "path": "/login", "name": "Login", "phase": "login",
    "expectation": "Login form", "checks": [],
    "actionGroups": [{
      "description": "Fill credentials and submit",
      "actions": [
        { "name": "Fill email", "selector": "#email", "typeText": "user@example.com", "expectation": "", "checks": [] },
        { "name": "Fill password", "selector": "#password", "typeText": "password", "expectation": "", "checks": [] },
        { "name": "Submit", "selector": "button[type=\"submit\"]", "saveSession": true, "expectation": "Redirected to dashboard", "checks": ["not on login page"] }
      ]
    }]
  },
  {
    "path": "/dashboard", "name": "Dashboard", "phase": "auth",
    "expectation": "Authenticated dashboard", "checks": ["user menu visible"],
    "actionGroups": []
  },
  {
    "path": "/logout", "name": "Logout", "phase": "logout",
    "expectation": "Logout page", "checks": [],
    "actionGroups": [{
      "description": "Trigger logout",
      "actions": [
        { "name": "Click logout", "selector": "a[href=\"/logout\"]", "clearSession": true, "expectation": "Redirected to public page", "checks": ["guest content visible"] }
      ]
    }]
  }
]
```

### Focused Screenshots

For small UI elements like dropdowns or popovers, use `screenshotSelector` to capture just that element:

```json
{
  "name": "Open role filter",
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

```typescript
import { defineConfig } from 'ui-patrol';

export default defineConfig({
  runner: {
    baseUrl: process.env.CI ? 'http://app:8000' : 'http://localhost:8000',
  },
  review: {
    apiKey: process.env.UI_PATROL_API_KEY,
    appDescription: 'E-commerce platform with product catalog, shopping cart, and checkout flow.',
  },
});
```

**No fields are required.** Every field has a sensible default.

### Top-Level

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `outputDir` | `string` | `"./ui-patrol"` | Parent folder for all generated output |
| `pages` | `string` | `"pages.json"` | Path to pages JSON file or directory |
| `generateDir` | `string` | `"."` | Directory where `generate` saves page configs |
| `runner` | `object` | `{}` | Runner configuration |
| `review` | `object` | `{}` | LLM review configuration |

### `runner`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `baseUrl` | `string` | `"http://localhost:8000"` | Base URL of your application |
| `browser` | `string` | `"chromium"` | `"chromium"`, `"firefox"`, or `"webkit"` |
| `headless` | `boolean` | `true` | Run browser without visible window |
| `viewportWidth` | `number` | `1280` | Browser viewport width |
| `viewportHeight` | `number` | `720` | Browser viewport height |
| `fullPage` | `boolean` | `true` | Full-page screenshots (`false` for viewport-only) |
| `networkIdleWait` | `number` | `100` | Ms the network must be quiet (zero pending requests) before settled |
| `networkIdleMax` | `number` | `20000` | Max ms to wait for network to settle |
| `domIdleWait` | `number` | `100` | Ms the DOM must be quiet before settled |
| `domIdleMax` | `number` | `20000` | Max ms to wait for DOM to settle |
| `waitForSelector` | `string` | — | CSS selector to also wait for after networkidle + DOM settle |
| `retries` | `number` | `2` | Retries per element before marking missing |
| `screenshot` | `boolean` | `true` | Set to `false` to skip all screenshots |
| `screenshotSelector` | `string` | — | CSS selector of element to screenshot instead of full page |
| `device` | `string` | — | Playwright device emulation (e.g., `"iPhone 14"`) |
| `ignoreHTTPSErrors` | `boolean` | `false` | Ignore self-signed certificate errors |

### `review`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `apiUrl` | `string` | `"http://localhost:8080/v1/chat/completions"` | OpenAI-compatible API endpoint |
| `apiKey` | `string` | — | API key |
| `model` | `string` | `"local"` | Model name |
| `instructions` | `string` | built-in | Custom LLM prompt (inline text or file path) |
| `timeout` | `number` | `300000` | Request timeout in ms |
| `appDescription` | `string` | — | Description of your app, included in LLM prompts for context |

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
| `ui-patrol run --review` | Same + LLM review after |
| `ui-patrol review [options]` | LLM review on existing screenshots |
| `ui-patrol generate <url>` | Auto-generate page config from a live URL |
| `ui-patrol init` | Generate config file |
| `ui-patrol example` | Generate example `pages.json` |

### npm Scripts (auto-added on install)

| Script | Command |
|---|---|
| `npm run patrol` | `ui-patrol run` |
| `npm run patrol:review` | `ui-patrol review` |
| `npm run patrol:full` | `ui-patrol run --review` |

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
| `--wait-for <selector>` | CSS selector to also wait for after networkidle + DOM settle |
| `--retries <n>` | Retries per element before marking missing |
| `--network-idle-wait <ms>` | Ms the network must be quiet before settled |
| `--network-idle-max <ms>` | Max ms to wait for network to settle |
| `--dom-idle-wait <ms>` | Ms the DOM must be quiet before settled |
| `--dom-idle-max <ms>` | Max ms to wait for DOM to settle |
| `--review` | Also run LLM review after screenshots |

### Review Options

| Flag | Description |
|---|---|
| `--pages <path>` | JSON file, directory, or `"-"` for stdin |
| `--output-dir <dir>` | Override output directory |
| `--api-url <url>` | Override LLM API URL |
| `--api-key <key>` | API key |
| `--model <name>` | Override model name |
| `--instructions <path>` | Custom LLM instruction file |
| `--page <name>` | Only review a specific page |
| `--report <path>` | Override report output path |

### Generate Options

| Flag | Description |
|---|---|
| `<url>` | URL path to crawl (e.g., `/login`) |
| `--ai` | LLM fills expectations and checks |
| `--smart` | LLM fills + reorganizes into logical test flows |
| `--phase <name>` | Override phase name |
| `--name <name>` | Override page name |
| `--output <path>` | Output file path |
| `--dry-run` | Print generated config to stdout instead of writing a file |
| `--api-url <url>` | LLM API URL |
| `--api-key <key>` | LLM API key |
| `--model <name>` | LLM model |

### Examples

```bash
# Basic
ui-patrol run --pages ./pages.json
ui-patrol run --pages ./pages.json --review

# Override base URL
ui-patrol run --base-url http://localhost:1420

# Single page
ui-patrol run --page "Admin Dashboard"

# Firefox, visible window
ui-patrol run --browser firefox --headed

# Mobile emulation
ui-patrol run --device "iPhone 14"

# Custom wait strategy
ui-patrol run --wait-for "#app-loaded"
ui-patrol run --dom-idle-wait 500 --dom-idle-max 10000

# Review existing screenshots
ui-patrol review
ui-patrol review --page "Dashboard"

# Generate page configs
ui-patrol generate /login
ui-patrol generate /login --ai
ui-patrol generate /login --smart
ui-patrol generate /login --smart --output pages/login.json
ui-patrol generate /dashboard --dry-run | jq .

# Pipe from any language
php artisan generate:pages | ui-patrol run --pages -
python generate_pages.py | ui-patrol run --pages -
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
- Detects login forms, registration forms, and search forms
- Creates flows with pre-filled test data based on input types
- Filters out header chrome (theme toggles, language switchers)
- Warns about non-unique selectors (add `data-testid` for better coverage)

**AI mode** does everything heuristic does, then sends a screenshot to the LLM to fill in expectations and checks.

**Smart mode** does everything AI does, then reorganizes groups into logical test flows (validation first, then main flow, then secondary actions).

Use `--dry-run` to preview the generated config without writing a file:

```bash
ui-patrol generate /login --smart --dry-run | jq .
```

---

## Output Structure

```
ui-patrol/
├── .gitignore
├── screenshots/
│   └── {phase}/{page-slug}/
│       ├── navigate.png
│       └── {group-slug}/
│           ├── 1.{action-slug}.png
│           └── 2.{action-slug}.png
└── logs/
    ├── ui-patrol-log.json
    ├── ui-patrol-pages.json
    └── ui-patrol-review.json
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

---

## Generating Pages JSON

The package only cares about valid JSON. Generate it however you want:

- **Hand-written** — just write `pages.json`
- **TypeScript** — use the exported types for autocomplete
- **PHP** — `json_encode()` an array
- **Python** — `json.dump()` a dict
- **Rust** — `serde_json::to_string()` a struct
- **Pipe from any language** — `your-command | ui-patrol run --pages -`

## License

MIT
