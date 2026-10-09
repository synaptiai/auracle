// Every structured line a process writes goes through the escaping.
//
// `logLine` and `reportJson` escape the characters JSON leaves raw. A line
// written with `JSON.stringify` straight to the console or a stream does not,
// and nothing else would notice: every suite still passes, and a value from a
// header, a form or an adapter reaches the log with a line break or a bidi
// control in it.
//
// Parsed with the compiler, never matched. A regex over call sites is defeated
// by a line break inside the call, and this repository has shipped regex
// guards that ordinary spellings walked through.
//
// What it reads. A write is a call to a console method or a standard stream,
// however it is spelled (`console['error']`, `globalThis.console.log`), a
// call through a name this file bound to one (`const { error } = console`,
// `const out = process.stdout`, an alias of an alias), or a call to a method
// named like a logger (`this.log`, `options.logger`). A write is raw when any
// of its arguments holds, anywhere inside it, a `JSON.stringify` call or
// reference, a `%j` format, a name this file set or appended from one, or a
// call to a function or method this file declares that returns one. Only
// `logLine` and `reportJson` escape JSON: `terminalText` doubles a backslash,
// so its output is no longer JSON a reader can parse back.
//
// It reads conservatively. Names are file-wide, not scoped, and a callback
// passed to `map`, `replace` or `then` counts through what it returns. So a
// finding can be false; it is fixed by writing through `logLine`, which is
// the rule anyway.
//
// What it does not read. A value that reaches a write through another module,
// through an array it was pushed into, through a callback some other call
// returns from, or through `Reflect.apply` is past a one-file parse, and a
// reviewer owns it.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function productionFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist') found.push(...productionFiles(full));
      continue;
    }
    if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) found.push(full);
  }
  return found;
}

const FILES = [
  ...productionFiles(join(REPO_ROOT, 'src')),
  ...productionFiles(join(REPO_ROOT, 'console', 'src')),
];

function name(file: string): string {
  return relative(REPO_ROOT, file).split(sep).join('/');
}

/** A console method or a standard stream's write, as a dotted path. */
const WRITERS = /^(console\.(log|error|warn|info|debug|trace)|process\.(stdout|stderr)\.write)$/;

/**
 * The last name of a callee that is a logger by convention. `write` is left
 * out: a response's `write` sends an HTTP body, and JSON is right there.
 */
const LOGGER_NAMES = /^(log|logger|warn|error|info|debug|trace)$/;

/** The calls whose argument comes back as escaped JSON. */
const ESCAPERS = new Set(['logLine', 'reportJson']);

/**
 * The dotted path a callee names, or null when it names none.
 *
 * `console['error']` is `console.error`, parentheses are dropped, and a
 * leading `globalThis.` or `global.` is dropped, so each spelling of one
 * writer reads as that writer.
 */
function path(node: ts.Expression): string | null {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
    return path(node.expression);
  }
  if (ts.isIdentifier(node)) return node.text;
  if (node.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  if (ts.isPropertyAccessExpression(node)) {
    const head = path(node.expression);
    return head === null ? null : `${head}.${node.name.text}`;
  }
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    const head = path(node.expression);
    return head === null ? null : `${head}.${node.argumentExpression.text}`;
  }
  return null;
}

function bare(dotted: string): string {
  return dotted.replace(/^(globalThis|global)\./, '');
}

function isStringify(node: ts.Node): boolean {
  return ts.isCallExpression(node) && path(node.expression) !== null
    && bare(path(node.expression)!) === 'JSON.stringify';
}

/** The last name of a call's callee, for a method or a plain function. */
function calleeName(node: ts.CallExpression): string | null {
  const dotted = path(node.expression);
  return dotted === null ? null : dotted.slice(dotted.lastIndexOf('.') + 1);
}

/** Whether an identifier is a property name rather than a reference. */
function isPropertyName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent)) return parent.name === node;
  if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)
    || ts.isMethodDeclaration(parent)) return parent.name === node;
  if (ts.isBindingElement(parent)) return parent.propertyName === node;
  return false;
}

/**
 * The calls that hand a callback's return value back in their own: an array's
 * `map`, a string's `replace`, a promise's `then`. A callback passed anywhere
 * else, such as a request handler, returns into code this file never reads.
 */
const HANDS_BACK = /^(map|flatMap|reduce|reduceRight|replace|replaceAll|then)$/;

function handsBack(fn: ts.Node): boolean {
  const parent = fn.parent;
  if (!ts.isCallExpression(parent) || !parent.arguments.includes(fn as ts.Expression)) return false;
  const callee = calleeName(parent);
  return callee !== null && HANDS_BACK.test(callee);
}

/** Every write in `source` whose text is raw `JSON.stringify` output. */
export function rawWrites(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.ESNext, true);
  const stringifiedNames = new Set<string>();
  // A plain call `out()` reads the first set; a method call `o.out()` the second.
  const stringifyingFunctions = new Set<string>();
  const stringifyingMethods = new Set<string>();
  // A name bound to a writer or to what holds one: `console`, a stream.
  const aliases = new Map<string, string>();

  /** A callee's dotted path, with a local alias and `globalThis.` read through. */
  const resolve = (node: ts.Expression): string | null => {
    const dotted = writerPath(node);
    if (dotted === null) return null;
    const dot = dotted.indexOf('.');
    const head = dot < 0 ? dotted : dotted.slice(0, dot);
    const target = aliases.get(head);
    return target === undefined ? dotted : target + (dot < 0 ? '' : dotted.slice(dot));
  };

  /** Whether a path is a writer, or a thing that holds writers. */
  const isWriterPath = (dotted: string): boolean =>
    WRITERS.test(dotted) || /^(console|process|process\.(stdout|stderr))$/.test(dotted);

  // Whether `node` holds raw stringify output anywhere inside it. A callback
  // counts through what it returns when the call it is passed to hands that
  // back, and an escaper's argument comes back escaped.
  const holdsRaw = (node: ts.Node): boolean => {
    let found = false;
    const visit = (inner: ts.Node): void => {
      if (found) return;
      if (inner !== node && ts.isFunctionLike(inner)) {
        const body = (inner as ts.FunctionLikeDeclaration).body;
        if (body !== undefined && handsBack(inner) && returnsRaw(body)) found = true;
        return;
      }
      if (ts.isCallExpression(inner)) {
        const callee = calleeName(inner);
        if (callee !== null && ESCAPERS.has(callee)) return;
        const method = !ts.isIdentifier(inner.expression);
        if (isStringify(inner) || (callee !== null
          && (method ? stringifyingMethods : stringifyingFunctions).has(callee))) {
          found = true;
          return;
        }
      }
      // A reference passed without a call: `items.map(JSON.stringify)`.
      if ((ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner))
        && path(inner) !== null && bare(path(inner)!) === 'JSON.stringify') {
        found = true;
        return;
      }
      // Node formats `%j` with `JSON.stringify`.
      if (ts.isStringLiteralLike(inner) && inner.text.includes('%j')) {
        found = true;
        return;
      }
      if (ts.isIdentifier(inner) && !isPropertyName(inner) && stringifiedNames.has(inner.text)) {
        found = true;
        return;
      }
      ts.forEachChild(inner, visit);
    };
    visit(node);
    return found;
  };

  // Whether a function body returns raw stringify output on some path.
  const returnsRaw = (body: ts.Node): boolean => {
    if (!ts.isBlock(body)) return holdsRaw(body);
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (node !== body && ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node) && node.expression !== undefined
        && holdsRaw(node.expression)) found = true;
      ts.forEachChild(node, visit);
    };
    visit(body);
    return found;
  };

  /** The name a function is declared under, and whether it is a method. */
  const declared = (node: ts.Node): { name: string; method: boolean; body: ts.Node } | null => {
    const text = (n: ts.Node | undefined): string | null =>
      n !== undefined && (ts.isIdentifier(n) || ts.isStringLiteralLike(n)) ? n.text : null;
    if (ts.isFunctionDeclaration(node) && node.body !== undefined) {
      const name = text(node.name);
      return name === null ? null : { name, method: false, body: node.body };
    }
    if (ts.isMethodDeclaration(node) && node.body !== undefined) {
      const name = text(node.name);
      return name === null ? null : { name, method: true, body: node.body };
    }
    if ((ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)
      || ts.isPropertyDeclaration(node)) && node.initializer !== undefined
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      const name = text(node.name);
      return name === null ? null
        : { name, method: !ts.isVariableDeclaration(node), body: node.initializer.body };
    }
    return null;
  };

  const ASSIGNS = new Set([ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken]);

  // Names set from raw output, functions returning it, and names bound to a
  // writer. Read to a fixed point, because one can feed the next.
  const collect = (node: ts.Node): void => {
    const fn = declared(node);
    if (fn !== null) {
      if (returnsRaw(fn.body)) (fn.method ? stringifyingMethods : stringifyingFunctions).add(fn.name);
    } else if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      const init = node.initializer;
      if (ts.isIdentifier(node.name)) {
        if (holdsRaw(init)) stringifiedNames.add(node.name.text);
        const target = resolve(init);
        if (target !== null && isWriterPath(target)) aliases.set(node.name.text, target);
      } else if (ts.isObjectBindingPattern(node.name)) {
        // `const { error } = console` binds `error` to `console.error`.
        const from = resolve(init);
        for (const element of node.name.elements) {
          const key = element.propertyName ?? element.name;
          if (from === null || !ts.isIdentifier(key) || !ts.isIdentifier(element.name)) continue;
          const target = `${from}.${key.text}`;
          if (isWriterPath(target)) aliases.set(element.name.text, target);
        }
      }
    } else if (ts.isBinaryExpression(node) && ASSIGNS.has(node.operatorToken.kind)
      && ts.isIdentifier(node.left) && holdsRaw(node.right)) {
      stringifiedNames.add(node.left.text);
    }
    ts.forEachChild(node, collect);
  };
  const size = (): number => stringifiedNames.size + stringifyingFunctions.size
    + stringifyingMethods.size + aliases.size;
  let before = -1;
  while (before !== size()) {
    before = size();
    collect(source);
  }

  const isWriter = (call: ts.CallExpression): boolean => {
    const target = resolve(call.expression);
    if (target === null) return false;
    if (WRITERS.test(target)) return true;
    const last = target.slice(target.lastIndexOf('.') + 1);
    return target.includes('.') && LOGGER_NAMES.test(last);
  };

  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isWriter(node) && node.arguments.some(holdsRaw)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      found.push(`${name(fileName)}:${line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * The writer a callee names, with `.bind(...)` and `.call`/`.apply` read
 * through: `console.log.bind(console)` is still `console.log`.
 */
function writerPath(node: ts.Expression): string | null {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === 'bind') return writerPath(node.expression.expression);
  const dotted = path(node);
  if (dotted === null) return null;
  return bare(dotted).replace(/\.(call|apply)$/, '');
}

describe('every structured line a process writes', () => {
  const at = join(REPO_ROOT, 'src', 'x.ts');

  it('scanned the tree, and the detector finds each shape it reads', () => {
    expect(FILES.length).toBeGreaterThan(150);
    const shapes = [
      'console.error(JSON.stringify({ event: "x" }));',
      // A stream's write adds no newline, so this is how one is written.
      'process.stdout.write(JSON.stringify({ a: 1 }) + "\\n");',
      'process.stderr.write(`${JSON.stringify({ a: 1 })}\\n`);',
      'console.log((JSON.stringify({ a: 1 })));',
      'console.log(JSON.stringify({ a: 1 }) as string);',
      'console.log(pretty ? JSON.stringify(x, null, 2) : JSON.stringify(x));',
      'console.log("entry:", JSON.stringify({ a: 1 }));',
      'console["error"](JSON.stringify({ a: 1 }));',
      'globalThis.console.log(JSON.stringify({ a: 1 }));',
      'const line = JSON.stringify({ a: 1 });\nconsole.log(line);',
      'let line: string;\nline = JSON.stringify({ a: 1 });\nconsole.log(line);',
      'const line = JSON.stringify({ a: 1 }) + "\\n";\nprocess.stdout.write(line);',
      'function out(a: object): string { return JSON.stringify(a, null, 2); }\nconsole.log(out({}));',
      'const out = (a: object): string => JSON.stringify(a);\nconsole.warn(out({}));',
      'const o = { out(a: object) { return JSON.stringify(a); } };\nconsole.log(o.out({}));',
      'class C { line(a: object) { return JSON.stringify(a); } run() { console.log(this.line({})); } }',
      'const w = console.error;\nw(JSON.stringify({ a: 1 }));',
      'const w = console.log.bind(console);\nw(JSON.stringify({ a: 1 }));',
      'const { error } = console;\nerror(JSON.stringify({ a: 1 }));',
      'const { log: say } = console;\nsay(JSON.stringify({ a: 1 }));',
      'console.log(items.map((i) => JSON.stringify(i)).join("\\n"));',
      'this.log(JSON.stringify({ a: 1 }));',
      'options.logger(JSON.stringify({ a: 1 }));',
      // A line break inside the call, which a regex over the text would miss.
      'console.error(\n  JSON.stringify(\n    { a: 1 },\n  ),\n);',
      // `terminalText` doubles a backslash, so its JSON no longer parses back.
      'console.log(terminalText(JSON.stringify(x)));',
      'const lines = items.map((i) => JSON.stringify(i)).join("\\n");\nconsole.log(lines);',
      'function all(items: object[]) { return items.map((i) => JSON.stringify(i)); }\nconsole.log(all([]));',
      'const w = console.error;\nconst v = w;\nv(JSON.stringify({ a: 1 }));',
      'let line = "";\nline += JSON.stringify({ a: 1 });\nconsole.log(line);',
      'const out = process.stdout;\nout.write(JSON.stringify({ a: 1 }));',
      'const { stdout } = process;\nstdout.write(JSON.stringify({ a: 1 }));',
      'console.log(items.map(JSON.stringify).join("\\n"));',
      'console.log("%j", { a: 1 });',
    ];
    for (const shape of shapes) {
      expect(rawWrites(at, shape), shape).toHaveLength(1);
    }
    // And it stays quiet on the escaped forms, on prose and on a body.
    for (const quiet of [
      'console.error(logLine({ event: "x" }));',
      'console.log(reportJson({ a: 1 }));',
      'process.stdout.write(`${logLine({ a: 1 })}\\n`);',
      'console.log(`wrote ${n} runs`);',
      'console.log(terminalText(message));',
      // A property of the same name is not the variable.
      'const body = JSON.stringify({ a: 1 });\nconsole.log(`${response.body}`);',
      // A method call does not match a plain function of the same name.
      'function format(a: object) { return JSON.stringify(a); }\nconsole.log(date.format("x"));',
      'const body = JSON.stringify({ a: 1 });\nawait fetch(url, { body });',
      'response.write(JSON.stringify({ a: 1 }));',
      'response.end(JSON.stringify({ a: 1 }));',
      'const server = createServer((q, r) => r.end(JSON.stringify(x)));\nconsole.log(server.address());',
    ]) {
      expect(rawWrites(at, quiet), quiet).toEqual([]);
    }
  });

  it('goes through logLine, reportJson or terminalText, never raw JSON.stringify', () => {
    const offenders = FILES.flatMap((file) => rawWrites(file, readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
