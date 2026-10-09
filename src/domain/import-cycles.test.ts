// No module in `src/` imports itself back.
//
// Three cycles ran through the coordinator. `classifier.ts` and
// `composer.ts` read the conversation turn type and the prompt renderer from
// the coordinator, and the coordinator calls both. `groundedness/scoring.ts`
// imported the per-draft scorer from a module that ran a CLI guard at import
// time, and that module imported the scorer's file back — so loading the
// scorer started a command.
//
// Type-only edges count here. Two of the three cycles were type-only and
// erased at runtime, so a rule that ignored them would have reported the
// repository clean while a leaf module still had to name the orchestrator to
// learn what a turn is. That is the coupling the issue names, and it is the
// one this guard measures.
//
// Parsed with the compiler, never matched: a regex over import lines is
// defeated by a multi-line specifier list and by `export ... from`, and this
// repository has been caught by pattern-matched guards before.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC = join(REPO_ROOT, 'src');

/** Production modules. A suite may import anything; it is nobody's dependency. */
function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') found.push(...sourceFiles(full));
      continue;
    }
    if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) found.push(full);
  }
  return found;
}

const FILES = sourceFiles(SRC);
const IN_SCAN = new Set(FILES);

/** The repository-relative name, in one spelling on every platform. */
function name(file: string): string {
  return relative(REPO_ROOT, file).split(sep).join('/');
}

/**
 * The modules one file names, as absolute paths.
 *
 * `import` and `export ... from` both create the edge. NodeNext specifiers
 * end in `.js` and the file on disk is `.ts`, so the suffix is swapped; a
 * specifier that resolves to nothing inside the scan — a package, a type
 * declaration — is not an edge in this graph.
 */
function importsOf(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.ESNext,
    true,
  );
  const edges = new Set<string>();
  const visit = (node: ts.Node): void => {
    let specifier: ts.Expression | undefined;
    if (ts.isImportDeclaration(node)) specifier = node.moduleSpecifier;
    else if (ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
    if (specifier !== undefined && ts.isStringLiteral(specifier) && specifier.text.startsWith('.')) {
      const target = resolve(dirname(file), specifier.text.replace(/\.js$/, '.ts'));
      if (IN_SCAN.has(target)) edges.add(target);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...edges];
}

const GRAPH = new Map(FILES.map((file) => [file, importsOf(file)]));

/**
 * Every group of modules that can reach each other, Tarjan's algorithm.
 *
 * A group larger than one is a cycle; so is a single module that names
 * itself. Whole groups rather than one example each, because a cycle of four
 * reported as one pair sends its reader to the wrong two files.
 */
function cyclicGroups(graph: ReadonlyMap<string, readonly string[]>): string[][] {
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const groups: string[][] = [];

  const walk = (node: string): void => {
    index.set(node, counter);
    low.set(node, counter);
    counter++;
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!index.has(next)) {
        walk(next);
        low.set(node, Math.min(low.get(node)!, low.get(next)!));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node)!, index.get(next)!));
      }
    }
    if (low.get(node) !== index.get(node)) return;
    const group: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      group.push(member);
    } while (member !== node);
    if (group.length > 1 || (graph.get(node) ?? []).includes(node)) groups.push(group);
  };

  for (const node of graph.keys()) if (!index.has(node)) walk(node);
  return groups;
}

describe('the module graph', () => {
  it('read both the files and their edges, so an empty result means something', () => {
    // Without this the rule below could pass because the walk found nothing.
    expect(FILES.length).toBeGreaterThan(100);
    expect(GRAPH.get(join(SRC, 'coordinator/steps/classify.ts'))?.map(name))
      .toContain('src/classifier/classifier.ts');
    // An `export ... from` edge is an edge. `coordinator.ts` re-exports the
    // turn type and names that file nowhere else, so a rule reading
    // `import` alone would not see this edge at all.
    const coordinator = readFileSync(join(SRC, 'coordinator/coordinator.ts'), 'utf8');
    expect(coordinator).toContain(
      "export type { ConversationTurn } from '../domain/conversation-turn.js';",
    );
    expect(coordinator).not.toMatch(/^\s*import[^\n]*conversation-turn\.js/m);
    expect(GRAPH.get(join(SRC, 'coordinator/coordinator.ts'))?.map(name))
      .toContain('src/domain/conversation-turn.ts');
  });

  it('finds a cycle when there is one', () => {
    // The detector, on a graph built by hand. Without this the rule below
    // could pass because Tarjan's walk was wrong rather than because the
    // repository is clean.
    const cyclic = new Map([['a', ['b']], ['b', ['c']], ['c', ['a']], ['d', ['a']]]);
    expect(cyclicGroups(cyclic).map((group) => [...group].sort())).toEqual([['a', 'b', 'c']]);
    expect(cyclicGroups(new Map([['a', ['b']], ['b', []]]))).toEqual([]);
    expect(cyclicGroups(new Map([['a', ['a']]]))).toEqual([['a']]);
  });

  it('holds no cycle', () => {
    const found = cyclicGroups(GRAPH).map((group) => group.map(name).sort().join(' <-> '));
    expect(found).toEqual([]);
  });

  // The leaf rule, stated separately. The cycle above is the symptom; this is
  // the property the step split asked for, and it stays true even if some other
  // module later imports the coordinator and no cycle results.
  it('keeps the model-call modules clear of the orchestrator', () => {
    for (const leaf of [
      'classifier/classifier.ts',
      'composer/composer.ts',
      'groundedness/groundedness.ts',
      'triage/select.ts',
      'domain/conversation-turn.ts',
    ]) {
      expect(
        GRAPH.get(join(SRC, leaf))?.map(name),
        `${leaf} reaches the coordinator`,
      ).not.toContain('src/coordinator/coordinator.ts');
    }
  });

  // The turn type and its renderers are the module every prompt reads, so it
  // must drag nothing behind it at all.
  it('lets a module read a conversation turn without loading anything else', () => {
    expect(GRAPH.get(join(SRC, 'domain/conversation-turn.ts'))).toEqual([]);
    expect(readFileSync(join(SRC, 'domain/conversation-turn.ts'), 'utf8'))
      .not.toMatch(/^\s*import\b/m);
  });
});
