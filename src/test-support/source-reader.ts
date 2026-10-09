// Source read as the compiler reads it, for the guards that check shipped code.
//
// A guard that strips comments and strings with patterns has to guess where
// a string ends. Each guess in this tree failed on an ordinary line: a `//`
// inside a URL, a `/*` inside a message, a quote inside a regular expression,
// an apostrophe inside a double-quoted string. The rest of that line then
// went unread, and a guard reported a clean tree because it stopped reading.
// The compiler does not guess: a comment is trivia between tokens, a string
// is a node, and neither can hide code or pose as it.
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import ts from 'typescript';

/**
 * One module, or a piece of source text, parsed.
 *
 * A module the parser cannot read is refused. The parser recovers from a
 * syntax error and hands back a tree, but that tree is a guess, and a guard
 * that reads a guess can pass on code it never saw.
 */
export function parseSource(file: string, text = readFileSync(file, 'utf8')): ts.SourceFile {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindOf(file));
  const errors = programOf(source).getSyntacticDiagnostics(source);
  if (errors.length > 0) {
    const first = errors[0]!;
    const at = first.start === undefined ? '' : `:${source.getLineAndCharacterOfPosition(first.start).line + 1}`;
    throw new Error(`${file}${at} does not parse: ${ts.flattenDiagnosticMessageText(first.messageText, ' ')}`);
  }
  return source;
}

/** The script kind the file name implies. JSX is read only in a `.tsx` or `.jsx` file. */
function scriptKindOf(file: string): ts.ScriptKind {
  if (/\.tsx$/.test(file)) return ts.ScriptKind.TSX;
  if (/\.jsx$/.test(file)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

const programs = new WeakMap<ts.SourceFile, ts.Program>();

/**
 * A program of one file, with no library and no import followed.
 *
 * It answers one question: which declaration a name refers to. Scope is the
 * compiler's to decide. A list of shadowing forms kept here missed a
 * destructured parameter, a loop variable and a catch clause, and each let a
 * call pass a statement the guard had never read.
 */
function programOf(source: ts.SourceFile): ts.Program {
  const cached = programs.get(source);
  if (cached !== undefined) return cached;
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === source.fileName ? source : undefined),
    getDefaultLibFileName: () => 'lib.d.ts',
    writeFile: () => undefined,
    getCurrentDirectory: () => '',
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (name) => name === source.fileName,
    readFile: () => undefined,
  };
  const program = ts.createProgram({
    rootNames: [source.fileName],
    options: { noLib: true, noResolve: true, allowJs: true, jsx: ts.JsxEmit.Preserve },
    host,
  });
  programs.set(source, program);
  return program;
}

/** The checker of a module read inside the whole project, by `projectSource`. */
const projectCheckers = new WeakMap<ts.SourceFile, ts.TypeChecker>();

/** The checker that resolves names in `source`: the project's, or a one-file program's. */
function checkerOf(source: ts.SourceFile): ts.TypeChecker {
  return projectCheckers.get(source) ?? programOf(source).getTypeChecker();
}

/** The declarations a name refers to, as the compiler resolves it in its own scope. */
export function declarationsOf(name: ts.Identifier): readonly ts.Declaration[] {
  return checkerOf(name.getSourceFile()).getSymbolAtLocation(name)?.declarations ?? [];
}

/**
 * The declarations a name refers to, with an import followed to what it
 * imports. Only a module `projectSource` read can follow one, because only
 * the whole project holds the other module; elsewhere an import stays an
 * import.
 */
export function importedDeclarationsOf(name: ts.Identifier): readonly ts.Declaration[] {
  const checker = checkerOf(name.getSourceFile());
  const symbol = checker.getSymbolAtLocation(name);
  if (symbol === undefined) return [];
  const target = (symbol.flags & ts.SymbolFlags.Alias) === 0 ? symbol : checker.getAliasedSymbol(symbol);
  return target.declarations ?? [];
}

/** The repository's root, where its tsconfig sits. */
const REPO_ROOT = new URL('../../', import.meta.url).pathname;

let projectOptions: ts.CompilerOptions | undefined;
let lastProject: ts.Program | undefined;

/**
 * Each file the project reads, parsed once. The library and the type
 * packages are the same on every call, and parsing them again for each
 * sample cost two seconds a sample.
 */
const parsedFiles = new Map<string, ts.SourceFile | undefined>();

/**
 * A module read inside a program of the whole project, with the
 * repository's own compiler options, so each import and each type resolves
 * as the build resolves it.
 *
 * A one-file program resolves a name, and nothing a name imports. So it
 * cannot say that `type Db = Pool` is a pool, or that a function imported
 * under the name `query` is not the read's own. This can. `text` stands in
 * for the file's contents, so a sample can sit at a path the project
 * resolves. Each call reuses the program before it, so the library and the
 * type packages are read once.
 */
export function projectSource(file: string, text?: string): ts.SourceFile {
  projectOptions ??= {
    ...ts.parseJsonConfigFileContent(
      ts.readConfigFile(join(REPO_ROOT, 'tsconfig.json'), ts.sys.readFile).config, ts.sys, REPO_ROOT,
    ).options,
    noEmit: true,
  };
  const host = ts.createCompilerHost(projectOptions, true);
  const parse = host.getSourceFile.bind(host);
  host.getSourceFile = (name, language, ...rest) => {
    if (name === file) return parse(name, language, ...rest);
    if (!parsedFiles.has(name)) parsedFiles.set(name, parse(name, language, ...rest));
    return parsedFiles.get(name);
  };
  if (text !== undefined) {
    const getSourceFile = host.getSourceFile.bind(host);
    const fileExists = host.fileExists.bind(host);
    const readFile = host.readFile.bind(host);
    host.getSourceFile = (name, language, ...rest) => (name === file
      ? ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
      : getSourceFile(name, language, ...rest));
    host.fileExists = (name) => name === file || fileExists(name);
    host.readFile = (name) => (name === file ? text : readFile(name));
  }
  const program = ts.createProgram({
    rootNames: [file], options: projectOptions, host, ...(lastProject === undefined ? {} : { oldProgram: lastProject }),
  });
  lastProject = program;
  const source = program.getSourceFile(file);
  if (source === undefined) throw new Error(`${file} is not part of the program`);
  const errors = program.getSyntacticDiagnostics(source);
  if (errors.length > 0) {
    throw new Error(`${file} does not parse: ${ts.flattenDiagnosticMessageText(errors[0]!.messageText, ' ')}`);
  }
  projectCheckers.set(source, program.getTypeChecker());
  return source;
}

/** Every node in `source`, depth first. */
export function nodesOf(source: ts.SourceFile): ts.Node[] {
  const all: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    all.push(node);
    node.forEachChild(visit);
  };
  visit(source);
  return all;
}

/**
 * The text of `source` with every comment the compiler finds removed, and
 * everything else kept as written: strings, templates and code.
 *
 * The comments are the trivia before and after each token, so a marker
 * inside a string or a template is never one. A comment inside a template's
 * `${…}` is code's trivia, and it goes. JSX text is text, so a line of it
 * that starts with `//` stays. The file name decides whether JSX is read,
 * so it is required: a default of `.ts` once read a JSX text line as a
 * comment and removed it.
 */
export function withoutComments(text: string, file: string): string {
  const source = parseSource(file, text);
  const ranges = new Map<number, number>();
  const jsxText: Array<[number, number]> = [];
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.JsxText) jsxText.push([node.getStart(source), node.getEnd()]);
    for (const range of ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []) ranges.set(range.pos, range.end);
    for (const range of ts.getTrailingCommentRanges(text, node.getEnd()) ?? []) ranges.set(range.pos, range.end);
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  for (const [pos] of ranges) {
    if (jsxText.some(([start, end]) => pos >= start && pos < end)) ranges.delete(pos);
  }
  let out = '';
  let at = 0;
  for (const [pos, end] of [...ranges].sort(([a], [b]) => a - b)) {
    if (pos < at) continue;
    out += text.slice(at, pos);
    at = end;
  }
  return out + text.slice(at);
}

/** Whether a literal is the path of a module, which is not a literal a guard reads. */
function isSpecifier(node: ts.Node): boolean {
  const parent = node.parent;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return parent.moduleSpecifier === node;
  if (ts.isExternalModuleReference(parent)) return true;
  if (ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent)) return true;
  return ts.isCallExpression(parent) && parent.arguments[0] === node
    && (parent.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(parent.expression) && parent.expression.text === 'require'));
}

/**
 * The text of every string and template literal in `source`, in order, as the
 * program sees it: an escape reads as the character it stands for. A template
 * with expressions reads as its text with `${…}` where each value is spliced
 * in. A module specifier is a path, and it is left out in every form.
 */
export function literalTexts(source: ts.SourceFile): string[] {
  return nodesOf(source).flatMap((node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return isSpecifier(node) ? [] : [node.text];
    }
    if (ts.isTemplateExpression(node)) {
      return [node.head.text + node.templateSpans.map((span) => '${…}' + span.literal.text).join('')];
    }
    return [];
  });
}

/** The text of a string or a template with no value spliced in, or null. */
export function literalText(node: ts.Node): string | null {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}

/**
 * The literal a name holds, or null.
 *
 * The compiler resolves the name, and exactly one declaration must answer:
 * a `const` in a variable statement whose initializer is a literal. Anything
 * else is null, so a guard refuses it. A `let` or a `var` can be reassigned
 * before the call, a loop variable or a catch clause holds a value the
 * source does not state, and an import names another module's value.
 */
export function constantText(node: ts.Node): string | null {
  if (!ts.isIdentifier(node)) return null;
  const declarations = declarationsOf(node);
  if (declarations.length !== 1) return null;
  const declaration = declarations[0]!;
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return null;
  if (!ts.isVariableDeclarationList(declaration.parent) || !ts.isVariableStatement(declaration.parent.parent)) {
    return null;
  }
  if ((declaration.parent.flags & ts.NodeFlags.Const) === 0) return null;
  return declaration.initializer === undefined ? null : literalText(declaration.initializer);
}

/**
 * The expression a call calls, or a use of a value stands in, once the
 * wrappers that change nothing are removed: parentheses, a non-null
 * assertion, a type assertion and `satisfies`.
 */
function outermost(node: ts.Node): ts.Node {
  let at = node;
  while (
    ts.isParenthesizedExpression(at.parent) || ts.isNonNullExpression(at.parent)
    || ts.isAsExpression(at.parent) || ts.isTypeAssertionExpression(at.parent) || ts.isSatisfiesExpression(at.parent)
  ) {
    at = at.parent;
  }
  return at;
}

/** The call `node` is the callee of, once wrappers are removed, or null. */
export function callOf(node: ts.Node): ts.CallExpression | null {
  const at = outermost(node);
  return ts.isCallExpression(at.parent) && at.parent.expression === at ? at.parent : null;
}

/** The text a key names: a literal, or the literal a constant holds. */
function keyText(node: ts.Node): string | null {
  return literalText(node) ?? constantText(node);
}

/**
 * Every place `source` reaches a member named `name`: a property access, an
 * element access whose key is a literal or a constant holding one, and a
 * destructure. Each one is either the callee of a call, or a use that hands
 * the member on.
 *
 * A key built at runtime, `pool['que' + 'ry']` or a parameter, names no
 * member the source states, and no static reader can say which it reaches.
 * A guard that must close that path holds the object itself instead, as
 * `boundedReads` holds a reader's pool.
 */
export function memberReaches(source: ts.SourceFile, name: string): Array<{ node: ts.Node; call: ts.CallExpression | null }> {
  const reaches: Array<{ node: ts.Node; call: ts.CallExpression | null }> = [];
  for (const node of nodesOf(source)) {
    if (ts.isPropertyAccessExpression(node) && node.name.text === name) {
      reaches.push({ node, call: callOf(node) });
    } else if (ts.isElementAccessExpression(node) && keyText(node.argumentExpression) === name) {
      reaches.push({ node, call: callOf(node) });
    } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const key = node.propertyName ?? node.name;
      if ((ts.isIdentifier(key) || ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key))
        && key.text === name) {
        reaches.push({ node, call: null });
      }
    } else if (ts.isCallExpression(node) && node.arguments.length >= 2
      && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'get'
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'Reflect'
      && keyText(node.arguments[1]!) === name) {
      reaches.push({ node, call: null });
    }
  }
  return reaches;
}

/** One place a module reaches a `query` method, and the statement it passes, when one literal holds it. */
export interface QueryStatement {
  /** The node that reaches the method. */
  readonly node: ts.Node;
  /** The call, or null when the method is handed on rather than called. */
  readonly call: ts.CallExpression | null;
  /** The first argument, as written, or what the use reads when nothing calls it. */
  readonly argument: string;
  /** The statement's text, or null when no single literal holds it. */
  readonly statement: string | null;
}

/** A literal that holds code reaching a `query` method. */
const QUERY_IN_TEXT = /\.\s*query\b|\[\s*['"`]query['"`]\s*\]/;

/**
 * Every place `source` reaches a `query` method, and the statement each call
 * passes.
 *
 * Three kinds reach it. A call through a member, `pool.query(…)` or
 * `pool['query'](…)`, whatever wraps the callee. A call through a bare name,
 * `query(…)`, which is how a read inside `boundedRead` issues its statements.
 * And a use that does not call it: `pool.query.bind(pool)`, a destructure,
 * `Reflect.get(pool, 'query')`, or code held in a string. A use hands the
 * method on, so no statement is read, and it is returned with a null call for
 * a guard to refuse.
 *
 * The statement is the first argument when it is a literal, or the literal a
 * constant it names holds. Anything else is null so a guard can refuse it.
 */
export function queryStatements(source: ts.SourceFile): QueryStatement[] {
  const found: QueryStatement[] = [];
  const read = (node: ts.Node, call: ts.CallExpression | null): void => {
    const argument = call?.arguments[0];
    found.push({
      node,
      call,
      argument: call === null ? node.getText(source) : argument === undefined ? '' : argument.getText(source),
      statement: argument === undefined ? null : literalText(argument) ?? constantText(argument),
    });
  };
  for (const { node, call } of memberReaches(source, 'query')) read(node, call);
  for (const node of nodesOf(source)) {
    if (ts.isIdentifier(node) && node.text === 'query' && !isDeclarationName(node) && !isMemberName(node)) {
      read(node, callOf(node));
    }
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node))
      && !isSpecifier(node) && QUERY_IN_TEXT.test(ts.isTemplateExpression(node) ? node.getText(source) : node.text)) {
      read(node, null);
    }
  }
  return found.sort((a, b) => a.node.getStart(source) - b.node.getStart(source));
}

/** Whether an identifier names what a declaration declares, rather than using a value. */
export function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (ts.isParameter(parent) || ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent)
    || ts.isBindingElement(parent) || ts.isImportSpecifier(parent) || ts.isImportClause(parent)
    || ts.isNamespaceImport(parent) || ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)
    || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent) || ts.isMethodSignature(parent))
    && (parent as ts.NamedDeclaration).name === node;
}

/** Whether an identifier is the name after a dot, or a key, which `memberReaches` reads. */
function isMemberName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (ts.isPropertyAccessExpression(parent) && parent.name === node)
    || (ts.isBindingElement(parent) && parent.propertyName === node)
    || (ts.isQualifiedName(parent) && parent.right === node);
}

/** One statement a read inside `boundedRead` sends, and the literal that holds it. */
export interface BoundedStatement {
  readonly call: ts.CallExpression;
  /** The first argument, as written. */
  readonly argument: string;
  /** The statement's text, or null when no single literal holds it. */
  readonly statement: string | null;
}

/**
 * Every statement a reader module sends, and every way the module could send
 * one that is not read.
 *
 * The rule starts from the read-only path, not from a name. Each call to the
 * shared `boundedRead` hands a callback one statement function. Whatever the
 * callback calls it, every use of it must call it, and each call's statement
 * is returned. A guard that found statements by the name `query` read nothing
 * in `(run) => run('…')`.
 *
 * Everything else that could reach the database is a fault:
 *
 *   - a `boundedRead` that is not the shared one, or a callback that takes
 *     its function in a form the reader cannot follow;
 *   - a value of a type `pg` declares, used for anything but `boundedRead`'s
 *     first argument. That is how `pool[key](…)`, `pool.connect()` and a
 *     pool handed to a helper each ran outside the read-only transaction.
 *     The pool is found by its type, so an alias, a destructure and a
 *     function that returns one are found too;
 *   - a module taken at runtime, through `import()`, `require`,
 *     `createRequire` or an import-equals `require`, which no import below
 *     names;
 *   - `arguments`, which reaches a parameter by position;
 *   - any reach of a `query` method, or code in a string that names one.
 *
 * It also returns each value the module imports, as `module:name`, for the
 * guard to hold to a list. A function imported from elsewhere could send a
 * statement on a pool of its own, and nothing here would read it.
 */
export function boundedReads(file: string, text?: string): {
  statements: BoundedStatement[];
  faults: string[];
  imports: string[];
  globals: string[];
} {
  const source = projectSource(file, text);
  const checker = checkerOf(source);
  const statements: BoundedStatement[] = [];
  const faults: string[] = [];
  const at = (node: ts.Node): string => `line ${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
  const sharedRead = join(REPO_ROOT, 'src/db/bounded-read.ts');
  // The module an import names, as the compiler resolves it.
  const moduleOf = (specifier: ts.Expression): string | undefined =>
    checker.getSymbolAtLocation(specifier)?.declarations?.[0]?.getSourceFile().fileName;
  const isShared = (callee: ts.Node): boolean => {
    if (!ts.isIdentifier(callee)) return false;
    const [declaration, ...others] = declarationsOf(callee);
    return others.length === 0 && declaration !== undefined && ts.isImportSpecifier(declaration)
      && (declaration.propertyName ?? declaration.name).text === 'boundedRead'
      && moduleOf(declaration.parent.parent.parent.moduleSpecifier) === sharedRead;
  };
  const readCalls = nodesOf(source).filter(ts.isCallExpression).filter((call) => isShared(call.expression));
  const imports: string[] = [];
  for (const node of nodesOf(source)) {
    if (ts.isIdentifier(node) && node.text === 'boundedRead' && !isDeclarationName(node)
      && !ts.isImportSpecifier(node.parent) && callOf(node) === null) {
      faults.push(`${at(node)}: boundedRead is handed on rather than called`);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'boundedRead'
      && !isShared(node.expression)) {
      faults.push(`${at(node)}: boundedRead is not the shared one from src/db/bounded-read.ts`);
    }
    if (ts.isIdentifier(node) && node.text === 'arguments') faults.push(`${at(node)}: arguments reaches a parameter by position`);
    // A module taken at runtime is one no import below names. So is one an
    // import-equals `require` takes, which compiles to `createRequire`.
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && ['require', 'createRequire'].includes(node.expression.text)))) {
      faults.push(`${at(node)}: takes a module at runtime: ${node.getText(source).slice(0, 60)}`);
    }
    if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
      faults.push(`${at(node)}: takes a module at runtime: ${node.getText(source).slice(0, 60)}`);
    }
    // Every value a module imports, by the module it resolves to, for the
    // guard to hold to the ones it allows.
    // An import that resolves to no module leaves every name it binds
    // without a type, and a pool with no type is a pool this rule cannot
    // find. So the rule fails closed on one.
    if ((ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined))
      && moduleOf(node.moduleSpecifier!) === undefined) {
      faults.push(`${at(node)}: an import resolves to no module: ${node.moduleSpecifier!.getText(source)}`);
    }
    // A module also loads through an import that binds nothing, `import
    // './x.js'` or `import {} from './x.js'`, and through a re-export. Each
    // runs the module, so each is recorded: by the names it binds, or as
    // `module:` when it binds none. Only an import or a re-export of types
    // alone is erased, and it records nothing.
    const typesOnly = ts.isImportDeclaration(node)
      ? node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
      : ts.isExportDeclaration(node) && node.isTypeOnly;
    if ((ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined))
      && !typesOnly) {
      const from = moduleOf(node.moduleSpecifier!);
      // A package by its name, a module of this repository by its path.
      const where = from === undefined || from.includes('/node_modules/')
        ? literalText(node.moduleSpecifier!) ?? '?'
        : relative(REPO_ROOT, from);
      const names: string[] = [];
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        if (clause?.name !== undefined) names.push('default');
        const bindings = clause?.namedBindings;
        if (bindings !== undefined && ts.isNamespaceImport(bindings)) names.push('*');
        if (bindings !== undefined && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            if (!element.isTypeOnly) names.push((element.propertyName ?? element.name).text);
          }
        }
      } else if (ts.isExportDeclaration(node)) {
        const clause = node.exportClause;
        if (clause === undefined || ts.isNamespaceExport(clause)) names.push('*');
        else for (const element of clause.elements) {
          if (!element.isTypeOnly) names.push((element.propertyName ?? element.name).text);
        }
      }
      imports.push(...(names.length === 0 ? [''] : names).map((name) => `${where}:${name}`));
    }
  }
  const readParameters = new Set<ts.Node>();
  for (const call of readCalls) {
    const read = call.arguments[4];
    const parameter = read !== undefined && (ts.isArrowFunction(read) || ts.isFunctionExpression(read))
      && read.parameters.length === 1 ? read.parameters[0]! : undefined;
    if (parameter === undefined || !ts.isIdentifier(parameter.name) || parameter.dotDotDotToken !== undefined
      || parameter.initializer !== undefined) {
      faults.push(`${at(call)}: the read does not take its statement function as one plain parameter`);
      continue;
    }
    readParameters.add(parameter);
    for (const use of nodesOf(source).filter(ts.isIdentifier)) {
      if (use === parameter.name || !declarationsOf(use).includes(parameter)) continue;
      const sent = callOf(use);
      if (sent === null) {
        faults.push(`${at(use)}: the statement function is handed on rather than called`);
        continue;
      }
      const argument = sent.arguments[0];
      statements.push({
        call: sent,
        argument: argument === undefined ? '' : argument.getText(source),
        statement: argument === undefined ? null : literalText(argument) ?? constantText(argument),
      });
    }
  }
  for (const reach of queryStatements(source)) {
    // A bare call is the read's statement function only when the compiler
    // resolves it to that function. An imported `query` is not.
    const callee = reach.call?.expression;
    if (callee !== undefined && ts.isIdentifier(callee)
      && declarationsOf(callee).some((declaration) => readParameters.has(declaration))) continue;
    faults.push(`${at(reach.node)}: reaches a query method outside a read: ${reach.argument.slice(0, 60)}`);
  }
  // The pool, found by its type rather than its spelling: through an alias,
  // a destructure, a context or a function that returns one. Each value of a
  // type that `pg` declares may be the first argument of the shared read, and
  // nothing else.
  //
  // A value holds a connection when it has a `query` or a `connect` that
  // `pg` declares. That reads the members, not the type's name, so an
  // intersection, a `Pick<Pool, 'query'>` and a type parameter bounded by
  // `Pool` each count, and a statement's rows, which `pg` also types, do not.
  const declaredByPg = (symbol: ts.Symbol | undefined): boolean => (symbol?.declarations ?? []).some((declaration) =>
    /\/node_modules\/(?:@types\/)?pg\//.test(declaration.getSourceFile().fileName));
  const fromPg = (type: ts.Type, seen = new Set<ts.Type>()): boolean => {
    if (seen.has(type)) return false;
    seen.add(type);
    if (type.isUnionOrIntersection()) return type.types.some((part) => fromPg(part, seen));
    const constraint = checker.getBaseConstraintOfType(type);
    if (constraint !== undefined && constraint !== type && fromPg(constraint, seen)) return true;
    const apparent = checker.getApparentType(type);
    return declaredByPg(apparent.getProperty('query')) || declaredByPg(apparent.getProperty('connect'));
  };
  const wraps = (node: ts.Node): boolean => ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
    || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node);
  // A value built on a pool, `pool[key]` or `pool.query(…)`, is reported at
  // the pool it is built on, once.
  const derivedFromPool = (node: ts.Node): boolean => {
    let base: ts.Node | undefined = node;
    for (;;) {
      if (ts.isPropertyAccessExpression(base) || ts.isElementAccessExpression(base)) base = base.expression;
      else if (ts.isCallExpression(base)) base = base.expression;
      else if (ts.isAwaitExpression(base) || wraps(base)) base = (base as ts.AwaitExpression).expression;
      else return false;
      if (fromPg(checker.getTypeAtLocation(base))) return true;
    }
  };
  for (const node of nodesOf(source)) {
    const value = ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)
      || ts.isCallExpression(node) || ts.isAwaitExpression(node) || wraps(node);
    if (!value) continue;
    // A cast changes the type and not the value, so a pool is checked where
    // it stands, inside any wrapper, and a wrapper around one is not
    // checked again.
    if (wraps(node) && fromPg(checker.getTypeAtLocation((node as ts.AsExpression).expression))) continue;
    if (ts.isIdentifier(node) && (isDeclarationName(node) || isInType(node) || ts.isImportSpecifier(node.parent)
      || (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node))) continue;
    if (!fromPg(checker.getTypeAtLocation(node)) || derivedFromPool(node)) continue;
    let outer: ts.Node = node;
    while (wraps(outer.parent)) outer = outer.parent;
    const first = ts.isCallExpression(outer.parent) && outer.parent.arguments[0] === outer && readCalls.includes(outer.parent);
    if (!first) faults.push(`${at(node)}: the pool is used outside boundedRead: ${outer.parent.getText(source).slice(0, 60)}`);
  }
  // Every global the module reads, for the guard to hold to a list. A
  // reader that reached `eval`, `Function` or `process` could load a module
  // that no import names, and build a pool from it. A global is a name the
  // compiler resolves to the standard library or to Node's types, or to no
  // declaration at all.
  const globals = new Set<string>();
  const library = (declaration: ts.Declaration): boolean =>
    /\/node_modules\/(?:typescript\/lib|@types\/node)\//.test(declaration.getSourceFile().fileName);
  for (const node of nodesOf(source)) {
    if (!ts.isIdentifier(node) || isDeclarationName(node) || isInType(node) || isMemberName(node)
      || ts.isImportSpecifier(node.parent) || ts.isImportClause(node.parent) || ts.isNamespaceImport(node.parent)) continue;
    if (ts.isPropertyAssignment(node.parent) && node.parent.name === node) continue;
    // A label and `import.meta` name no value.
    if (ts.isLabeledStatement(node.parent) || ts.isBreakOrContinueStatement(node.parent)
      || ts.isMetaProperty(node.parent)) continue;
    // A shorthand `{ process }` holds the value its name resolves to. The
    // compiler answers the name with the object's own property, which is
    // declared in the module, so the value's symbol is asked for instead.
    // Only the name: a default, `{ y = eval }`, is a value of its own.
    const symbol = ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : checker.getSymbolAtLocation(node);
    const declarations = symbol?.declarations ?? [];
    if (declarations.length === 0 || declarations.every(library)) globals.add(node.text);
  }
  return { statements, faults, imports, globals: [...globals].sort() };
}

/** Whether a node sits in a type, where a name is not a value. */
function isInType(node: ts.Node): boolean {
  for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
    if (ts.isTypeNode(at) || ts.isTypeAliasDeclaration(at) || ts.isInterfaceDeclaration(at)
      || ts.isTypeParameterDeclaration(at)) return true;
    if (ts.isStatement(at) || ts.isExpressionStatement(at)) return false;
  }
  return false;
}

