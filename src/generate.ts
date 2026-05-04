import type { Page } from '@playwright/test';
import type { PageConfig, Action, ActionGroup, ReviewConfig } from './config.js';
import { RUNNER_DEFAULTS, REVIEW_DEFAULTS, GENERATE_DEFAULTS } from './defaults.js';
import { buildAiFillPrompt, buildAiReorganizePrompt } from './llm-knowledge.js';

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
    const { elements, duplicatesSkipped } = await discoverElements(page);
    console.log(`   Found ${elements.length} interactive elements`);
    if (duplicatesSkipped > 0) {
      console.log(`   ⚠ ${duplicatesSkipped} element(s) skipped (non-unique selectors — add data-testid for better coverage)`);
    }

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
      console.log(`🧠 Taking screenshot for LLM analysis...`);
      const screenshot = await page.screenshot({ fullPage: true });
      console.log(`🧠 Asking LLM to fill expectations and checks...`);
      const filled = await aiFill(skeleton, screenshot, pageContext, options.review ?? {});
      console.log(`🧠 Asking LLM to reorganize and clean up...`);
      config = await aiReorganize(filled, screenshot, pageContext, options.review ?? {});
    } else if (mode === 'ai') {
      console.log(`🧠 Taking screenshot for LLM analysis...`);
      const screenshot = await page.screenshot({ fullPage: true });
      console.log(`🧠 Asking LLM to fill expectations and checks...`);
      config = await aiFill(skeleton, screenshot, pageContext, options.review ?? {});
    } else {
      config = skeleton;
    }

    await context.close();
    return config;
  } finally {
    await browser.close();
  }
}

// ── Element Discovery ───────────────────────────────────────────

async function discoverElements(page: Page): Promise<{ elements: DiscoveredElement[]; duplicatesSkipped: number }> {
  return await page.evaluate(() => {
    const results: DiscoveredElement[] = [];
    const seen = new Set<string>();
    let duplicatesSkipped = 0;

    function sel(el: Element): string {
      // Prefer stable, unique attributes in order of reliability
      const testId = el.getAttribute('data-testid');
      if (testId) return `[data-testid="${testId}"]`;
      if (el.id) return `#${el.id}`;
      const aria = el.getAttribute('aria-label');
      if (aria) return `[aria-label="${aria}"]`;
      const tag = el.tagName.toLowerCase();
      const name = el.getAttribute('name');
      if (name) return `${tag}[name="${name}"]`;
      const role = el.getAttribute('role');
      const type = el.getAttribute('type');
      if (type && tag === 'input') return `input[type="${type}"]`;
      // For buttons/links, prefer role + text combo for uniqueness
      const txt = el.textContent?.trim().substring(0, 30);
      if (txt && txt.length > 0 && txt.length < 50) {
        if (role) return `[role="${role}"]:has-text("${txt}")`;
        return `${tag}:has-text("${txt}")`;
      }
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
      if (seen.has(s)) {
        // Non-unique selector — skip silently to avoid duplicate actions.
        // The first match wins. Use data-testid or id for uniqueness.
        duplicatesSkipped++;
        return;
      }
      seen.add(s);

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

    return { elements: results, duplicatesSkipped };
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
  const consoleErrors: string[] = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  return await page.evaluate(({ origUrl, textLimit }) => {
    const title = document.title;
    const meta = document.querySelector('meta[name="description"]');
    const metaDescription = meta?.getAttribute('content') ?? '';

    const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
      .map((h) => h.textContent?.trim() ?? '')
      .filter((t) => t.length > 0)
      .slice(0, 10);

    const body = document.body.innerText ?? '';
    const visibleText = body.substring(0, textLimit);

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
  }, { origUrl: originalUrl, textLimit: GENERATE_DEFAULTS.visibleTextLimit }).then((ctx) => {
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
  text += `\n\nVisible text (truncated):\n${ctx.visibleText}`;
  return text;
}

// ── Smart Grouping (heuristic, no LLM) ─────────────────────────

/** Patterns that indicate a login/sign-in page */
const LOGIN_PATH_PATTERNS = [
  'login', 'signin', 'sign-in', 'sign_in', 'log-in', 'log_in', 'auth',
];

/** Patterns that indicate a registration page */
const REGISTER_PATH_PATTERNS = [
  'register', 'signup', 'sign-up', 'sign_up', 'create-account', 'join',
];

function matchesPathPattern(pagePath: string, patterns: string[]): boolean {
  const lower = pagePath.toLowerCase();
  return patterns.some((p) => lower.includes(p));
}

function buildSmartGroups(elements: DiscoveredElement[], pagePath: string): ActionGroup[] {
  const groups: ActionGroup[] = [];

  const formInputs = elements.filter((e) => e.isInForm && ['input', 'textarea', 'select'].includes(e.tag));
  const formButtons = elements.filter((e) => e.isInForm && e.tag === 'button');
  const pageButtons = elements.filter((e) => !e.isInForm && e.tag === 'button');
  const links = elements.filter((e) => e.tag === 'a');
  const tabs = elements.filter((e) => e.role === 'tab');

  const hasEmail = formInputs.some((e) => e.type === 'email' || e.selector.includes('email'));
  const hasPassword = formInputs.some((e) => e.type === 'password' || e.selector.includes('password'));
  const isLoginPage = hasEmail && hasPassword && matchesPathPattern(pagePath, LOGIN_PATH_PATTERNS);
  const isRegisterPage = hasEmail && hasPassword && matchesPathPattern(pagePath, REGISTER_PATH_PATTERNS);

  // Search form detection
  const searchInput = formInputs.find((e) =>
    e.type === 'search' || e.selector.includes('search') || e.selector.includes('query') ||
    (e.placeholder ?? '').toLowerCase().includes('search'),
  );

  if (isLoginPage) {
    const loginActions: Action[] = [];
    const emailInput = formInputs.find((e) => e.type === 'email' || e.selector.includes('email'));
    const passwordInput = formInputs.find((e) => e.type === 'password' || e.selector.includes('password'));
    const submitBtn = findSubmitButton(formButtons, ['log', 'sign']);

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
        saveSession: true,
        expectation: '',
        checks: [],
      });
    }

    if (loginActions.length > 0) {
      groups.push({ description: 'Login flow', actions: loginActions });
    }
  } else if (isRegisterPage) {
    // Registration form: fill all inputs with placeholder data
    const regActions: Action[] = formInputs.map((el): Action => ({
      label: el.placeholder || el.ariaLabel || el.text || `Fill ${el.type ?? el.tag}`,
      selector: el.selector,
      typeText: guessInputValue(el),
      expectation: '',
      checks: [],
    }));

    const submitBtn = findSubmitButton(formButtons, ['register', 'sign', 'create', 'join']);
    if (submitBtn) {
      regActions.push({
        label: submitBtn.text || 'Submit registration',
        selector: submitBtn.selector,
        waitAfter: 3000,
        expectation: '',
        checks: [],
      });
    }

    if (regActions.length > 0) {
      groups.push({ description: 'Registration flow', actions: regActions });
    }
  } else if (searchInput) {
    // Search form
    const searchActions: Action[] = [{
      label: 'Type search query',
      selector: searchInput.selector,
      typeText: 'test',
      expectation: '',
      checks: [],
    }];

    const searchBtn = findSubmitButton(formButtons, ['search', 'find', 'go']);
    if (searchBtn) {
      searchActions.push({
        label: searchBtn.text || 'Submit search',
        selector: searchBtn.selector,
        expectation: '',
        checks: [],
      });
    }

    groups.push({ description: 'Search', actions: searchActions });

    // Handle remaining non-search form inputs
    const otherInputs = formInputs.filter((e) => e !== searchInput);
    if (otherInputs.length > 0) {
      buildGenericFormGroup(otherInputs, formButtons, groups);
    }
  } else if (formInputs.length > 0) {
    buildGenericFormGroup(formInputs, formButtons, groups);
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

/** Build a generic form group for non-login/register forms */
function buildGenericFormGroup(
  formInputs: DiscoveredElement[],
  formButtons: DiscoveredElement[],
  groups: ActionGroup[],
): void {
  const actions: Action[] = formInputs.map((el): Action => ({
    label: el.placeholder || el.ariaLabel || el.text || `Fill ${el.type ?? el.tag}`,
    selector: el.selector,
    typeText: guessInputValue(el),
    expectation: '',
    checks: [],
  }));

  const submitBtn = findSubmitButton(formButtons, ['submit', 'save', 'send', 'create', 'add', 'update']);
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

/** Find a submit-like button by matching text or selector against keywords */
function findSubmitButton(buttons: DiscoveredElement[], keywords: string[]): DiscoveredElement | undefined {
  // First try: button text matches a keyword
  const byText = buttons.find((e) => {
    const t = e.text.toLowerCase();
    return keywords.some((k) => t.includes(k));
  });
  if (byText) return byText;

  // Second try: selector includes 'submit'
  const bySelector = buttons.find((e) => e.selector.includes('submit'));
  if (bySelector) return bySelector;

  // Third try: button with type="submit" (might be in selector)
  const byType = buttons.find((e) => e.selector.includes('type="submit"'));
  if (byType) return byType;

  // Last resort: first button
  return buttons[0];
}

/** Guess a reasonable test value for a form input based on its type/name */
function guessInputValue(el: DiscoveredElement): string {
  const type = el.type?.toLowerCase() ?? '';
  const selector = el.selector.toLowerCase();
  const placeholder = (el.placeholder ?? '').toLowerCase();
  const label = (el.ariaLabel ?? '').toLowerCase();
  const hint = `${selector} ${placeholder} ${label}`;

  if (type === 'email' || hint.includes('email')) return 'test@example.com';
  if (type === 'password' || hint.includes('password')) return 'TestPassword123';
  if (type === 'tel' || hint.includes('phone') || hint.includes('tel')) return '+1234567890';
  if (type === 'url' || hint.includes('url') || hint.includes('website')) return 'https://example.com';
  if (type === 'number' || hint.includes('amount') || hint.includes('quantity')) return '42';
  if (hint.includes('name') && hint.includes('first')) return 'Jane';
  if (hint.includes('name') && hint.includes('last')) return 'Doe';
  if (hint.includes('name') && !hint.includes('user')) return 'Jane Doe';
  if (hint.includes('username') || hint.includes('user')) return 'testuser';
  if (hint.includes('zip') || hint.includes('postal')) return '12345';
  if (hint.includes('city')) return 'Test City';
  if (hint.includes('address')) return '123 Test Street';
  if (hint.includes('company') || hint.includes('organization')) return 'Test Corp';
  if (hint.includes('search') || hint.includes('query')) return 'test';
  if (type === 'date') return '2025-01-15';

  // Default: something generic but not empty
  return 'test';
}

/**
 * Filter out header/nav chrome elements that aren't worth testing.
 * These are typically theme toggles, language switchers, and hamburger menus.
 */
function isHeaderChrome(el: DiscoveredElement): boolean {
  const s = el.selector.toLowerCase();
  const t = el.text.toLowerCase();
  const a = (el.ariaLabel ?? '').toLowerCase();
  const all = `${s} ${t} ${a}`;

  return (
    // Theme/dark mode toggles
    all.includes('theme') || all.includes('dark-mode') || all.includes('darkmode') || all.includes('color-scheme') ||
    // Language/locale switchers
    all.includes('locale') || all.includes('language') || all.includes('lang-switch') ||
    // Hamburger/mobile menu toggles
    (a.includes('menu') && (a.includes('toggle') || a.includes('open') || a.includes('close'))) ||
    // Common 2-letter language codes as standalone text
    /^(en|es|fr|de|nl|pt|it|ja|ko|zh|ru|ar|hi|sv|da|no|fi|pl|cs|tr)$/.test(t)
  );
}

// ── AI Fill ─────────────────────────────────────────────────────

async function aiFill(skeleton: PageConfig, screenshot: Buffer, ctx: PageContext, review: ReviewConfig): Promise<PageConfig> {
  const apiUrl = review.apiUrl ?? process.env.LLM_API_URL ?? REVIEW_DEFAULTS.apiUrl;
  const apiKey = review.apiKey ?? '';
  const model = review.model ?? REVIEW_DEFAULTS.model;

  const prompt = buildAiFillPrompt(
    skeleton,
    JSON.stringify(skeleton, null, 2),
    formatContext(ctx),
  );

  const payload = {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${screenshot.toString('base64')}` } },
      ],
    }],
    max_tokens: GENERATE_DEFAULTS.maxTokens,
    temperature: GENERATE_DEFAULTS.temperature,
  };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REVIEW_DEFAULTS.timeout),
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
        if (orig.actions[ai].saveSession) fill.actions[ai].saveSession = true;
        if (orig.actions[ai].clearSession) fill.actions[ai].clearSession = true;
      }
    }
    return filled;
  } catch (err) {
    console.warn(`⚠ LLM error: ${String(err)}`);
    return skeleton;
  }
}

// ── AI Reorganize ───────────────────────────────────────────────

async function aiReorganize(filled: PageConfig, screenshot: Buffer, ctx: PageContext, review: ReviewConfig): Promise<PageConfig> {
  const apiUrl = review.apiUrl ?? process.env.LLM_API_URL ?? REVIEW_DEFAULTS.apiUrl;
  const apiKey = review.apiKey ?? '';
  const model = review.model ?? REVIEW_DEFAULTS.model;

  const prompt = buildAiReorganizePrompt(
    JSON.stringify(filled, null, 2),
    formatContext(ctx),
  );

  const payload = {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${screenshot.toString('base64')}` } },
      ],
    }],
    max_tokens: GENERATE_DEFAULTS.maxTokens,
    temperature: GENERATE_DEFAULTS.temperature,
  };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REVIEW_DEFAULTS.timeout),
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
