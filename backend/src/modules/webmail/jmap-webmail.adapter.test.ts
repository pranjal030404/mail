import { describe, expect, it } from 'vitest';
import { JmapWebmailAdapter } from './jmap-webmail.adapter.js';
import type { WebmailDraftInput, WebmailMailbox } from './webmail.interface.js';

const box: WebmailMailbox = { mailboxId: 'mbx-1', address: 'alice@example.test', engineId: 'acc-1', credential: 'API_test_secret' };

interface Call {
  method: string;
  args: Record<string, unknown>;
}

const session = {
  apiUrl: 'https://mail.test/jmap/',
  uploadUrl: 'https://mail.test/jmap/upload/{accountId}/',
  downloadUrl: 'https://mail.test/jmap/download/{accountId}/{blobId}/{name}?accept={type}',
  primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acc-1' },
  accounts: { 'acc-1': { accountCapabilities: {} } },
  capabilities: {},
};

function fakeJmap(respond: (method: string, args: Record<string, unknown>) => unknown) {
  const calls: Call[] = [];
  const fetches: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    fetches.push({ url, ...(init ? { init } : {}) });
    if (url.endsWith('/.well-known/jmap')) return new Response(JSON.stringify(session), { status: 200, headers: { 'content-type': 'application/json' } });
    if (init?.method === 'POST' && url === session.apiUrl) {
      const body = JSON.parse(String(init.body)) as { methodCalls: [string, Record<string, unknown>, string][] };
      const [m, args] = body.methodCalls[0]!;
      calls.push({ method: m, args });
      return new Response(
        JSON.stringify({ methodResponses: [[m.replace('/query', '/query').replace('/get', '/get').replace('/set', '/set'), respond(m, args), 'c0']] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (init?.method === 'POST' && url.startsWith('https://mail.test/jmap/upload/')) {
      return new Response(JSON.stringify({ accountId: 'acc-1', blobId: 'blob-up-1', type: init.headers && 'content-type' in (init.headers as object) ? 'text/plain' : 'text/plain', size: 5 }), { status: 201 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls, fetches };
}

const draft: WebmailDraftInput = { to: ['bob@example.test'], cc: [], bcc: [], subject: 'Hi', text: 'Hello', html: null, attachments: [] };

describe('JMAP webmail adapter', () => {
  it('discovers the session with the mailbox key and lists folders', async () => {
    const fake = fakeJmap(() => ({
      list: [
        { id: 'mbx-inbox', name: 'Inbox', role: 'inbox', totalEmails: 3, unreadEmails: 1 },
        { id: 'mbx-sent', name: 'Sent', role: 'sent', totalEmails: 2, unreadEmails: 0 },
        { id: 'mbx-x', name: 'Projects', role: null, totalEmails: 0, unreadEmails: 0 },
      ],
    }));
    const adapter = new JmapWebmailAdapter({ baseUrl: 'https://mail.test', timeoutMs: 1000, fetchImpl: fake.fetchImpl });
    const folders = await adapter.listFolders(box);
    expect(folders.map((f) => f.role)).toEqual(['inbox', 'sent', 'other']);
    expect(folders[0]).toMatchObject({ id: 'mbx-inbox', totalMessages: 3, unreadMessages: 1 });
    const sessionRequest = fake.fetches.find((f) => f.url.endsWith('/.well-known/jmap'))!;
    expect((sessionRequest.init!.headers as Record<string, string>).authorization).toBe('Bearer API_test_secret');
  });

  it('queries the selected folder and maps summaries including unread state', async () => {
    const fake = fakeJmap((method) => {
      if (method === 'Mailbox/get') return { list: [{ id: 'mbx-inbox', name: 'Inbox', role: 'inbox', totalEmails: 1, unreadEmails: 1 }] };
      if (method === 'Email/query') return { ids: ['e1'], total: 1, position: 0 };
      if (method === 'Email/get') {
        return {
          list: [
            {
              id: 'e1',
              threadId: 't1',
              mailboxIds: { 'mbx-inbox': true },
              keywords: {},
              from: [{ name: 'Bob', email: 'BOB@example.test' }],
              to: [{ name: null, email: 'alice@example.test' }],
              subject: 'Hello',
              preview: 'Preview',
              receivedAt: '2026-10-29T10:00:00Z',
              size: 12,
              hasAttachment: false,
            },
          ],
        };
      }
      return {};
    });
    const adapter = new JmapWebmailAdapter({ baseUrl: 'https://mail.test', timeoutMs: 1000, fetchImpl: fake.fetchImpl });
    const result = await adapter.listMessages(box, { q: 'hello', unreadOnly: true, page: 2, pageSize: 10 });
    expect(result.total).toBe(1);
    expect(result.messages[0]).toMatchObject({ unread: true, subject: 'Hello' });
    expect(result.messages[0]!.from[0]!.email).toBe('bob@example.test');
    const query = fake.calls.find((c) => c.method === 'Email/query')!;
    expect(query.args.filter).toMatchObject({ inMailbox: 'mbx-inbox', text: 'hello', notKeyword: '$seen' });
    expect(query.args.position).toBe(10);
    expect(query.args.accountId).toBe('acc-1');
  });

  it('returns raw bodies and attachments for the service to sanitise', async () => {
    const fake = fakeJmap((method) => {
      if (method === 'Email/get') {
        return {
          list: [
            {
              id: 'e1',
              threadId: 't1',
              mailboxIds: { 'mbx-inbox': true },
              keywords: { $seen: true, $flagged: true },
              from: [{ name: 'Bob', email: 'bob@example.test' }],
              to: [{ email: 'alice@example.test' }],
              cc: [],
              bcc: [],
              replyTo: [],
              subject: 'Report',
              receivedAt: '2026-10-29T10:00:00Z',
              sentAt: '2026-10-29T09:59:00Z',
              size: 200,
              hasAttachment: true,
              textBody: [{ partId: '1' }],
              htmlBody: [{ partId: '2' }],
              bodyValues: { '1': { value: 'plain' }, '2': { value: '<p onclick="x()">html</p><script>bad()</script>' } },
              attachments: [{ partId: '3', blobId: 'blob-3', name: 'a.pdf', type: 'application/pdf', size: 99 }],
            },
          ],
        };
      }
      return {};
    });
    const adapter = new JmapWebmailAdapter({ baseUrl: 'https://mail.test', timeoutMs: 1000, fetchImpl: fake.fetchImpl });
    const msg = await adapter.getMessage(box, 'e1', { blockRemoteImages: true });
    expect(msg.html).toContain('onclick');
    expect(msg.text).toBe('plain');
    expect(msg.flagged).toBe(true);
    expect(msg.attachments[0]).toMatchObject({ blobId: 'blob-3', name: 'a.pdf' });
    const get = fake.calls.find((c) => c.method === 'Email/get')!;
    expect(get.args.fetchHTMLBodyValues).toBe(true);
  });

  it('creates a draft, submits it, then moves the copy to Sent', async () => {
    const fake = fakeJmap((method, args) => {
      if (method === 'Mailbox/get') {
        return {
          list: [
            { id: 'mbx-inbox', name: 'Inbox', role: 'inbox' },
            { id: 'mbx-drafts', name: 'Drafts', role: 'drafts' },
            { id: 'mbx-sent', name: 'Sent', role: 'sent' },
          ],
        };
      }
      if (method === 'Identity/get') return { list: [{ id: 'id-1', email: 'alice@example.test' }] };
      if (method === 'Email/set') {
        if (args.create) return { created: { draft: { id: 'e-new' } } };
        return { updated: { 'e-new': null } };
      }
      if (method === 'EmailSubmission/set') {
        if (args.create) return { created: { send: { id: 'sub-1' } } };
        return {};
      }
      return {};
    });
    const adapter = new JmapWebmailAdapter({ baseUrl: 'https://mail.test', timeoutMs: 1000, fetchImpl: fake.fetchImpl });
    const sent = await adapter.send(box, draft);
    expect(sent.id).toBe('e-new');
    const methods = fake.calls.map((c) => c.method);
    expect(methods).toContain('EmailSubmission/set');
    const update = fake.calls.filter((c) => c.method === 'Email/set').at(-1)!;
    expect(update.args.update).toMatchObject({ 'e-new': { mailboxIds: { 'mbx-sent': true }, 'keywords/$draft': null } });
    const submission = fake.calls.find((c) => c.method === 'EmailSubmission/set')!;
    expect(submission.args.create).toMatchObject({ send: { emailId: 'e-new', identityId: 'id-1' } });
  });

  it('keeps the draft when submission fails and reports a safe error', async () => {
    const fake = fakeJmap((method, args) => {
      if (method === 'Mailbox/get') return { list: [{ id: 'mbx-drafts', name: 'Drafts', role: 'drafts' }, { id: 'mbx-sent', name: 'Sent', role: 'sent' }] };
      if (method === 'Identity/get') return { list: [{ id: 'id-1', email: 'alice@example.test' }] };
      if (method === 'Email/set') return args.create ? { created: { draft: { id: 'e-new' } } } : {};
      if (method === 'EmailSubmission/set') return { notCreated: { send: { type: 'invalidRecipients', description: 'rejected' } } };
      return {};
    });
    const adapter = new JmapWebmailAdapter({ baseUrl: 'https://mail.test', timeoutMs: 1000, fetchImpl: fake.fetchImpl });
    await expect(adapter.send(box, { ...draft, to: ['nobody@invalid.test'] })).rejects.toMatchObject({ kind: 'invalid' });
    const moves = fake.calls.filter((c) => c.method === 'Email/set' && c.args.update);
    expect(moves).toHaveLength(0);
  });

  it('reports a rejected mailbox key as unauthorized', async () => {
    const fetchImpl = (async () => new Response('{}', { status: 401 })) as typeof fetch;
    const adapter = new JmapWebmailAdapter({ baseUrl: 'https://mail.test', timeoutMs: 1000, fetchImpl });
    await expect(adapter.listFolders(box)).rejects.toMatchObject({ kind: 'unauthorized' });
  });

  it('uploads attachments and includes them in the multipart body', async () => {
    const fake = fakeJmap((method, args) => {
      if (method === 'Mailbox/get') return { list: [{ id: 'mbx-drafts', name: 'Drafts', role: 'drafts' }] };
      if (method === 'Email/set') return args.create ? { created: { draft: { id: 'e-att' } } } : {};
      return {};
    });
    const adapter = new JmapWebmailAdapter({ baseUrl: 'https://mail.test', timeoutMs: 1000, fetchImpl: fake.fetchImpl });
    const saved = await adapter.saveDraft(box, { ...draft, attachments: [{ name: 'notes.txt', type: 'text/plain', data: Buffer.from('hello').toString('base64') }] });
    expect(saved.id).toBe('e-att');
    const set = fake.calls.find((c) => c.method === 'Email/set')!;
    const created = (set.args.create as Record<string, Record<string, unknown>>).draft!;
    expect(created.bodyStructure).toMatchObject({ type: 'multipart/mixed' });
    expect(JSON.stringify(created.bodyStructure)).toContain('blob-up-1');
  });
});
