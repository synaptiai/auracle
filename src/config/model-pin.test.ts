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
import { isFrozenRecord } from '../test-support/frozen-records.js';
import { constantText, memberReaches, nodesOf, parseSource } from '../test-support/source-reader.js';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;

/**
 * The counts the two scans must find: the model call sites and the pinned
 * defaults the tree holds today. A reader that lost one would pass a floor
 * while a new site stood in for it, so each count is exact. A new site or
 * default changes it here, on purpose.
 */
const MODEL_CALL_SITES = 6;
const PINNED_DEFAULTS = 5;

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
  // A frozen record is dated reasoning, not guidance. Two design records name
  // the model pinned when they were written, and that is what they are for.
  // `src/test-support/frozen-records.ts` says which directories.
  return [...acc, ...SHIPPED_FILES.map((name) => join(REPO_ROOT, name))]
    .filter((path) => !isFrozenRecord(path));
}

/**
 * Every call to a model's `complete` in a module, read from the tree, with the
 * text of each whole call.
 *
 * The scan used to blank comments and strings with one pattern, and then walk
 * parentheses to find a call's end. A pattern has to guess where a string
 * ends: a `//` inside a URL once blanked the stated budget after it, and a
 * quote inside a regular expression would have shifted every string after
 * it. The compiler reads the call whole, so neither a string nor a comment
 * can hide one or pose as one, and a paren in a message is only text.
 */
function completeCalls(
  text: string,
  file: string,
): Array<{ text: string; statesBudget: boolean; passesThrough: boolean }> {
  const source = parseSource(file, text);
  // A budget is a property of that name on the call's own request: the
  // object literal it passes first. A comment or a string that names it is
  // not one. Nor is a key nested in another object, one inside a callback,
  // or one set to `undefined`, which states no budget at all.
  const statesBudget = (call: ts.CallExpression): boolean => {
    const request = call.arguments[0];
    if (request === undefined || !ts.isObjectLiteralExpression(request)) return false;
    return request.properties.some((property) => {
      if (!(ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))) return false;
      const key = property.name;
      if (!((ts.isIdentifier(key) || ts.isStringLiteral(key)) && key.text === 'maxOutputTokens')) return false;
      if (ts.isShorthandPropertyAssignment(property)) return true;
      const value = property.initializer;
      return !(ts.isIdentifier(value) && value.text === 'undefined') && !ts.isVoidExpression(value);
    });
  };
  // The callee inside any wrapper that changes nothing: `m[METHOD]!(…)`.
  const callee = (call: ts.CallExpression): ts.Expression => {
    let at: ts.Expression = call.expression;
    while (ts.isParenthesizedExpression(at) || ts.isNonNullExpression(at) || ts.isAsExpression(at)
      || ts.isSatisfiesExpression(at)) at = at.expression;
    return at;
  };
  return nodesOf(source)
    .filter(ts.isCallExpression)
    .filter((call) => {
      const at = callee(call);
      if (ts.isPropertyAccessExpression(at)) return at.name.text === 'complete';
      // A key a constant holds names the method as a literal key does.
      if (!ts.isElementAccessExpression(at)) return false;
      const key = at.argumentExpression;
      return (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key) ? key.text : constantText(key)) === 'complete';
    })
    .map((call) => ({
      text: call.getText(source),
      statesBudget: statesBudget(call),
      // The meter forwards a call it was handed and states no budget of its
      // own. The case below allows exactly that one site, in that module, and
      // no other call that passes its argument through.
      passesThrough: call.arguments.length === 1 && ts.isIdentifier(call.arguments[0]!)
        && call.arguments[0].text === 'call',
    }));
}

/**
 * Every reach of a model's `complete` that does not call it: `bind`, `call`,
 * a destructure, `Reflect.get`. Each hands the method on, and the call made
 * through it states a budget no scan here reads.
 */
function completeHandedOn(text: string, file: string): string[] {
  const source = parseSource(file, text);
  return memberReaches(source, 'complete').filter(({ call }) => call === null).map(({ node }) => node.getText(source));
}

/** The one module that may forward a call it was handed: the step context's meter. */
const METER_MODULE = 'src/coordinator/steps/context.ts';

/**
 * The node a literal stands for once the wrappers that change nothing are
 * climbed: parentheses, `as`, `satisfies`, a type assertion, and either
 * branch of a conditional, which picks one of two defaults.
 */
function standingFor(node: ts.Node): ts.Node {
  let at = node;
  for (;;) {
    const parent = at.parent;
    if (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent)
      || ts.isTypeAssertionExpression(parent)) {
      at = parent;
    } else if (ts.isConditionalExpression(parent) && parent.condition !== at) {
      at = parent;
    } else {
      return at;
    }
  }
}

/** The operators whose right side is a default: a fallback or an assignment. */
const DEFAULTING = new Set([
  ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.BarBarEqualsToken,
]);

/**
 * Every model id `text` pins as a default, read from the tree:
 * a literal that is a fallback (`?? 'x'`), an assignment or an initializer,
 * a property's value, or a returned value, in any quote. A literal that is an
 * object key is none: a price or dimension table keys by model, and a key pins
 * nothing. The pattern this replaced matched single quotes alone, so a
 * double-quoted default was invisible.
 */
function pinnedDefaults(text: string, vendor: string, file: string): string[] {
  const id = new RegExp(`^${vendor}/[a-z0-9.:-]+$`);
  return nodesOf(parseSource(file, text))
    .filter((node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && id.test(node.text))
    .filter((literal) => {
      // `'openai/a' as const`, `(x ? 'openai/a' : 'openai/b')` and a
      // parenthesized literal each pin as surely as the bare literal.
      const node = standingFor(literal);
      const parent = node.parent;
      if (ts.isBinaryExpression(parent)) return parent.right === node && DEFAULTING.has(parent.operatorToken.kind);
      if (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isPropertyDeclaration(parent)
        || ts.isBindingElement(parent)) {
        return parent.initializer === node;
      }
      if (ts.isPropertyAssignment(parent)) return parent.initializer === node;
      if (ts.isShorthandPropertyAssignment(parent)) return parent.objectAssignmentInitializer === node;
      if (ts.isArrowFunction(parent)) return parent.body === node;
      return ts.isReturnStatement(parent);
    })
    .map((node) => node.text);
}

/**
 * The members of a string-literal union type, and any member that is not a
 * literal. A member that is a type reference would hide its reasons from a
 * reader of the literals, so it is returned apart to be refused.
 */
function unionMembers(text: string, name: string): { literals: string[]; others: string[] } | null {
  const alias = nodesOf(parseSource('types.ts', text)).find((node): node is ts.TypeAliasDeclaration =>
    ts.isTypeAliasDeclaration(node) && node.name.text === name);
  if (alias === undefined) return null;
  const members = ts.isUnionTypeNode(alias.type) ? [...alias.type.types] : [alias.type];
  const literals: string[] = [];
  const others: string[] = [];
  for (const member of members) {
    if (ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)) literals.push(member.literal.text);
    else others.push(member.getText());
  }
  return { literals, others };
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
      .flatMap((path) => completeCalls(readFileSync(path, 'utf8'), path)
        .map((call) => ({ path: path.slice(REPO_ROOT.length), ...call })));
    expect(sites.length).toBe(MODEL_CALL_SITES);
    const forwarded = sites.filter((site) => site.passesThrough);
    expect(forwarded.map((site) => site.path), 'a call forwarded without a budget, outside the meter')
      .toEqual([METER_MODULE]);
    for (const site of sites.filter((s) => !s.passesThrough)) {
      expect(site.statesBudget, `${site.path} calls a model with no answer budget: ${site.text}`).toBe(true);
    }
    const handedOn = shipped()
      .filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts'))
      .flatMap((path) => completeHandedOn(readFileSync(path, 'utf8'), path).map((text) => `${path.slice(REPO_ROOT.length)}: ${text}`));
    expect(handedOn, 'a model call handed on, whose budget no scan reads').toEqual([]);
  });
});

describe('the readers the two scans use', () => {
  it('reads every complete call whole, and none in a string or a comment', () => {
    const text = [
      "const r = /\"/; const u = \"https://x\"; await m.complete({ maxOutputTokens: 1024 });",
      "const a = \"it's\"; await m.complete({ note: 'see /* the docs (', maxOutputTokens: 256 });",
      "// await m.complete({})",
      "const s = 'await m.complete({})';",
      "await meter.complete(call);",
    ].join('\n');
    const calls = completeCalls(text, 'm.ts');
    expect(calls.map((call) => [call.statesBudget, call.passesThrough])).toEqual([[true, false], [true, false], [false, true]]);
  });

  it('reads a model call handed on rather than made', () => {
    expect(completeHandedOn([
      'const run = deps.provider.complete.bind(deps.provider);',
      'await deps.provider.complete.call(deps.provider, { prompt });',
      'const { complete } = deps.provider;',
      "const METHOD = 'complete'; const c = Reflect.get(deps.provider, METHOD);",
      'await deps.provider.complete({ prompt, maxOutputTokens: 1 });',
    ].join('\n'), 'm.ts')).toEqual([
      'deps.provider.complete', 'deps.provider.complete', 'complete', 'Reflect.get(deps.provider, METHOD)',
    ]);
  });

  it('reads a budget named only in a comment or a string as no budget', () => {
    const calls = completeCalls([
      "await m.complete({ /* maxOutputTokens: 1024 */ prompt });",
      "await m.complete({ note: 'maxOutputTokens: 1024' });",
      "await m.complete(request);",
      "await m['complete']({ prompt });",
      "const METHOD = 'complete'; await m[METHOD]({ prompt });",
      "const METHOD = 'complete'; await m[METHOD]!({ prompt });",
      'await m.complete({ meta: { maxOutputTokens: 1024 }, prompt });',
      'await m.complete({ prompt, parse: () => ({ maxOutputTokens: 1024 }) });',
      'await m.complete({ prompt, maxOutputTokens: undefined });',
    ].join('\n'), 'm.ts');
    expect(calls.map((call) => call.statesBudget)).toEqual([false, false, false, false, false, false, false, false, false]);
  });

  it('reads a pinned default in any quote, and no model id that is a key', () => {
    const vendor = '(?:openai|z-ai)';
    expect(pinnedDefaults([
      "const a = process.env['X'] ?? 'openai/one';",
      'const b = process.env["Y"] ?? "openai/two";',
      "const c = { model: `z-ai/three` };",
      "function d() { return 'openai/four'; }",
      "const prices = { 'openai/key': 1 };",
      "// const e = 'openai/comment';",
      "export const f = 'openai/as' as const;",
      "const g = fast ? 'openai/then' : 'openai/else';",
      "const { model = 'openai/binding' } = opts;",
      "const h = x ?? ('openai/paren');",
      "const i = x || 'openai/or';",
      "m ??= 'openai/assign';",
      "const j = () => 'openai/arrow';",
      "if (model === 'openai/compared') f();",
    ].join('\n'), vendor, 'm.ts')).toEqual([
      'openai/one', 'openai/two', 'z-ai/three', 'openai/four', 'openai/as', 'openai/then', 'openai/else',
      'openai/binding', 'openai/paren', 'openai/or', 'openai/assign', 'openai/arrow',
    ]);
  });

  it('reads a union\'s members, and refuses one that is not a literal', () => {
    const text = [
      "const note = 'see /* the docs';",
      '/** A doc comment; with a semicolon. */',
      "export type EscalationReason =",
      "  | 'limit_cost' // a note; with a semicolon",
      "  | 'gate_blocked'",
      '  | HelperReasons;',
    ].join('\n');
    expect(unionMembers(text, 'EscalationReason')).toEqual({
      literals: ['limit_cost', 'gate_blocked'], others: ['HelperReasons'],
    });
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
    // The runbook enumerated the causes in prose and the enumeration went stale
    // the moment a reason was added. An operator reads these out of
    // `pnpm run escalations` and needs to know what to do about each.
    // Read the reasons the coordinator actually escalates with, not a slice of
    // a type declaration. A union member written without a leading pipe, or
    // contributed by a helper declared after the slice's end marker, was
    // invisible to the earlier scan and passed silently.
    // The declaration moved to `src/coordinator/types.ts` and the escalate
    // answers to the step modules under `steps/`, so the scan reads the
    // directory rather than one file. A step added there with a reason of its
    // own is seen; a scan pinned to `coordinator.ts` would
    // have silently stopped seeing any of them.
    // The declaration, read from the tree. A member written without a leading
    // pipe was invisible to a pipe-anchored scan, a member after the old end
    // marker fell outside the slice, and a semicolon in a doc comment truncated
    // it; each passed silently. The compiler reads the union whole, and a
    // comment in it is trivia.
    const union = unionMembers(readFileSync(join(REPO_ROOT, 'src/coordinator/types.ts'), 'utf8'), 'EscalationReason');
    expect(union, 'the EscalationReason declaration was not found').not.toBeNull();
    const declared = union!.literals;
    // A member that is a type reference rather than a literal would hide its
    // reasons from this scan, so refuse one rather than pass over it.
    expect(union!.others, 'a reason contributed by a helper union cannot be read here').toEqual([]);
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
    // The table row, not the file. A mention anywhere satisfied the earlier
    // scan, so prose that named a reason made its own operator-facing row
    // deletable in silence — and the row is what carries "what you do about
    // it". A check of the whole text stays green when the `internal_fault` row
    // is deleted, because the paragraph beside the table holds the token.
    const rows = new Set(
      [...runbook.matchAll(/^\|\s*`([a-z_]+)`\s*\|/gm)].map((m) => m[1] as string),
    );
    expect(rows.size, 'the runbook holds no reason table at all').toBeGreaterThanOrEqual(10);
    for (const reason of reasons) {
      expect(
        [...rows],
        `${reason} has no row in the runbook's table of causes`,
      ).toContain(reason);
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
    const defaults = shipped()
      .filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts'))
      .flatMap((path) => pinnedDefaults(readFileSync(path, 'utf8'), vendor, path));
    expect(defaults.length).toBe(PINNED_DEFAULTS);
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
