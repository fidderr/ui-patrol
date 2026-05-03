import type { Page } from '@playwright/test';
import type { PageConfig, Action, ActionGroup, ReviewConfig } from './config.js';
import { RUNNER_DEFAULTS, REVIEW_DEFAULTS } from './defaults.js';

// ── Types ───────────────────────────────────────────────────────

export interface DiscoverOptions {
  baseUrl?: string;
  browser?: 'chromium' | 'firefox' | 'webkit';
  headless?: boolean;
  phase?: string;
  name?: string;
  /** 'none' = heuristic only, 'ai' = LLM fills expectations/checks, 'smart' = LLM regroups + fills */
  mode?: 'none' | 'ai' | 'smart';
  review?: ReviewConfig;
  viewportWidth?: number;
  viewportHeight?: number;
}

interface DiscoveredElement {
  tag: string;
  type?: string;
  text: string;
  selector: string;
  role?: string;
  href?: string;
  placeholder?: string;
  ariaLabel?: string;
  isInForm?: boolean;
  formAction?: string;
}

// ── Main ────────────────────────────────────────────────────────

export async function generatePage(urlPath: string, options: DiscoverOptions = {}): Promise<PageConfig> {
  const baseUrl = options.baseUrl ?? RUNNER_DEFAULTS.baseUrl;
  let fullUrl: string;
  let pagePath: string;
  if (urlPath.startsWith('http://') || urlPath.startsWith('https://')) {
    fullUrl = urlPath;
    pagePath = new URL(fullUrl).pathname;
  } else {
    const cleanPath = urlPath.startsWith('/') ? urlPath : `/${urlPath}`;
    fullUrl = `${baseUrl}${cleanPath}`;
    pagePath = cleanPath;
  }

  const pw = await import('playwright');
  const browserType = pw[options.browser ?? 'chromium'];
  const browser = await browserType.launch({ headless: options.headless ?? true });

  try {
    const context = await browser.newContext({
      viewport: {
        width: options.viewportWidth ?? RUNNER_DEFAULTS.viewportWidth,
        height: options.viewportHeight ?? RUNNER_DEFAULTS.viewportHeight,
      },
    });
    const page = await context.newPage();

    console.log(`🔍 Navigating to ${fullUrl}...`);
    await page.goto(fullUrl, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    // Gather page context
    const pageContext = await gatherPageContext(page, fullUrl);
    console.log(`   Title: ${pageContext.title}`);
    if (pageContext.redirectedTo) console.log(`   Redirected to: ${pageContext.redirectedTo}`);
    if (pageContext.consoleErrors.length > 0) console.log(`   ⚠ ${pageContext.consoleErrors.length} console error(s)`);

    console.log(`🔍 Discovering interactive elements...`);
    const elements = await discoverElements(page);
    console.log(`   Found ${elements.length} interactive elements`);

    const pageName = options.name ?? derivePageName(pagePath);
    const phase = options.phase ?? derivePhase(pagePath);

    let config: PageConfig;
    const mode = options.mode ?? 'none';

    // All modes start with heuristic grouping
    const skeleton: PageConfig = {
      path: pagePath, name: pageName, phase,
      expectation: '', checks: [],
      actionGroups: buildSmartGroups(elements, pagePath),
    };

    if (mode === 'smart') {
      // Smart: heuristic → LLM fills expectations → LLM reorganizes
      console.log(`🧠 Taking screenshot for LLM analysis...`);
      const screenshot = await page.screenshot({ fullPage: true });
      console.log(`🧠 Asking LLM to fill expectations and checks...`);
      const filled = await aiFill(skeleton, screenshot, pageContext, options.review ?? {});
      console.log(`🧠 Asking LLM to reorganize and clean up...`);
      config = await aiReorganize(filled, screenshot, pageContext, options.review ?? {});
    } else if (mode === 'ai') {
      // AI: heuristic → LLM fills expectations/checks only
      console.log(`🧠 Taking screenshot for LLM analysis...`);
      const screenshot = await page.screenshot({ fullPage: true });
      console.log(`🧠 Asking LLM to fill expectations and checks...`);
      config = await aiFill(skeleton, screenshot, pageContext, options.review ?? {});
    } else {
      // None: heuristic only
      config = skeleton;
    }

    await context.close();
    return config;
  } finally {
    await browser.close();
  }
}

// ── Element Discovery ───────────────────────────────────────────

async function discoverElements(page: Page): Promise<DiscoveredElement[]> {
  return await page.evaluate(() => {
    const results: DiscoveredElement[] = [];
    const seen = new Set<string>();

    function sel(el: Element): string {
      const testId = el.getAttribute('data-testid');
      if (testId) return `[data-testid="${testId}"]`;
      if (el.id) return `#${el.id}`;
      const aria = el.getAttribute('aria-label');
      if (aria) return `[aria-label="${aria}"]`;
      const tag = el.tagName.toLowerCase();
      const name = el.getAttribute('name');
      if (name) return `${tag}[name="${name}"]`;
      const type = el.getAttribute('type');
      if (type && tag === 'input') return `input[type="${type}"]`;
      const txt = el.textContent?.trim().substring(0, 30);
      if (txt && txt.length > 0 && txt.length < 50) return `${tag}:has-text("${txt}")`;
      return tag;
    }

    function vis(el: Element): boolean {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    }

    function add(el: Element, tag: string, extra: Partial<DiscoveredElement> = {}) {
      if (!vis(el)) return;
      const s = sel(el);
      if (seen.has(s)) return;
      seen.add(s);

      // Check if element is inside a form
      const form = el.closest('form');
      const isInForm = !!form;
      const formAction = form?.getAttribute('action') ?? undefined;

      results.push({
        tag,
        text: el.textContent?.trim().substring(0, 60) ?? '',
        selector: s,
        ariaLabel: el.getAttribute('aria-label') ?? undefined,
        isInForm,
        formAction,
        ...extra,
      });
    }

    document.querySelectorAll('button, [role="button"]').forEach((el) =>
      add(el, 'button', { role: el.getAttribute('role') ?? undefined }),
    );

    document.querySelectorAll('a[href]').forEach((el) => {
      const href = el.getAttribute('href') ?? '';
      if (href.startsWith('http') && !href.includes(window.location.host)) return;
      if (href.startsWith('#') || href.startsWith('javascript:')) return;
      add(el, 'a', { href });
    });

    document.querySelectorAll('input, textarea, select').forEach((el) => {
      const input = el as HTMLInputElement;
      if (input.type === 'hidden') return;
      add(el, el.tagName.toLowerCase(), {
        type: input.type,
        text: input.placeholder || el.getAttribute('aria-label') || input.name || '',
        placeholder: input.placeholder ?? undefined,
      });
    });

    document.querySelectorAll('[role="tab"]').forEach((el) =>
      add(el, 'tab', { role: 'tab' }),
    );

    return results;
  });
}

// ── Page Context ────────────────────────────────────────────────

interface PageContext {
  title: string;
  url: string;
  redirectedTo: string | null;
  metaDescription: string;
  headings: string[];
  visibleText: string;
  consoleErrors: string[];
  formCount: number;
  hasNavigation: boolean;
  hasTable: boolean;
  hasModal: boolean;
}

async function gatherPageContext(page: Page, originalUrl: string): Promise<PageContext> {
  const currentUrl = page.url();
  const consoleErrors: string[] = [];

  // Capture console errors
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  return await page.evaluate((origUrl) => {
    const title = document.title;
    const meta = document.querySelector('meta[name="description"]');
    const metaDescription = meta?.getAttribute('content') ?? '';

    const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
      .map((h) => h.textContent?.trim() ?? '')
      .filter((t) => t.length > 0)
      .slice(0, 10);

    // Get visible text (truncated)
    const body = document.body.innerText ?? '';
    const visibleText = body.substring(0, 2000);

    const formCount = document.querySelectorAll('form').length;
    const hasNavigation = !!document.querySelector('nav, [role="navigation"]');
    const hasTable = !!document.querySelector('table, [role="grid"]');
    const hasModal = !!document.querySelector('[role="dialog"]');

    return {
      title,
      url: window.location.href,
      redirectedTo: window.location.href !== origUrl ? window.location.href : null,
      metaDescription,
      headings,
      visibleText,
      consoleErrors: [] as string[],
      formCount,
      hasNavigation,
      hasTable,
      hasModal,
    };
  }, originalUrl).then((ctx) => {
    ctx.consoleErrors = consoleErrors;
    return ctx;
  });
}

function formatContext(ctx: PageContext): string {
  let text = `Page title: "${ctx.title}"
URL: ${ctx.url}`;
  if (ctx.redirectedTo) text += `\nRedirected from original URL`;
  if (ctx.metaDescription) text += `\nMeta description: "${ctx.metaDescription}"`;
  if (ctx.headings.length > 0) text += `\nHeadings: ${ctx.headings.join(', ')}`;
  text += `\nForms: ${ctx.formCount}, Navigation: ${ctx.hasNavigation}, Table: ${ctx.hasTable}, Modal: ${ctx.hasModal}`;
  if (ctx.consoleErrors.length > 0) text += `\nConsole errors: ${ctx.consoleErrors.join('; ')}`;
  text += `\n\nVisible text (first 2000 chars):\n${ctx.visibleText}`;
  return text;
}

// ── Smart Grouping (heuristic, no LLM) ─────────────────────────

function buildSmartGroups(elements: DiscoveredElement[], pagePath: string): ActionGroup[] {
  const groups: ActionGroup[] = [];

  // Separate form elements from non-form elements
  const formInputs = elements.filter((e) => e.isInForm && ['input', 'textarea', 'select'].includes(e.tag));
  const formButtons = elements.filter((e) => e.isInForm && e.tag === 'button');
  const pageButtons = elements.filter((e) => !e.isInForm && e.tag === 'button');
  const links = elements.filter((e) => e.tag === 'a');
  const tabs = elements.filter((e) => e.role === 'tab');

  // Detect login form
  const hasEmail = formInputs.some((e) => e.type === 'email' || e.selector.includes('email'));
  const hasPassword = formInputs.some((e) => e.type === 'password' || e.selector.includes('password'));
  const isLoginPage = hasEmail && hasPassword && (pagePath.includes('login') || pagePath.includes('signin'));

  if (isLoginPage) {
    // Build a login flow
    const loginActions: Action[] = [];
    const emailInput = formInputs.find((e) => e.type === 'email' || e.selector.includes('email'));
    const passwordInput = formInputs.find((e) => e.type === 'password' || e.selector.includes('password'));
    const submitBtn = formButtons.find((e) => e.text.toLowerCase().includes('log') || e.text.toLowerCase().includes('sign') || e.selector.includes('submit'));

    if (emailInput) {
      loginActions.push({
        label: 'Fill email',
        selector: emailInput.selector,
        typeText: 'user@example.com',
        expectation: '',
        checks: [],
      });
    }
    if (passwordInput) {
      loginActions.push({
        label: 'Fill password',
        selector: passwordInput.selector,
        typeText: 'password',
        expectation: '',
        checks: [],
      });
    }
    if (submitBtn) {
      loginActions.push({
        label: 'Submit login',
        selector: submitBtn.selector,
        waitAfter: 3000,
        expectation: '',
        checks: [],
      });
    }

    if (loginActions.length > 0) {
      groups.push({ description: 'Login flow', actions: loginActions });
    }
  } else if (formInputs.length > 0) {
    // Generic form: group inputs + submit together
    const actions: Action[] = formInputs.map((el): Action => ({
      label: el.placeholder || el.ariaLabel || el.text || `${el.tag} ${el.type ?? ''}`.trim(),
      selector: el.selector,
      typeText: '',
      expectation: '',
      checks: [],
    }));

    const submitBtn = formButtons.find((e) =>
      e.selector.includes('submit') || e.text.toLowerCase().includes('submit') || e.text.toLowerCase().includes('save'),
    );
    if (submitBtn) {
      actions.push({
        label: submitBtn.text || 'Submit',
        selector: submitBtn.selector,
        expectation: '',
        checks: [],
      });
    }

    groups.push({ description: 'Fill and submit form', actions });
  }

  // Page-specific buttons (not in forms, not header chrome)
  const interestingButtons = pageButtons.filter((e) => !isHeaderChrome(e));
  if (interestingButtons.length > 0) {
    groups.push({
      description: 'Page actions',
      actions: interestingButtons.map((el): Action => ({
        label: el.text || el.ariaLabel || 'Button',
        selector: el.selector,
        expectation: '',
        checks: [],
      })),
    });
  }

  // Content links (not header nav)
  const contentLinks = links.filter((e) => !isHeaderChrome(e));
  if (contentLinks.length > 0) {
    groups.push({
      description: 'Navigate links',
      actions: contentLinks.map((el): Action => ({
        label: el.text || el.href || 'Link',
        selector: el.selector,
        navigatesAway: true,
        expectation: '',
        checks: [],
      })),
    });
  }

  // Tabs
  if (tabs.length > 0) {
    groups.push({
      description: 'Switch tabs',
      actions: tabs.map((el): Action => ({
        label: el.text || 'Tab',
        selector: el.selector,
        expectation: '',
        checks: [],
      })),
    });
  }

  return groups;
}

/** Filter out header/nav chrome (theme, locale, hamburger menu) */
function isHeaderChrome(el: DiscoveredElement): boolean {
  const s = el.selector.toLowerCase();
  const t = el.text.toLowerCase();
  const a = (el.ariaLabel ?? '').toLowerCase();
  return (
    a.includes('theme') || a.includes('thema') || a.includes('taal') || a.includes('locale') ||
    a.includes('menu') || a.includes('language') ||
    s.includes('theme') || s.includes('locale') || s.includes('lang') ||
    t === 'nl' || t === 'en' || t === 'es'
  );
}

// ── Shared schema reference for LLM prompts ────────────────────

const JSON_SCHEMA_REFERENCE = `
JSON SCHEMA REFERENCE:

PageConfig (top level):
  path: string (required) — URL path, e.g. "/login"
  name: string (required) — human-readable page name
  phase: string (required) — screenshot folder name, e.g. "guest", "auth", "admin"
  expectation: string (required) — what the page should look like
  checks: string[] (required) — plain English statements that should be true
  actionGroups: ActionGroup[] (required) — groups of UI interactions
  saveSession: boolean (optional) — save browser cookies/session after this page. Use on login pages.
  clearSession: boolean (optional) — wipe session before this page. Use for logout/guest tests.
  idleWait: number (optional) — extra ms to wait after network idle for slow pages
  fullPage: boolean (optional) — false to capture viewport only instead of full scrollable page
  expectedErrors: string[] (optional) — regex patterns for console errors to ignore, e.g. ["404"]

ActionGroup:
  description: string (required) — what this group tests, e.g. "Login flow", "Submit empty form"
  actions: Action[] (required) — chained actions. Between groups the page reloads. Within a group, actions chain sequentially.

Action:
  label: string (required) — human-readable label for this action
  selector: string (required) — CSS selector to find the element
  expectation: string (required) — what the screenshot should show after this action
  checks: string[] (required) — plain English checks for the LLM reviewer
  typeText: string (optional) — fill element with this text instead of clicking
  navigatesAway: boolean (optional) — if true, page reloads to original URL after screenshot
  waitAfter: number (optional) — explicit wait in ms, skips network idle wait. Use for animations, debounced inputs.
  screenshotSelector: string (optional) — CSS selector of element to screenshot instead of full page. Use for dropdowns, popovers.

IMPORTANT BEHAVIORS:
- Between actionGroups the page reloads to a clean state
- Within an actionGroup, actions chain without reload (e.g. fill email → fill password → click submit)
- saveSession/clearSession are PAGE-level, not action-level
- navigatesAway on an action means: take screenshot, then navigate back to the page's path
- typeText means fill the input with text (not click). Omit typeText to click instead.
`;

// ── AI Fill (LLM fills expectations/checks, keeps structure) ────

async function aiFill(skeleton: PageConfig, screenshot: Buffer, ctx: PageContext, review: ReviewConfig): Promise<PageConfig> {
  const apiUrl = review.apiUrl ?? process.env.LLM_API_URL ?? REVIEW_DEFAULTS.apiUrl;
  const apiKey = review.apiKey ?? '';
  const model = review.model ?? REVIEW_DEFAULTS.model;

  const prompt = `You are filling in a UI test configuration. The page is at "${skeleton.path}" called "${skeleton.name}".
${JSON_SCHEMA_REFERENCE}
Page context:
${formatContext(ctx)}

Here is the skeleton JSON with the structure already defined:

${JSON.stringify(skeleton, null, 2)}

Look at the attached screenshot. Fill in ONLY the empty fields:
1. Top-level "expectation" — describe what the page looks like (1-2 sentences)
2. Top-level "checks" — 2-4 plain English statements that should be true
3. For each action, fill in "expectation" and "checks" (1-2 checks each)

DO NOT change the structure, selectors, grouping, or action order. Only fill empty strings.

Respond with ONLY the complete JSON PageConfig object. No markdown fences, no explanation.`;

  const payload = {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${screenshot.toString('base64')}` } },
      ],
    }],
    max_tokens: 4096,
    temperature: 0.2,
  };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(300_000),
    });

    if (!response.ok) {
      console.warn(`⚠ LLM returned HTTP ${response.status}, using skeleton`);
      return skeleton;
    }

    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (!content) { console.warn('⚠ Empty LLM response'); return skeleton; }

    let cleaned = content.trim();
    const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) cleaned = fence[1].trim();

    const filled = JSON.parse(cleaned) as PageConfig;
    // Preserve original structure — only take expectations/checks from LLM
    filled.path = skeleton.path;
    filled.name = skeleton.name;
    filled.phase = skeleton.phase;
    for (let gi = 0; gi < skeleton.actionGroups.length && gi < filled.actionGroups.length; gi++) {
      const orig = skeleton.actionGroups[gi];
      const fill = filled.actionGroups[gi];
      fill.description = orig.description;
      for (let ai = 0; ai < orig.actions.length && ai < fill.actions.length; ai++) {
        fill.actions[ai].selector = orig.actions[ai].selector;
        fill.actions[ai].label = orig.actions[ai].label;
        if (orig.actions[ai].typeText !== undefined) fill.actions[ai].typeText = orig.actions[ai].typeText;
        if (orig.actions[ai].navigatesAway) fill.actions[ai].navigatesAway = true;
        if (orig.actions[ai].waitAfter) fill.actions[ai].waitAfter = orig.actions[ai].waitAfter;
      }
    }
    return filled;
  } catch (err) {
    console.warn(`⚠ LLM error: ${String(err)}`);
    return skeleton;
  }
}

// ── AI Reorganize (LLM improves structure of valid JSON) ────────

async function aiReorganize(filled: PageConfig, screenshot: Buffer, ctx: PageContext, review: ReviewConfig): Promise<PageConfig> {
  const apiUrl = review.apiUrl ?? process.env.LLM_API_URL ?? REVIEW_DEFAULTS.apiUrl;
  const apiKey = review.apiKey ?? '';
  const model = review.model ?? REVIEW_DEFAULTS.model;

  const prompt = `You are improving a UI test configuration. Here is a valid, working page config:

${JSON.stringify(filled, null, 2)}
${JSON_SCHEMA_REFERENCE}
Page context:
${formatContext(ctx)}

Look at the attached screenshot. Improve the config by:
1. Reorganize actionGroups into logical test flows with a sensible execution order:
   - Validation tests FIRST (e.g., submit empty form to trigger errors)
   - Then the main flow (e.g., fill form and submit with valid data)
   - Then secondary actions (e.g., navigate to other pages)
   - Remember: between action groups the page reloads, so order matters
2. Remove duplicate or redundant actions
3. Improve group descriptions to be more descriptive
4. Improve expectations and checks if they can be more specific based on the screenshot
5. Remove actions that test header chrome (theme toggles, language switchers) unless they're the focus of the page

CRITICAL RULES:
- Keep the EXACT same selectors — do not change any selector values
- Keep the same JSON schema: path, name, phase, expectation, checks, actionGroups with description and actions
- Each action must have: label, selector, expectation, checks
- Optional action fields: typeText (string), navigatesAway (boolean), waitAfter (number ms), screenshotSelector (string)
- Do NOT add fields that don't exist in the schema
- actionGroups use "description" not "label"

PAGE-LEVEL optional fields you can add:
- saveSession: true — saves browser cookies/session after this page (use on login pages)
- clearSession: true — wipes session before this page (use for logout/guest tests)
- idleWait: number — extra ms to wait after network idle (for slow pages)
- fullPage: false — capture viewport only instead of full scrollable page
- expectedErrors: ["regex"] — console errors to ignore (e.g., ["404"] for error pages)

If this is a login page with a successful login flow, add "saveSession": true at the page level.

Respond with ONLY the complete JSON PageConfig object. No markdown fences, no explanation.`;

  const payload = {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${screenshot.toString('base64')}` } },
      ],
    }],
    max_tokens: 4096,
    temperature: 0.2,
  };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(300_000),
    });

    if (!response.ok) {
      console.warn(`⚠ LLM returned HTTP ${response.status}, keeping current structure`);
      return filled;
    }

    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (!content) { console.warn('⚠ Empty LLM response, keeping current structure'); return filled; }

    let cleaned = content.trim();
    const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) cleaned = fence[1].trim();

    const reorganized = JSON.parse(cleaned) as PageConfig;

    // Force correct metadata
    reorganized.path = filled.path;
    reorganized.name = filled.name;
    reorganized.phase = filled.phase;

    // Validate the output — every action must have the required fields
    for (const group of reorganized.actionGroups) {
      if (!group.description) group.description = 'Unnamed group';
      for (const action of group.actions) {
        if (!action.label) action.label = 'Unnamed action';
        if (!action.selector) {
          console.warn(`⚠ LLM removed a selector, keeping original structure`);
          return filled;
        }
        if (!action.expectation) action.expectation = '';
        if (!action.checks) action.checks = [];
      }
    }

    return reorganized;
  } catch (err) {
    console.warn(`⚠ LLM error: ${String(err)}, keeping current structure`);
    return filled;
  }
}

// ── Helpers ─────────────────────────────────────────────────────

function derivePageName(p: string): string {
  if (p === '/' || p === '') return 'Homepage';
  return p.split('/').filter(Boolean).map((s) => s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, ' ')).join(' — ');
}

function derivePhase(p: string): string {
  if (p === '/' || p === '') return 'guest';
  return p.split('/').filter(Boolean)[0] ?? 'guest';
}
