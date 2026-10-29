import { MailServerError } from './mail-server.interface.js';

export const STALWART_USING = ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'];

export type MethodCall = [string, Record<string, unknown>, string];

export interface JmapClientOptions {
  baseUrl: string;
  /** Basic auth (management user). Omit when using a bearer token. */
  username?: string;
  secret: string;
  auth?: 'basic' | 'bearer';
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/**
 * Minimal JMAP (RFC 8620) client for the Stalwart v0.16 management API.
 * Network errors before a response are "unavailable"; timeouts after the request
 * was sent are "uncertain" because the server may have applied the change.
 */
export class JmapClient {
  private readonly endpoint: string;
  private readonly auth: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: JmapClientOptions) {
    this.endpoint = `${opts.baseUrl.replace(/\/$/, '')}/jmap/`;
    this.auth = opts.auth === 'bearer' ? `Bearer ${opts.secret}` : `Basic ${Buffer.from(`${opts.username ?? ''}:${opts.secret}`).toString('base64')}`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async call(calls: MethodCall[], mutating: boolean, extra: { accountId?: string; using?: string[] } = {}): Promise<MethodCall[]> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { authorization: this.auth, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ using: extra.using ?? STALWART_USING, methodCalls: calls, ...(extra.accountId ? { accountId: extra.accountId } : {}) }),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      const name = (err as Error)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new MailServerError(mutating ? 'uncertain' : 'unavailable', 'Mail server did not respond in time.');
      }
      throw new MailServerError('unavailable', 'Mail server is unreachable.');
    }
    if (res.status === 401 || res.status === 403) {
      throw new MailServerError('unauthorized', 'Mail server rejected the management credentials.');
    }
    if (res.status >= 500) {
      throw new MailServerError(mutating ? 'uncertain' : 'unavailable', `Mail server error (HTTP ${res.status}).`);
    }
    if (!res.ok) {
      throw new MailServerError('invalid', `Mail server rejected the request (HTTP ${res.status}).`);
    }
    let body: { methodResponses?: MethodCall[] };
    try {
      body = (await res.json()) as { methodResponses?: MethodCall[] };
    } catch {
      throw new MailServerError(mutating ? 'uncertain' : 'unavailable', 'Mail server returned an unreadable response.');
    }
    const responses = body.methodResponses ?? [];
    for (const [name, args] of responses) {
      if (name === 'error') {
        const type = String(args.type ?? 'unknown');
        throw new MailServerError(type === 'forbidden' ? 'unauthorized' : 'invalid', `Mail server method error: ${type}.`, type);
      }
    }
    return responses;
  }

  async one(method: string, args: Record<string, unknown>, mutating = false, extra: { accountId?: string; using?: string[] } = {}): Promise<Record<string, unknown>> {
    const [first] = await this.call([[method, args, 'c0']], mutating, extra);
    if (!first) throw new MailServerError('uncertain', 'Mail server returned no response.');
    return first[1];
  }
}

/** Interprets a JMAP /set response for a single object and throws a classified error on failure. */
export function setResult(resp: Record<string, unknown>, key: string, op: 'created' | 'updated' | 'destroyed'): Record<string, unknown> | null {
  const notKey = op === 'created' ? 'notCreated' : op === 'updated' ? 'notUpdated' : 'notDestroyed';
  const failures = resp[notKey] as Record<string, { type?: string; description?: string; properties?: string[] }> | undefined;
  const failure = failures?.[key];
  if (failure) {
    const type = failure.type ?? 'unknown';
    const props = failure.properties?.length ? ` (${failure.properties.join(', ')})` : '';
    if (type === 'notFound') throw new MailServerError('not_found', 'Object not found on the mail server.', type);
    if (type === 'primaryKeyViolation' || type === 'alreadyExists') throw new MailServerError('conflict', `Object already exists on the mail server${props}.`, type);
    if (type === 'objectIsLinked') throw new MailServerError('conflict', 'Object is still referenced by other mail-server objects.', type);
    throw new MailServerError('invalid', `Mail server rejected the change: ${type}${props}.`, type);
  }
  if (op === 'destroyed') {
    const destroyed = (resp.destroyed as string[] | undefined) ?? [];
    return destroyed.includes(key) ? {} : null;
  }
  const ok = (resp[op] as Record<string, Record<string, unknown> | null> | undefined) ?? {};
  if (!(key in ok)) throw new MailServerError('uncertain', 'Mail server did not confirm the change.');
  return ok[key] ?? {};
}
