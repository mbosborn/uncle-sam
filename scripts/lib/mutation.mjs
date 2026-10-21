import { readdirSync, readFileSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Explicit source/fixture allowlist. No .env, private docs, candidate exports,
// operational state, git history, model credentials or filesystem symlinks.
export function snapshotFiles(root) {
  const files = [];
  function walk(relative, extension) {
    const folder = path.join(root, relative);
    if (lstatSync(folder).isSymbolicLink()) throw Error(`Mutation snapshot refuses symlink: ${relative}`);
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const name = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw Error(`Mutation snapshot refuses symlink: ${name}`);
      if (entry.isDirectory()) walk(name, extension);
      else if (entry.isFile() && name.endsWith(extension)) files.push(name);
    }
  }
  walk('service/lib', '.mjs'); walk('service/drizzle', '.sql');
  walk('test/replay', '.mjs'); walk('test/support', '.mjs'); walk('test/mutation', '.mjs');
  // Static validation schema imported by document-content-check, not documents.
  for (const name of ['fields', 'nda', 'ciiaa', 'terms']) files.push(`service/lib/document-schemas/${name}.json`);
  return files.sort();
}
export function fingerprint(root, files) {
  const hash = createHash('sha256');
  for (const file of files) hash.update(file).update('\0').update(readFileSync(path.join(root, file))).update('\0');
  return hash.digest('hex');
}
export function copySnapshot(root, dest, files) {
  for (const file of files) {
    // Recheck immediately before reading in case the source changed meanwhile.
    if (!lstatSync(path.join(root, file)).isFile()) throw Error('Mutation source changed while copying');
    const target = path.join(dest, file); mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, readFileSync(path.join(root, file)), { mode: 0o600 });
  }
}
export function summarize(report, targets) {
  const rows = [], seen = new Set();
  const testNames = new Map(Object.values(report?.testFiles ?? {}).flatMap(file => file.tests).map(test => [test.id, test.name]));
  for (const target of targets) {
    const mutants = report?.files?.[target.file]?.mutants ?? [];
    const selected = mutants.filter(m => m.mutatorName === 'ConditionalExpression'
      && m.location?.start.line === target.start.line && m.location.start.column === target.start.column + 1
      && m.location?.end.line === target.end.line && m.location.end.column === target.end.column + 1);
    if (selected.length !== 2 || !selected.some(m => m.replacement === 'true') || !selected.some(m => m.replacement === 'false'))
      throw Error(`Expected both guard mutations: ${target.id}`);
    for (const mutant of selected) {
      seen.add(`${target.file}:${mutant.id}`);
      const witnesses = (mutant.killedBy ?? []).map(id => {
        if (!testNames.has(id)) throw Error('Mutation report references an unknown test');
        return testNames.get(id);
      });
      const missing = mutant.replacement === 'false' ? target.witnesses.filter(id => !witnesses.includes(id)) : [];
      rows.push({ safeguard: target.id, file: target.file, line: target.start.line, replacement: mutant.replacement,
        status: mutant.status, killedBy: witnesses, missingWitnesses: missing,
        passed: mutant.status === 'Killed' && witnesses.length > 0 && missing.length === 0 });
    }
  }
  const unexpected = Object.entries(report.files).flatMap(([file, value]) => value.mutants
    .filter(m => m.status !== 'Ignored' && !seen.has(`${file}:${m.id}`)).map(m => `${file}:${m.id}`));
  if (unexpected.length) throw Error('Mutation engine produced unexpected active mutants; review the campaign scope');
  return { passed: rows.every(row => row.passed), tested: rows.length, killed: rows.filter(r => r.status === 'Killed').length, mutations: rows };
}
