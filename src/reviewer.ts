import * as fs from 'fs';
import * as path from 'path';
import { slugify, type PageConfig } from './config.js';
import { REVIEW_DEFAULTS } from './defaults.js';

// ── Types ───────────────────────────────────────────────────────

export interface ReviewItem {
  page: string;
  url: string;
  action: string;
  elementLabel: string | null;
  screenshot: string;
  expectation: string;
  checks: string[];
}

export interface ReviewResult {
  page: string;
  url: string;
  action: string;
  elementLabel: string | null;
  screenshot: string;
  verdict: 'pass' | 'fail';
  reasoning: string;
  issues: string[];
}

export interface ReviewReport {
  generatedAt: string;
  apiUrl: string;
  model: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
  };
  results: ReviewResult[];
}

interface ReviewOptions {
  pageFilter?: string;
  onProgress?: (index: number, total: number, item: ReviewItem, result: ReviewResult) => void;
}

interface LlmVerdict {
  verdict: 'pass' | 'fail';
  reasoning: string;
  issues: string[];
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

interface ReviewerConfig {
  apiUrl?: string;
  apiKey?: string;
  model?: string;
  instructions?: string;
  timeout?: number;
}

// ── Defaults ────────────────────────────────────────────────────

const DEFAULT_INSTRUCTIONS = `# UI Patrol — Visual Reviewer

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

## What Does NOT Count as a Fail

- Minor cosmetic differences (font rendering, slight color variations, anti-aliasing)
- Content differences that don't affect functionality (different user names, dates, row counts)
- Elements that are present but styled slightly differently than described

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

// ── Reviewer ────────────────────────────────────────────────────

export class PatrolReviewer {
  private apiUrl: string;
  private apiKey: string;
  private model: string;
  private instructions: string;
  private timeout: number;

  constructor(config: ReviewerConfig = {}) {
    this.apiUrl = config.apiUrl ?? process.env.LLM_API_URL ?? REVIEW_DEFAULTS.apiUrl;
    this.apiKey = config.apiKey ?? '';
    this.model = config.model ?? REVIEW_DEFAULTS.model;
    this.timeout = config.timeout ?? REVIEW_DEFAULTS.timeout;

    // Instructions: if it's a file path that exists, read it. Otherwise use as inline text.
    if (config.instructions) {
      if (fs.existsSync(config.instructions)) {
        this.instructions = fs.readFileSync(config.instructions, 'utf-8');
      } else {
        this.instructions = config.instructions;
      }
    } else {
      this.instructions = DEFAULT_INSTRUCTIONS;
    }
  }

  /**
   * Build review items from page configs.
   */
  buildReviewItems(pages: PageConfig[], screenshotDir: string): ReviewItem[] {
    const items: ReviewItem[] = [];

    for (const page of pages) {
      const phaseFolder = slugify(page.phase);
      const pageSlug = slugify(page.name);

      items.push({
        page: page.name,
        url: page.path,
        action: 'navigate',
        elementLabel: null,
        screenshot: path.join(screenshotDir, `${phaseFolder}/${pageSlug}/navigate.png`),
        expectation: page.expectation,
        checks: page.checks,
      });

      for (const group of page.actionGroups) {
        const groupSlug = slugify(group.description);

        for (let ai = 0; ai < group.actions.length; ai++) {
          const action = group.actions[ai];
          const actionSlug = slugify(action.label);

          items.push({
            page: page.name,
            url: page.path,
            action: 'click',
            elementLabel: action.label,
            screenshot: path.join(
              screenshotDir,
              `${phaseFolder}/${pageSlug}/${groupSlug}/${ai + 1}.${actionSlug}.png`,
            ),
            expectation: action.expectation,
            checks: action.checks,
          });
        }
      }
    }

    return items;
  }

  /**
   * Review all items and return a report.
   */
  async review(items: ReviewItem[], options?: ReviewOptions): Promise<ReviewReport> {
    let filtered = items;

    if (options?.pageFilter) {
      const filter = options.pageFilter.toLowerCase();
      filtered = items.filter((i) => i.page.toLowerCase() === filter);
    }

    const results: ReviewResult[] = [];
    let passed = 0;
    let failed = 0;

    for (let i = 0; i < filtered.length; i++) {
      const item = filtered[i];

      if (!fs.existsSync(item.screenshot)) {
        const result: ReviewResult = {
          page: item.page,
          url: item.url,
          action: item.action,
          elementLabel: item.elementLabel,
          screenshot: item.screenshot,
          verdict: 'fail',
          reasoning: 'Screenshot file not found',
          issues: [`Missing: ${item.screenshot}`],
        };
        results.push(result);
        failed++;
        options?.onProgress?.(i, filtered.length, item, result);
        continue;
      }

      const llmResult = await this.reviewScreenshot(item);

      const result: ReviewResult = {
        page: item.page,
        url: item.url,
        action: item.action,
        elementLabel: item.elementLabel,
        screenshot: item.screenshot,
        verdict: llmResult.verdict,
        reasoning: llmResult.reasoning,
        issues: llmResult.issues,
      };

      results.push(result);

      if (llmResult.verdict === 'pass') {
        passed++;
      } else {
        failed++;
      }

      options?.onProgress?.(i, filtered.length, item, result);
    }

    return {
      generatedAt: new Date().toISOString(),
      apiUrl: this.apiUrl,
      model: this.model,
      summary: { total: results.length, passed, failed },
      results,
    };
  }

  /**
   * Send a single screenshot to the LLM via OpenAI-compatible API.
   */
  private async reviewScreenshot(item: ReviewItem): Promise<LlmVerdict> {
    const imageData = fs.readFileSync(item.screenshot).toString('base64');

    let context = `Page: ${item.page} (${item.url})`;
    if (item.elementLabel) {
      context += `\nAction: ${item.action} "${item.elementLabel}"`;
    } else {
      context += `\nAction: ${item.action}`;
    }

    const checksText = item.checks.length > 0 ? `\nChecks: ${item.checks.join(', ')}` : '';

    const userMessage = `${context}\n\n## Expected\n${item.expectation}${checksText}\n\nAnalyze the attached screenshot and respond with your verdict in JSON format.`;

    const payload = {
      model: this.model,
      messages: [
        { role: 'system', content: this.instructions },
        {
          role: 'user',
          content: [
            { type: 'text', text: userMessage },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${imageData}` } },
          ],
        },
      ],
      max_tokens: 1024,
      temperature: 0.1,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    try {
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeout),
      });

      if (!response.ok) {
        const body = await response.text();
        return {
          verdict: 'fail',
          reasoning: `API returned HTTP ${response.status}: ${body.substring(0, 200)}`,
          issues: ['API request failed'],
        };
      }

      const data = (await response.json()) as ChatCompletionResponse;
      const content = data.choices?.[0]?.message?.content;

      return content
        ? this.parseLlmResponse(content)
        : { verdict: 'fail', reasoning: 'Empty response from API', issues: ['Empty API response'] };
    } catch (err) {
      return {
        verdict: 'fail',
        reasoning: `API error: ${String(err)}`,
        issues: [`Exception: ${String(err)}`],
      };
    }
  }

  /**
   * Parse LLM response JSON, handling markdown code fences.
   */
  private parseLlmResponse(content: string): LlmVerdict {
    let cleaned = content.trim();

    const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      cleaned = fenceMatch[1].trim();
    }

    try {
      const parsed = JSON.parse(cleaned) as { verdict?: string; reasoning?: string; issues?: string[] };
      const verdict = parsed.verdict;

      if (verdict !== 'pass' && verdict !== 'fail') {
        return {
          verdict: 'fail',
          reasoning: `Invalid verdict in LLM response. Raw: ${content.substring(0, 200)}`,
          issues: ['Missing valid "pass" or "fail" verdict'],
        };
      }

      return {
        verdict,
        reasoning: parsed.reasoning ?? 'No reasoning provided',
        issues: parsed.issues ?? [],
      };
    } catch {
      return {
        verdict: 'fail',
        reasoning: `Unparseable LLM response. Raw: ${content.substring(0, 200)}`,
        issues: ['LLM response was not valid JSON'],
      };
    }
  }
}
