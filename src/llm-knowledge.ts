/**
 * Central knowledge base for all LLM prompts and instructions.
 *
 * SINGLE SOURCE OF TRUTH: Every field description, schema reference,
 * and LLM prompt is derived from the data structures below.
 *
 * When you add/change a field in config.ts:
 *   1. If it's a shared SharedOptions field, update SHARED_FIELDS
 *   2. If it's page-only or action-only, update the respective array
 *   3. If it changes behavior, update BEHAVIORS
 *   4. Everything else (schema text, prompts) regenerates automatically
 */

// ── Field Definitions ───────────────────────────────────────────

interface FieldDef {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

/**
 * Shared behavioral fields that exist on Action, PageConfig, and RunnerConfig.
 * Mirrors the SharedOptions interface in config.ts.
 */
const SHARED_FIELDS: FieldDef[] = [
  { name: 'networkIdleWait', type: 'number',   required: false, description: 'max ms to wait for network to go quiet (default: 100)' },
  { name: 'domIdleWait',     type: 'number',   required: false, description: 'ms the DOM must be quiet (no mutations) before considered settled (default: 100)' },
  { name: 'domIdleMax',      type: 'number',   required: false, description: 'max ms to wait for DOM to settle — gives up if DOM keeps changing (default: 5000)' },
  { name: 'waitForSelector', type: 'string',   required: false, description: 'CSS selector to wait for instead of the default wait strategy' },
  { name: 'fullPage',        type: 'boolean',  required: false, description: 'false to capture viewport only instead of full scrollable page' },
  { name: 'retries',         type: 'number',   required: false, description: 'retries per element before marking missing (default: 2)' },
  { name: 'screenshot',         type: 'boolean',  required: false, description: 'false to skip screenshots (actions still run)' },
  { name: 'screenshotSelector', type: 'string',  required: false, description: 'CSS selector of element to screenshot instead of full page (use for dropdowns, popovers, modals)' },
];

/**
 * Testable fields shared between Action and PageConfig (not RunnerConfig).
 * Mirrors the TestableOptions interface in config.ts.
 */
const TESTABLE_FIELDS: FieldDef[] = [
  { name: 'name',           type: 'string',   required: true,  description: 'human-readable name' },
  { name: 'expectation',    type: 'string',   required: true,  description: 'what the screenshot should show (for LLM review)' },
  { name: 'checks',         type: 'string[]', required: true,  description: 'plain English checks the LLM reviewer should evaluate' },
  { name: 'expectedErrors', type: 'string[]', required: false, description: 'regex patterns for expected console errors (filtered independently per level, no cascade)' },
];

const PAGE_FIELDS: FieldDef[] = [
  { name: 'path',            type: 'string',        required: true,  description: 'URL path, e.g. "/login"' },
  { name: 'phase',           type: 'string',        required: true,  description: 'screenshot folder name, e.g. "guest", "auth", "admin"' },
  { name: 'actionGroups',    type: 'ActionGroup[]', required: true,  description: 'groups of UI interactions to perform' },
  ...TESTABLE_FIELDS,
  ...SHARED_FIELDS,
];

const ACTION_GROUP_FIELDS: FieldDef[] = [
  { name: 'description', type: 'string',   required: true, description: 'what this group tests, e.g. "Login flow", "Submit empty form"' },
  { name: 'actions',     type: 'Action[]', required: true, description: 'chained actions within this group' },
];

const ACTION_FIELDS: FieldDef[] = [
  { name: 'selector',           type: 'string',   required: true,  description: 'CSS selector to find the element' },
  ...TESTABLE_FIELDS,
  { name: 'typeText',           type: 'string',   required: false, description: 'fill element with this text instead of clicking' },
  { name: 'nth',                type: 'number',   required: false, description: '0-based index when selector matches multiple elements (default: 0)' },
  { name: 'navigatesAway',      type: 'boolean',  required: false, description: 'if true, page reloads to original URL after screenshot' },
  { name: 'saveSession',        type: 'boolean',  required: false, description: 'save browser session (cookies, localStorage) after this action completes (use on login submit actions)' },
  { name: 'clearSession',       type: 'boolean',  required: false, description: 'clear browser session after this action completes (use on logout actions to return to guest state)' },
  ...SHARED_FIELDS,
];

const BEHAVIORS: string[] = [
  'Optional fields cascade: action → config → defaults (for actions), page → config → defaults (for page navigation)',
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
- actionGroups use "description" (not "name")
- Do NOT invent new selectors that weren't in the original config
- You may add page-level optional fields where appropriate:
${getOptionalPageFieldsHint()}

Respond with ONLY the complete JSON PageConfig object. No markdown fences, no explanation.`;
}
