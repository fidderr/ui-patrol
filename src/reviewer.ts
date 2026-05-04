import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { slugify, type PageConfig } from './config.js';
import { REVIEW_DEFAULTS } from './defaults.js';
import { REVIEWER_INSTRUCTIONS } from './llm-knowledge.js';

// ── Types ───────────────────────────────────────────────────────

export interface ReviewItem {
  page: string;
  url: string;
  action: string;
  elementName: string | null;
  screenshot: string;
  expectation: string;
  checks: string[];
}

export interface ReviewResult {
  page: string;
  url: string;
  action: string;
  elementName: string | null;
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
  appDescription?: string;
}

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
      this.instructions = REVIEWER_INSTRUCTIONS;
    }

    // Append app description to instructions if provided
    if (config.appDescription) {
      this.instructions += `\n\n## About This Application\n\n${config.appDescription}`;
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
        elementName: null,
        screenshot: path.join(screenshotDir, `${phaseFolder}/${pageSlug}/navigate.png`),
        expectation: page.expectation,
        checks: page.checks,
      });

      for (const group of page.actionGroups) {
        const groupSlug = slugify(group.description);

        for (let ai = 0; ai < group.actions.length; ai++) {
          const action = group.actions[ai];
          const actionSlug = slugify(action.name);

          items.push({
            page: page.name,
            url: page.path,
            action: action.typeText !== undefined ? 'type' : 'click',
            elementName: action.name,
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
          elementName: item.elementName,
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
        elementName: item.elementName,
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
    const imageData = (await fsp.readFile(item.screenshot)).toString('base64');

    let context = `Page: ${item.page} (${item.url})`;
    if (item.elementName) {
      context += `\nAction: ${item.action} "${item.elementName}"`;
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
      max_tokens: REVIEW_DEFAULTS.maxTokens,
      temperature: REVIEW_DEFAULTS.temperature,
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
