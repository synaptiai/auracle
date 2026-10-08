// The architecture map's entity diagram draws the ledger the migrations build.
//
// The diagram is guidance a reader trusts, and a schema change can make it
// false. So the migrated database decides: every base table is an entity, a
// foreign key is a solid edge, and every other edge is a broken line, a join
// the application makes and the database does not enforce.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { dbUrl } from './config.js';

const MAP = fileURLToPath(new URL('../../docs/architecture-map.md', import.meta.url));
const pool = new Pool({ connectionString: dbUrl(), max: 1 });

afterAll(async () => {
  await pool.end();
});

interface Diagram {
  readonly entities: ReadonlySet<string>;
  /** Each edge as `PARENT>CHILD`, with whether its line is solid. */
  readonly edges: ReadonlyMap<string, boolean>;
  /** The pairs the drawing marks "one" at both ends. */
  readonly oneToOne: ReadonlySet<string>;
}

/** The one `erDiagram` block in the map, read line by line. */
function diagram(): Diagram {
  const text = readFileSync(MAP, 'utf8').replace(/\r\n/g, '\n');
  // Every mermaid fence, of either kind, then the ones whose body declares an
  // entity diagram on any line, so front matter or a comment cannot hide one.
  // A fence opens with three or more backticks or tildes, indented up to three
  // spaces, and closes on the same character at least as long. One pattern
  // per character, so a tilde never closes a backtick fence.
  const fences = [
    /^ {0,3}(`{3,})[ \t]*mermaid(?:[ \t][^\n]*)?\n([\s\S]*?)^ {0,3}\1`*[ \t]*$/gm,
    /^ {0,3}(~{3,})[ \t]*mermaid(?:[ \t][^\n]*)?\n([\s\S]*?)^ {0,3}\1~*[ \t]*$/gm,
  ].flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[2]!));
  const blocks = fences.filter((body) => body.split('\n').some((line) => line.trim() === 'erDiagram'));
  expect(blocks, 'the architecture map holds exactly one entity diagram').toHaveLength(1);
  const entities = new Set<string>();
  const edges = new Map<string, boolean>();
  const oneToOne = new Set<string>();
  let inEntity = false;
  for (const raw of blocks[0]!.split('\n')) {
    const line = raw.replace(/%%.*$/, '').trim();
    if (inEntity) {
      // An attribute line may hold `--` or `..` in its comment; it is no edge.
      if (line === '}') inEntity = false;
      else if (/\{$/.test(line)) throw new Error(`the entity diagram opens ${line} inside an entity that never closed`);
      continue;
    }
    if (line === '' || line === 'erDiagram') continue;
    const entity = /^([A-Za-z][A-Za-z0-9_]*) \{$/.exec(line);
    if (entity) {
      entities.add(entity[1]!);
      inEntity = true;
      continue;
    }
    // `A ||--o{ B : "label"` is solid; `A ||..o{ B : "label"` is broken. The
    // label is optional to the reader, so it is optional here. A left marker
    // that opens with `}` puts the child first, so the pair is read reversed.
    const edge = /^([A-Za-z][A-Za-z0-9_]*)\s+([|}][|o])(--|\.\.)([o|][|{])\s+([A-Za-z][A-Za-z0-9_]*)(?:\s*:.*)?$/.exec(line);
    if (!edge) {
      // Anything else, the word form of a relationship included, is a line
      // this test cannot read, and an unread line is an unchecked claim.
      throw new Error(`the entity diagram holds a line this test cannot read: ${line}`);
    }
    const childFirst = edge[2]!.startsWith('}');
    const pair = childFirst ? `${edge[5]}>${edge[1]}` : `${edge[1]}>${edge[5]}`;
    const reverse = pair.split('>').reverse().join('>');
    const both = !edge[2]!.includes('}') && !edge[4]!.includes('{');
    // A one-to-one pair may be written from either end, so its reverse is the
    // same pair. Two one-to-many edges that point at each other are not.
    if (edges.has(pair) || (both && oneToOne.has(reverse))) throw new Error(`the entity diagram draws ${pair} twice`);
    edges.set(pair, edge[3] === '--');
    if (both) oneToOne.add(pair);
  }
  expect(inEntity, 'the entity diagram leaves an entity open').toBe(false);
  return { entities, edges, oneToOne };
}

describe('the architecture map entity diagram', () => {
  it('draws every table the migrations create, and no other', async () => {
    const { rows } = await pool.query<{ name: string }>(
      `SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    expect(rows.length, 'the migrated ledger holds tables').toBeGreaterThan(0);
    const tables = new Set(rows.map((row) => row.name.toUpperCase()));
    expect([...diagram().entities].sort()).toEqual([...tables].sort());
  });

  it('draws each foreign key as a solid edge, and every other edge broken', async () => {
    const { rows } = await pool.query<{ child: string; parent: string; unique_child: boolean }>(
      `SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent,
              EXISTS (SELECT 1 FROM pg_index i
                       WHERE i.indrelid = c.conrelid AND i.indisunique AND i.indpred IS NULL
                         AND i.indkey::int2[] @> c.conkey AND c.conkey @> i.indkey::int2[]) AS unique_child
         FROM pg_constraint c WHERE c.contype = 'f'`,
    );
    const keys = new Set(rows.map((row) => `${row.parent.toUpperCase()}>${row.child.toUpperCase()}`));
    // A foreign key whose columns are unique on the child, by an index with no
    // WHERE clause, is one-to-one in the schema, so the diagram may draw it from either end. The schema decides
    // that, never the markers the drawing chose.
    const oneToOneKeys = new Set(rows.filter((row) => row.unique_child)
      .map((row) => `${row.parent.toUpperCase()}>${row.child.toUpperCase()}`));
    expect(keys.size, 'the migrated ledger declares foreign keys').toBeGreaterThan(0);
    const { entities, edges } = diagram();
    expect(edges.size, 'the diagram draws relationships').toBeGreaterThan(keys.size);
    for (const edge of edges.keys()) {
      for (const end of edge.split('>')) {
        expect(entities.has(end), `the edge ${edge} names ${end}, which the diagram declares`).toBe(true);
      }
    }
    const reversed = (pair: string): string => pair.split('>').reverse().join('>');
    const drawn = (key: string): boolean | undefined =>
      edges.get(key) ?? (oneToOneKeys.has(key) ? edges.get(reversed(key)) : undefined);
    for (const key of keys) {
      expect(drawn(key), `the diagram draws the foreign key ${key} as a solid edge`).toBe(true);
    }
    for (const [edge, solid] of edges) {
      const known = keys.has(edge) || oneToOneKeys.has(reversed(edge));
      if (solid) expect(known, `the solid edge ${edge} is a foreign key`).toBe(true);
    }
  });
});
