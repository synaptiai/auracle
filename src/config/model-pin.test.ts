// The default chat model pin, and the documents that state it.
//
// The previous default was retired by the provider. Nothing in the repository
// noticed: no test named the pin, and the runbook stated it in prose beside a
// literal in source. So an operator following the documented default start met
// a catalogue error, and the only signal was a failed model call.
//
// These cases bind the two together. The pin lives in one place, and the
// runbook must state that place's value.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { DEFAULT_CHAT_MODEL_VER } from './env.js';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;

/**
 * Every shipped source and document.
 *
 * The scan names the shipped trees rather than excluding the others. A
 * decision journal records that a model was retired, and a design note carries
 * an author of the same name; neither is guidance an operator follows.
 */
const SHIPPED_TREES = ['src', 'docs', 'db', 'scripts', 'evals'];
const SHIPPED_FILES = ['README.md', 'CONTRIBUTING.md', 'AGENTS.md', 'REVIEW.md'];

function shippedFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      shippedFiles(path, acc);
    } else if (/\.(ts|md|sql|mjs|json|py)$/.test(entry)) {
      acc.push(path);
    }
  }
  return acc;
}

function shipped(): string[] {
  const acc = SHIPPED_TREES.flatMap((tree) => shippedFiles(join(REPO_ROOT, tree)));
  return [...acc, ...SHIPPED_FILES.map((name) => join(REPO_ROOT, name))];
}

/**
 * Blanks the comments in a source file, and optionally its string literals,
 * in one pass so whichever construct opens first wins. Stripping comments in a
 * pass of their own reads a `//` inside a string literal as a comment and
 * blanks the rest of that line — which can hide a declared escalation reason
 * or a stated answer budget and let a scan pass over the very thing it guards.
 *
 * Lengths are preserved, so an index taken on the result addresses the same
 * character in the original.
 */
function blankNoise(src: string, options: { literals: boolean }): string {
  return src.replace(
    /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (tok) => {
      const isLiteral = /^['"`]/.test(tok);
      if (isLiteral && !options.literals) return tok;
      const blank = tok.replace(/[^\n]/g, ' ');
      // A blanked literal keeps its quotes, so a scan reading a call body
      // still sees an argument where one stood.
      return isLiteral ? tok[0] + blank.slice(2) + tok[0] : blank;
    },
  );
}

describe('the answer budget every model call states', () => {
  it('is stated at every call site, so a new one cannot arrive without it', () => {
    // The composer sat at 512 through a whole review cycle because the check
    // was a grep for one literal. This reads the call sites instead.
    // Every call site, whatever its shape. A single-line call and a call
    // taking a variable both escaped a scan that required a brace and a
    // newline before the closing paren.
    const sites = shipped()
      .filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts'))
      .flatMap((path) => {
        const src = readFileSync(path, 'utf8');
        // Comments and string literals are both blanked before the walk. The
        // walk counted a paren inside a message string, which ran the body
        // past the call and absorbed a later call's budget. An unbalanced
        // paren in a comment does the same, and blanking only the literals
        // left that half of the bypass open: a budget line replaced by
        // `// note (` hid the site and took the next call's budget as its own.
        const scan = blankNoise(src, { literals: true });
        return [...scan.matchAll(/\.complete\(/g)].map((m) => {
          // Read to the matching paren so a one-line call is covered too.
          let depth = 0;
          let i = (m.index ?? 0) + '.complete('.length - 1;
          do {
            if (scan[i] === '(') depth++;
            else if (scan[i] === ')') depth--;
            i++;
          } while (depth > 0 && i < scan.length);
          return { path: path.slice(REPO_ROOT.length), body: src.slice(m.index ?? 0, i) };
        });
      })
      // The meter forwards a call it was handed and states no budget of its
      // own; it is the one site that legitimately passes its argument through.
      .filter((site) => !/\.complete\(\s*call\s*\)/.test(site.body));
    expect(sites.length).toBeGreaterThanOrEqual(5);
    for (const site of sites) {
      expect(site.body, `${site.path} calls a model with no answer budget`).toContain(
        'maxOutputTokens',
      );
    }
  });
});

describe('the scan that blanks a source file before reading it', () => {
  it('does not let a comment marker inside a string swallow the code after it', () => {
    // The sharp case, and the reason both scans share one pass. Stripping
    // block comments in a pass of their own starts at the `/*` inside this
    // string and runs to the next `*/` anywhere later in the file, which can
    // remove a whole declaration and let a scan pass over what it guards.
    const src = [
      "const note = 'see /* the docs';",
      "export type EscalationReason = 'limit_cost' | 'gate_blocked';",
      '/* an ordinary block comment */',
    ].join('\n');

    const bare = blankNoise(src, { literals: false });
    expect(bare).toContain("'limit_cost'");
    expect(bare).toContain("'gate_blocked'");
    // The ordinary comment is still gone, so the blanking did happen.
    expect(bare).not.toContain('an ordinary block comment');
    // Lengths are preserved, so an index taken here addresses the original.
    expect(bare.length).toBe(src.length);
  });

  it('does not read a comment marker inside a string as a comment', () => {
    // A `//` in a URL blanked the rest of its line. Where that line also
    // carried a stated answer budget, the budget went missing and the guard
    // reported a call site that states one as a call site that does not.
    const src = "await m.complete({ url: 'https://x', maxOutputTokens: 1024 });";
    const scan = blankNoise(src, { literals: true });
    expect(scan).toContain('maxOutputTokens');
    expect(scan).not.toContain('https');
    expect(scan.length).toBe(src.length);
  });
});

/**
 * The reasons an escalate answer can carry, read from the syntax.
 *
 * Two shapes: the object a step returns, `{ kind: 'escalate', reason: … }`
 * in either property order, and a `stopEscalated(ctx, …)` call. A reason
 * chosen by a ternary contributes both of its literals.
 */
function escalateReasons(files: readonly string[]): string[] {
  const reasons: string[] = [];
  const literals = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) && /^[a-z_]+$/.test(node.text)) reasons.push(node.text);
    ts.forEachChild(node, literals);
  };
  for (const file of files) {
    const source = ts.createSourceFile(
      file, readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        const property = (key: string): ts.ObjectLiteralElementLike | undefined =>
          node.properties.find((p) => p.name !== undefined && ts.isIdentifier(p.name)
            && p.name.text === key);
        const kind = property('kind');
        const reason = property('reason');
        if (
          kind !== undefined && reason !== undefined
          && ts.isPropertyAssignment(kind) && ts.isStringLiteral(kind.initializer)
          && kind.initializer.text === 'escalate'
          && ts.isPropertyAssignment(reason)
        ) literals(reason.initializer);
      }
      if (
        ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && /^(step)?[sS]topEscalated$/.test(node.expression.text)
      ) for (const argument of node.arguments) literals(argument);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return reasons;
}

/** Every production module of the coordinator, the step modules included. */
function coordinatorSources(): string[] {
  const root = join(REPO_ROOT, 'src/coordinator');
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) found.push(full);
    }
  };
  walk(root);
  return found;
}

describe('the escalation reasons the runbook explains', () => {
  it('names every reason the coordinator can record', () => {
    // The runbook enumerated the causes in prose and the enumeration went
    // stale the moment a reason was added. An operator reads these out of
    // `pnpm run escalations` and needs to know what to do about each.
    // Read the reasons the coordinator actually escalates with, not a slice
    // of a type declaration. A union member written without a leading pipe,
    // or contributed by a helper declared after the slice's end marker, was
    // invisible to the earlier scan and passed silently.
    // The declaration moved to `src/coordinator/types.ts` and the escalate
    // answers to the step modules under `steps/` (issue #75), so the scan
    // reads the directory rather than one file. A step added there with a
    // reason of its own is seen; a scan pinned to `coordinator.ts` would
    // have silently stopped seeing any of them.
    const source = readFileSync(join(REPO_ROOT, 'src/coordinator/types.ts'), 'utf8');
    // The declaration, read to its terminating semicolon rather than to the
    // next export. A member written without a leading pipe was invisible to a
    // pipe-anchored scan, and a member contributed after the old end marker
    // fell outside the slice entirely; both passed silently.
    // Comments are blanked first. A semicolon inside a member's doc comment
    // truncated the slice and hid every member after it, which is the same
    // silent pass this scan was rewritten to close — and semicolons in prose
    // comments are idiomatic in this tree. The literals stay: the reasons are
    // read out of them. Blanking them in a pass of their own read a `//`
    // inside a string as a comment and took the rest of that line with it.
    const bare = blankNoise(source, { literals: false });
    const start = bare.indexOf('export type EscalationReason');
    expect(start).toBeGreaterThan(-1);
    const declaration = bare.slice(start, bare.indexOf(';', start));
    const declared = [...declaration.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string);
    // A member that is a type reference rather than a literal would hide its
    // reasons from this scan, so refuse one rather than pass over it.
    const referenced = declaration
      .replace(/'[a-z_]+'/g, '')
      .match(/\|\s*([A-Z][A-Za-z0-9_]*)/g);
    expect(referenced, 'a reason contributed by a helper union cannot be read here').toBe(null);
    // Plus every reason actually escalated with a literal, so one escalated
    // and never declared is caught too.
    // Every literal inside the call's own parentheses, so a reason chosen by
    // a ternary is seen and a nearby string is not.
    // Every literal inside an escalate answer, so a reason chosen by a
    // ternary is seen and a nearby string is not. `stopEscalated` stays in
    // the scan: the sequencer still calls it, and a caller outside a step
    // would otherwise be invisible.
    //
    // Parsed, not matched. The first version required `kind` to precede
    // `reason`, so `{ reason: 'x', kind: 'escalate' }` — legal, and the
    // same object — was invisible and an undeclared reason would ship.
    // Property order is not a thing a guard may depend on.
    const escalated = escalateReasons(coordinatorSources());
    // The scan found the answers. Without this it could pass because the
    // step modules moved again and the pattern matched nothing.
    expect(escalated.length, 'no escalate answer was found in src/coordinator/').toBeGreaterThan(6);
    for (const reason of escalated) {
      expect(declared, `${reason} is escalated and not declared`).toContain(reason);
    }
    const reasons = [...new Set([...declared, ...escalated])];
    expect(reasons.length).toBeGreaterThanOrEqual(10);
    const runbook = readFileSync(join(REPO_ROOT, 'docs/operations.md'), 'utf8');
    for (const reason of reasons) {
      expect(runbook, `${reason} is a cause the runbook does not explain`).toContain(
        `\`${reason}\``,
      );
    }
  });
});

describe('the default chat model pin', () => {
  it('is a single value the rest of the repository can name', () => {
    expect(DEFAULT_CHAT_MODEL_VER).toMatch(/^[a-z0-9-]+\/[a-z0-9.:-]+$/);
  });

  it('is not a model the provider has retired', () => {
    // Assembled from parts so this suite does not match itself.
    const retired = ['ox', 'alpha'].join('-');
    const naming = shipped().filter((path) => readFileSync(path, 'utf8').includes(retired));
    expect(naming.map((p) => p.slice(REPO_ROOT.length))).toEqual([]);
  });

  it('states every chat model default it pins in the runbook', () => {
    // The guard read one default and one runbook row. A second default lived
    // in the induction job, named nowhere an operator reads, and could drift
    // exactly as the first one did.
    const runbook = readFileSync(join(REPO_ROOT, 'docs/operations.md'), 'utf8');
    // Whole file, not line by line. The earlier scan required the model word
    // and the fallback on one line, so a formatter wrapping a long default
    // onto its own line defeated it silently — the very drift this guard
    // exists to catch. Anchoring on the vendor prefix keeps a MIME type out,
    // and requiring a fallback or an assignment keeps a dimension or price
    // table out, because those literals are object keys.
    const vendor = '(?:openai|z-ai|anthropic|nvidia|google|meta-llama|mistralai|deepseek|qwen|x-ai)';
    // `return` counts too: a default handed back from a function is still a
    // default, and an anchor of assignment alone could not see one.
    const asDefault = new RegExp(`(?:\\?\\?|=|:|\\breturn)\\s*'(${vendor}/[a-z0-9.:-]+)'`, 'g');
    const defaults = shipped()
      .filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts'))
      .flatMap((path) => [...readFileSync(path, 'utf8').matchAll(asDefault)]
        .map((m) => m[1] as string));
    expect(defaults.length).toBeGreaterThan(0);
    for (const id of new Set(defaults)) {
      expect(runbook, `${id} is pinned in source and named nowhere in the runbook`).toContain(id);
    }
  });

  it('is the value the runbook states as the default', () => {
    const runbook = readFileSync(join(REPO_ROOT, 'docs/operations.md'), 'utf8');
    const row = runbook.split('\n').find((line) => line.includes('| `MODEL_VER` |'));
    expect(row).toBeDefined();
    expect(row).toContain(DEFAULT_CHAT_MODEL_VER);
  });
});
