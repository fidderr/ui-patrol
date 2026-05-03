import type { Page, ConsoleMessage } from '@playwright/test';

export interface ConsoleFinding {
  type: string;
  text: string;
  timestamp: string;
}

export interface ConsoleCapture {
  errors: ConsoleFinding[];
  warnings: ConsoleFinding[];
}

export function createConsoleCapture(page: Page) {
  const errors: ConsoleFinding[] = [];
  const warnings: ConsoleFinding[] = [];

  const handler = (msg: ConsoleMessage) => {
    const finding: ConsoleFinding = {
      type: msg.type(),
      text: msg.text(),
      timestamp: new Date().toISOString(),
    };

    if (msg.type() === 'error') {
      errors.push(finding);
    } else if (msg.type() === 'warning') {
      warnings.push(finding);
    }
  };

  page.on('console', handler);

  return {
    flush(): ConsoleCapture {
      const result: ConsoleCapture = {
        errors: [...errors],
        warnings: [...warnings],
      };
      errors.length = 0;
      warnings.length = 0;
      return result;
    },
    detach() {
      page.removeListener('console', handler);
    },
  };
}
