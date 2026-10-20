/**
 * File helpers shared by the setup scripts. Secrets only ever live in files that git and Vercel both ignore;
 * these helpers refuse to work with a file that is not ignored and write private files atomically.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * True when git ignores `file`. Outside a git checkout (or for a path outside this repository, as in the tests)
 * it falls back to the repository's .gitignore containing `fallbackRule`.
 */
export function isIgnored(root, file, fallbackRule) {
  const r = spawnSync('git', ['check-ignore', '-q', file], { cwd: root });
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  const gitignore = path.join(root, '.gitignore');
  return existsSync(gitignore) && fallbackRule.test(readFileSync(gitignore, 'utf8'));
}

/**
 * Writes `text` to `file` with mode 600 through a temporary sibling, so an interrupted write never leaves a half-written
 * secrets file. The temporary name starts with .env so the .env* ignore rules cover it too.
 */
export function writePrivate(file, text) {
  const temporary = path.join(path.dirname(file), `.env.tmp-${process.pid}-${path.basename(file)}`);
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, file);
}
