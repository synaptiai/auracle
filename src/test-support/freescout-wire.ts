/**
 * A server that speaks FreeScout's documented HTTP API, for the adapter
 * suites (DEC-18: synthetic throughout).
 *
 * It is not FreeScout. It is the wire contract FreeScout's API documentation
 * states: the `X-FreeScout-API-Key` header, `201` with a `Resource-ID` header
 * on thread create, `embed=threads` on conversation read, and `404` for a
 * conversation that is gone. Requests reach it over a real TCP connection, so
 * a header the adapter failed to send is a header this server does not see.
 *
 * What it cannot prove is that FreeScout answers this way. A stock FreeScout
 * install answers 404 to every `/api/` route until a person installs the API
 * module, so no automated suite here can make that claim.
 * `docs/operations.md` says how to check it by hand.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** The key the fake instance accepts. Synthetic (DEC-18). */
export const FREESCOUT_TEST_API_KEY = 'not-a-real-key-synthetic';

/** The FreeScout user id the fake instance attributes threads to. */
export const FREESCOUT_TEST_USER_ID = 7;

/** One thread as the fake instance holds it. */
export interface StoredThread {
  id: number;
  state: string;
  type: string;
  body: string;
}

/** Every request the adapter made, in order, as it arrived on the wire. */
export interface SeenRequest {
  method: string;
  url: string;
  apiKey: string | undefined;
  contentType: string | undefined;
  accept: string | undefined;
  body: unknown;
}

export class FakeFreeScout {
  readonly seen: SeenRequest[] = [];

  readonly conversations = new Map<string, StoredThread[]>();

  /** Customer address per conversation, as FreeScout reports it (DEC-18). */
  readonly customers = new Map<string, string>();

  /** Set to a status to make the next thread create answer with it. */
  createStatus: number | null = null;

  /** Set to a status to make every conversation read answer with it. */
  readStatus: number | null = null;

  /** The body a refused conversation read carries. */
  readBody = 'refused';

  /** Set true to answer a thread create with 201 and no Resource-ID header. */
  omitResourceId = false;

  private nextThreadId = 100;

  private server: Server | undefined;

  private port = 0;

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    this.port = (this.server?.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this.server === undefined) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** The threads of one conversation, or an empty list when it is gone. */
  threadsOf(conversationId: string): readonly StoredThread[] {
    return this.conversations.get(conversationId) ?? [];
  }

  /** Stands in for a person editing the parked draft in the FreeScout UI. */
  editThread(conversationId: string, threadId: string, body: string): void {
    const thread = this.threadsOf(conversationId).find(
      (candidate) => String(candidate.id) === threadId,
    );
    if (thread === undefined) throw new Error(`fake freescout holds no thread '${threadId}'`);
    thread.body = body;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = request.url ?? '';
    this.seen.push({
      method: request.method ?? '',
      url,
      apiKey: header(request, 'x-freescout-api-key'),
      contentType: header(request, 'content-type'),
      accept: header(request, 'accept'),
      body: raw.length === 0 ? undefined : JSON.parse(raw),
    });

    if (header(request, 'x-freescout-api-key') !== FREESCOUT_TEST_API_KEY) {
      json(response, 401, { message: 'API Key is either not provided or not valid' });
      return;
    }

    const create = /^\/api\/conversations\/([^/?]+)\/threads$/.exec(url);
    if (request.method === 'POST' && create !== null) {
      this.createThread(response, decodeURIComponent(create[1] as string), raw);
      return;
    }

    const read = /^\/api\/conversations\/([^/?]+)\?embed=threads$/.exec(url);
    if (request.method === 'GET' && read !== null) {
      this.readConversation(response, decodeURIComponent(read[1] as string));
      return;
    }

    json(response, 404, { message: 'Not found' });
  }

  private createThread(response: ServerResponse, id: string, raw: string): void {
    if (this.createStatus !== null) {
      const status = this.createStatus;
      this.createStatus = null;
      json(response, status, { message: 'refused' });
      return;
    }
    const threads = this.conversations.get(id);
    if (threads === undefined) {
      json(response, 404, { message: 'Not found' });
      return;
    }

    const payload = JSON.parse(raw) as { text: string; state?: string; type: string };
    this.nextThreadId += 1;
    threads.push({
      id: this.nextThreadId,
      state: payload.state ?? 'published',
      type: payload.type,
      body: payload.text,
    });
    response.statusCode = 201;
    if (!this.omitResourceId) response.setHeader('Resource-ID', String(this.nextThreadId));
    response.end();
  }

  private readConversation(response: ServerResponse, id: string): void {
    if (this.readStatus !== null) {
      response.statusCode = this.readStatus;
      response.end(this.readBody);
      return;
    }
    const threads = this.conversations.get(id);
    if (threads === undefined) {
      json(response, 404, { message: 'Not found' });
      return;
    }
    const email = this.customers.get(id);
    json(response, 200, {
      id,
      ...(email === undefined ? {} : { customer: { id: 91, type: 'customer', email } }),
      _embedded: { threads },
    });
  }
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(body));
}
