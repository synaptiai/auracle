// The consumer's entry point runs the action check before it opens anything,
// with the payload and the adapter every run then uses.
//
// `refuseUnperformedAction` has its own cases, and they prove nothing if the
// daemon never calls it, calls it after the pool opens, or checks another
// payload or adapter than the one it runs with. So this reads the entry
// point with the TypeScript compiler. A pattern over the text would miss an
// aliased import, and would match a call inside a comment.
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ENTRY = new URL('./consumer-main.ts', import.meta.url);
const RELAY = new URL('../relay/main.ts', import.meta.url);

function mainBody(entry: URL = ENTRY): ts.Block {
  const source = ts.createSourceFile(
    'main.ts', readFileSync(entry, 'utf8'), ts.ScriptTarget.Latest, true,
  );
  let body: ts.Block | undefined;
  source.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'main' && node.body !== undefined) {
      body = node.body;
    }
  });
  if (body === undefined) throw new Error(`${entry.pathname} has no main function`);
  return body;
}

/** Every node in `main` that `match` accepts, in source order. */
function find<T extends ts.Node>(body: ts.Block, match: (node: ts.Node) => node is T): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node): void => {
    if (match(node)) found.push(node);
    node.forEachChild(visit);
  };
  visit(body);
  return found;
}

const callTo = (name: string) => (node: ts.Node): node is ts.CallExpression =>
  ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name;

const newPool = (node: ts.Node): node is ts.NewExpression =>
  ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Pool';

describe('the consumer entry point', () => {
  const body = mainBody();
  const [check] = find(body, callTo('refuseUnperformedAction'));
  const [known] = find(body, callTo('knownEntry'));

  it('refuses an unknown adapter name first, before it reads the profile', () => {
    expect(find(body, callTo('knownEntry'))).toHaveLength(1);
    expect(known!.arguments.map((argument) => argument.getText()))
      .toEqual(['EGRESS_ADAPTERS', 'egressName', "'EGRESS_ADAPTER'"]);
    const [read] = find(body, callTo('actionProfileFromEnv'));
    expect(known!.getStart()).toBeLessThan(read!.getStart());
  });

  it('calls refuseUnperformedAction once, before the adapter is built and the pool opens', () => {
    expect(find(body, callTo('refuseUnperformedAction'))).toHaveLength(1);
    // The factory the name selected is called once, after the check.
    const factory = find(body, (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) && node.initializer === known);
    expect(factory).toHaveLength(1);
    const builds = find(body, callTo(factory[0]!.name.getText()));
    expect(builds).toHaveLength(1);
    expect(check!.getStart()).toBeLessThan(builds[0]!.getStart());
    expect(check!.getStart()).toBeLessThan(Math.min(...find(body, newPool).map((n) => n.getStart())));
  });

  it('checks the profile it read, the adapter it builds, and the environment itself', () => {
    const [profile, adapter, env, ...rest] = check!.arguments;
    expect(rest).toHaveLength(0);
    expect(profile!.getText()).toBe('profile');
    // The same name selects the adapter, so the check reads that adapter.
    expect(adapter!.getText()).toBe(known!.arguments[1]!.getText());
    expect(env!.getText()).toBe('process.env');
    const [read] = find(body, callTo('actionProfileFromEnv'));
    expect(read!.getStart()).toBeLessThan(check!.getStart());
  });

  it('selects the adapter the profile check assumes when EGRESS_ADAPTER is unset', () => {
    const name = known!.arguments[1]!.getText();
    const declared = find(body, (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) && node.name.getText() === name);
    expect(declared).toHaveLength(1);
    expect(declared[0]!.initializer!.getText())
      .toBe("process.env['EGRESS_ADAPTER'] ?? DEFAULT_EGRESS_ADAPTER");
  });

  it('sends the payload the check reads', () => {
    const sent = find(body, (node): node is ts.PropertyAssignment =>
      ts.isPropertyAssignment(node) && node.name.getText() === 'actionPayload');
    expect(sent).toHaveLength(1);
    const value = sent[0]!.initializer;
    expect(ts.isObjectLiteralExpression(value)).toBe(true);
    const spreads = (value as ts.ObjectLiteralExpression).properties;
    expect(spreads).toHaveLength(1);
    expect(ts.isSpreadAssignment(spreads[0]!)).toBe(true);
    expect((spreads[0] as ts.SpreadAssignment).expression.getText()).toBe('CONSUMER_ACTION_PAYLOAD');
  });
});

// The relay selects its adapter through the same own-entry lookup, so
// `RELAY_ADAPTER=constructor` is an unknown name there too.
describe('the relay entry point', () => {
  it('selects its adapter with knownEntry, naming RELAY_ADAPTER', () => {
    const calls = find(mainBody(RELAY), callTo('knownEntry'));
    expect(calls).toHaveLength(1);
    const [registry, name, variable] = calls[0]!.arguments;
    expect(registry!.getText()).toBe('EGRESS_ADAPTERS');
    expect(name!.getText()).toBe("process.env['RELAY_ADAPTER'] ?? 'helpdesk'");
    expect(variable!.getText()).toBe("'RELAY_ADAPTER'");
  });
});
