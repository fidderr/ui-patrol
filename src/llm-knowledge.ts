/**
 * Central knowledge base for all LLM prompts and instructions.
 *
 * SINGLE SOURCE OF TRUTH: Every field description, schema reference,
 * and LLM prompt is derived from the data structures below.
 *
 * When you add/change a field in config.ts:
 *   1. Update the corresponding entry in PAGE_FIELDS, ACTION_GROUP_FIELDS, or ACTION_FIELDS
 *   2. If it changes behavior, update BEHAVIORS
 *   3. Everything else (schema text, prompts) regenerates automatically
 */

// ── Field Definitions ───────────────────────────────────────────
// The actual source of truth. Every field that exists in the config
// is defined here with its type, whether it's required, and a
// description the LLM can understand.

interface FieldDef {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

const PAGE_FIELDS: FieldDef[] = [
  { name: 'path',            type: 'string',   required: true,  description: 'URL path, e.g. "/login"' },
  { name: 'name',            type: 'string',   required: true,  description: 'human-readable page name' },
  { name: 'phase',           type: 'string',   required: true,  description: 'screenshot folder name, e.g. "guest", "auth", "admin"' },
  { name: 'expectation',     type: 'string',   required: true,  description: 'what the page should look like on initial load (1-2 sentences)' },
  { name: 'checks',          type: 'string[]', required: true,  description: 'plain English statements that should be true when looking at the page' },
  { name: 'actionGroups',    type: 'ActionGroup[]', required: true, description: 'groups of UI interactions to perform' },
  { name: 'idleWait',        type: 'number',   required: false, description: 'extra ms to wait after DOM settles — final safety buffer for canvas/WebGL (default: 0, off)' },
  { name: 'domSettleTimeout', type: 'number', required: false, description: 'ms the DOM must be quiet (no mutations) before page is considered settled (default: 200)' },
  { name: 'domSettleMax',   type: 'number',   required: false, description: 'max ms to wait for DOM to settle — gives up if DOM keeps changing, e.g. animations (default: 5000)' },
  { name: 'waitForSelector', type: 'string',   required: false, description: 'CSS selector to wait for instead of the default wait strategy (overrides networkidle + DOM settle + idleWait)' },
  { name: 'retries',         type: 'number',   required: false, description: 'retries per element before marking missing (default: 2)' },
  { name: 'fullPage',        type: 'boolean',  required: false, description: 'false to capture viewport only instead of full scrollable page' },
  { name: 'expectedErrors',  type: 'string[]', required: false, description: 'regex patterns for console errors to ignore, e.g. ["404", "Failed to fetch"]' },
];

const ACTION_GROUP_FIELDS: FieldDef[] = [
  { name: 'description', type: 'string',   required: true, description: 'what this group tests, e.g. "Login flow", "Submit empty form"' },
  { name: 'actions',     type: 'Action[]', required: true, description: 'chained actions within this group' },
];

const ACTION_FIELDS: FieldDef[] = [
  { name: 'label',              type: 'string',   required: true,  description: 'human-readable label for this action' },
  { name: 'selector',           type: 'string',   required: true,  description: 'CSS selector to find the element' },
  { name: 'expectation',        type: 'string',   required: true,  description: 'what the screenshot should show after this action' },
  { name: 'checks',             type: 'string[]', required: true,  description: 'plain English checks the reviewer should evaluate' },
  { name: 'typeText',           type: 'string',   required: false, description: 'fill element with this text instead of clicking' },
  { name: 'nth',                type: 'number',   required: false, description: '0-based index when selector matches multiple elements (default: 0)' },
  { name: 'navigatesAway',      type: 'boolean',  required: false, description: 'if true, page reloads to original URL after screenshot' },
  { name: 'waitAfter',          type: 'number',   required: false, description: 'explicit wait in ms after action, skips the default wait strategy (use for animations, debounced inputs)' },
  { name: 'screenshotSelector', type: 'string',   required: false, description: 'CSS selector of element to screenshot instead of full page (use for dropdowns, popovers, modals)' },
  { name: 'saveSession',        type: 'boolean',  required: false, description: 'save browser session (cookies, localStorage) after this action completes (use on login submit actions)' },
  { name: 'clearSession',       type: 'boolean',  required: false, description: 'clear browser session after this action completes (use on logout actions to return to guest state)' },
];

const BEHAVIORS: string[] = [
  'Between actionGroups the page reloads to a clean state',
  'Within an actionGroup, actions chain without reload (e.g. fill email → fill password → click submit)',
  'saveSession/clearSession are ACTION-level — put saveSession on the login submit action, not the page',
  'navigatesAway on an action means: take screenshot, then navigate back to the page\'s path',
  'typeText means fill the input with text (not click). Omit typeText to click instead.',
  'nth selects which match to interact with when a selector matches multiple elements',
];

// ── Schema Reference (generated) ────────────────────────────────

function formatFields(fields: FieldDef[]): string {
  const required = fields.filter((f) => f.required);
  const optional = fields.filter((f) => !f.required);

  let text = '';
  if (required.length > 0) {
    text += 'Required fields:\n';
    text += required.map((f) => `- ${f.name}: ${f.type} — ${f.description}`).join('\n');
  }
  if (optional.length > 0) {
    if (text) text += '\n\n';
    text += 'Optional fields:\n';
    text += optional.map((f) => `- ${f.name}: ${f.type} — ${f.description}`).join('\n');
  }
  return text;
}

/**
 * Full JSON schema reference for LLM prompts.
 * Generated from the field definitions above — never edit this string directly.
 */
export const JSON_SCHEMA_REFERENCE = `## JSON Schema Reference

### PageConfig (top level)

${formatFields(PAGE_FIELDS)}

### ActionGroup

${formatFields(ACTION_GROUP_FIELDS)}

### Action

${formatFields(ACTION_FIELDS)}

### Key Behaviors

${BEHAVIORS.map((b) => `- ${b}`).join('\n')}
`;

/**
 * Just the optional page-level fields, for prompts that need to hint
 * "you may add these where appropriate" without repeating the full schema.
 */
function getOptionalPageFieldsHint(): string {
  return PAGE_FIELDS
    .filter((f) => !f.required)
    .map((f) => `  - ${f.name}: ${f.type} — ${f.description}`)
    .join('\n');
}

/**
 * Just the required action fields, for validation hints.
 */
function getRequiredActionFieldNames(): string {
  return ACTION_FIELDS
    .filter((f) => f.required)
    .map((f) => f.name)
    .join(', ');
}

// ── Reviewer Instructions ───────────────────────────────────────

export const REVIEWER_INSTRUCTIONS = `# UI Patrol — Visual Reviewer

You review screenshots from automated UI tests of web applications. Your job is to compare each screenshot against its expected description and verify specific checks.

## What You Receive

For each screenshot:
- **Page name and URL** — which page this is
- **Action** — what happened before the screenshot (navigate to page, click a button, fill a form, etc.)
- **Expected** — a description of what the screenshot should show
- **Checks** — specific things to verify (plain English statements that should be true)

## How to Evaluate

1. Look at the screenshot and read the expectation.
2. Does the screenshot reasonably match the description? It doesn't need to be pixel-perfect — focus on whether the described content and structure are present.
3. Go through each check. Each check is a statement that should be true when looking at the screenshot.
4. If the expectation is met and all checks pass, verdict is "pass". If anything important is wrong, verdict is "fail".

## What Counts as a Fail

- Page is blank, shows an error page, or shows a loading spinner instead of content
- Expected elements are missing (form fields, buttons, navigation, data)
- Layout is clearly broken (overlapping text, elements off-screen, collapsed containers)
- A check statement is clearly not true when looking at the screenshot
- Content is in the wrong language or shows raw template variables

## What Does NOT Count as a Fail

- Minor cosmetic differences (font rendering, slight color variations, anti-aliasing)
- Content differences that don't affect functionality (different user names, dates, row counts)
- Elements that are present but styled slightly differently than described
- Scrollbar presence or absence

## Response Format

Respond with ONLY valid JSON, no other text:

{
  "verdict": "pass",
  "reasoning": "Brief 1-2 sentence explanation.",
  "issues": []
}

- **verdict**: "pass" or "fail"
- **reasoning**: what you observed, why you made this call
- **issues**: array of specific problems found (empty array for pass)

## Examples

Pass example:
{
  "verdict": "pass",
  "reasoning": "Login form is visible with email and password fields, submit button present, no errors shown.",
  "issues": []
}

Fail example:
{
  "verdict": "fail",
  "reasoning": "Page shows a 500 error instead of the expected dashboard with data table.",
  "issues": ["500 Internal Server Error displayed", "No data table visible"]
}`;

// ── Generate: AI Fill Prompt ────────────────────────────────────
// Intentionally slim — the fill task only needs to understand
// expectation and checks fields, not the full schema.

export function buildAiFillPrompt(skeleton: { path: string; name: string }, skeletonJson: string, pageContext: string): string {
  return `You are filling in a UI test configuration for ui-patrol. The page is at "${skeleton.path}" called "${skeleton.name}".

The JSON below describes a page and its interactive actions. Each page and each action has two fields you need to fill:
- **expectation**: a 1-2 sentence description of what the screenshot should show
- **checks**: 2-4 plain English statements that should be true when looking at the screenshot

## Page Context
${pageContext}

## Current Skeleton
${skeletonJson}

## Your Task

Look at the attached screenshot. Fill in ONLY the empty "expectation" and "checks" fields:

1. Top-level "expectation" — describe what the page looks like
2. Top-level "checks" — 2-4 statements that should be true
3. For each action, fill in "expectation" and "checks" (1-2 checks each)

Rules:
- DO NOT change the structure, selectors, grouping, or action order
- DO NOT add or remove actions, groups, or any other fields
- Only fill empty strings and empty arrays
- Write expectations as descriptions of what SHOULD be visible
- Write checks as statements that SHOULD be true (a reviewer will verify them against screenshots)

Respond with ONLY the complete JSON object. No markdown fences, no explanation.`;
}

// ── Generate: AI Reorganize Prompt ──────────────────────────────

export function buildAiReorganizePrompt(filledJson: string, pageContext: string): string {
  return `You are improving a UI test configuration for ui-patrol. Here is a valid, working page config:

${JSON_SCHEMA_REFERENCE}

## Current JSON
${filledJson}

## Page Context
${pageContext}

## Your Task

Look at the attached screenshot. Improve the config by:

1. **Reorganize actionGroups** into logical test flows:
   - Validation tests FIRST (e.g., submit empty form to trigger errors)
   - Then the main/happy-path flow (e.g., fill form and submit with valid data)
   - Then secondary actions (e.g., navigate to other pages, switch tabs)
   - Remember: between action groups the page reloads to a clean state
2. **Remove** duplicate or redundant actions
3. **Improve** group descriptions to be specific and descriptive
4. **Improve** expectations and checks based on what you see in the screenshot
5. **Remove** actions that test header chrome (theme toggles, language switchers) unless they're the focus of the page

Rules:
- Keep the EXACT same selectors — do not change any selector value
- Every action must have: ${getRequiredActionFieldNames()}
- actionGroups use "description" (not "label")
- Do NOT invent new selectors that weren't in the original config
- You may add page-level optional fields where appropriate:
${getOptionalPageFieldsHint()}

Respond with ONLY the complete JSON PageConfig object. No markdown fences, no explanation.`;
}
