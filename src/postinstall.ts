#!/usr/bin/env node
/**
 * Postinstall script — runs after `npm install ui-patrol`.
 * Creates config and example files only if they don't exist.
 * Adds npm scripts to package.json if not present.
 * Runs in the user's project root (INIT_CWD), not inside node_modules.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// INIT_CWD is set by npm to the directory where `npm install` was run
const projectRoot = process.env.INIT_CWD ?? process.cwd();

const CONFIG_NAMES = ['ui-patrol.config.ts', 'ui-patrol.config.js', 'ui-patrol.config.json'];
const hasConfig = CONFIG_NAMES.some((name) => fs.existsSync(path.join(projectRoot, name)));
const hasPages = fs.existsSync(path.join(projectRoot, 'pages.json'));

// Find the cli script path relative to this file
const cliPath = path.join(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')),
  'cli',
  'index.js',
);

try {
  if (!hasConfig) {
    execSync(`node "${cliPath}" init`, { cwd: projectRoot, stdio: 'inherit' });
  }
  if (!hasPages) {
    execSync(`node "${cliPath}" example`, { cwd: projectRoot, stdio: 'inherit' });
  }
} catch {
  // Non-critical — don't fail the install
}

// ── Add npm scripts to package.json ─────────────────────────────

const SCRIPTS: Record<string, string> = {
  'patrol': 'ui-patrol run',
  'patrol:review': 'ui-patrol review',
  'patrol:full': 'ui-patrol run --review',
};

try {
  const pkgPath = path.join(projectRoot, 'package.json');

  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
      scripts?: Record<string, string>;
    };

    if (!pkg.scripts) pkg.scripts = {};

    let added = false;
    for (const [name, command] of Object.entries(SCRIPTS)) {
      if (!pkg.scripts[name]) {
        pkg.scripts[name] = command;
        added = true;
      }
    }

    if (added) {
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 4) + '\n', 'utf-8');
      console.log('Added npm scripts: patrol, patrol:review, patrol:full');
    }
  }
} catch {
  // Non-critical
}
