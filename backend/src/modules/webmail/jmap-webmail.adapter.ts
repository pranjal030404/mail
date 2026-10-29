import {
  WebmailError,
  type WebmailAddress,
  type WebmailAdapter,
  type WebmailAttachmentInput,
  type WebmailAttachmentSummary,
  type WebmailDraftInput,
  type WebmailFolder,
  type WebmailFolderRole,
  type WebmailListInput,
  type WebmailMailbox,
  type WebmailMessage,
  type WebmailMessageSummary,
} from './webmail.interface.js';

const MAIL_CAPABILITY = 'urn:ietf:params:jmap:mail';
const SUBMISSION_CAPABILITY = 'urn:ietf:params:jmap:submission';
const USING = ['urn:ietf:params:jmap:core', MAIL_CAPABILITY, SUBMISSION_CAPABILITY];

type JmapObject = Record<string, unknown>;
type MethodResponse = [string, JmapObject, string];

interface Session {
  apiUrl: string;
  uploadUrl: string;
  downloadUrl: string;
  accountId: string;
  capabilities: {
    maxSizeUpload?: number;
    maxSizeAttachmentsPerEmail?: number;
  };
}

export interface JmapWebmailOptions {
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

const addr = (a: unknown): WebmailAddress[] => {
  if (!Array.isArray(a)) return [];
  return a
    .map((x) => x as { name?: string | null; email?: string | null })
    .filter((x) => typeof x.email === 'string' && x.email.length > 0)
    .map((x) => ({ name: x.name ?? null, email: String(x.email).toLowerCase() }));
};

const firstEmail = (a: unknown): string | null => addr(a)[0]?.email ?? null;

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

export class JmapWebmailAdapter implements WebmailAdapter {
  readonly kind = 'jmap' as const;
  readonly description = 'Stalwart JMAP (mailbox-scoped API key)';
  private readonly fetchImpl: typeof fetch;
  private readonly sessions = new Map<string, { at: number; value: Session }>();
  private readonly mailboxes = new Map<string, { at: number; value: WebmailFolder[] }>();

  constructor(private readonly opts: JmapWebmailOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await this.tryFetch(new URL('/.well-known/jmap', this.baseUrl()));
      return res ? { ok: res.status < 500, detail: res.ok ? 'JMAP endpoint reachable' : `JMAP endpoint returned HTTP ${res.status}` } : { ok: false, detail: 'JMAP endpoint unreachable' };
    } catch {
      return { ok: false, detail: 'JMAP endpoint unreachable' };
    }
  }

  private baseUrl(): string {
    return this.opts.baseUrl.replace(/\/$/, '');
  }

  private async tryFetch(url: URL): Promise<Response | null> {
    try {
      return await this.fetchImpl(url.toString(), { signal: AbortSignal.timeout(this.opts.timeoutMs) });
    } catch {
      return null;
    }
  }

  private async session(box: WebmailMailbox): Promise<Session> {
    const cached = this.sessions.get(box.credential);
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached.value;
    const candidates = [new URL('/.well-known/jmap', this.baseUrl()), new URL(`${this.baseUrl()}/jmap/session`)];
    let lastStatus = 0;
    let session: Session | null = null;
    for (const url of candidates) {
      let res: Response;
      try {
        res = await this.fetchImpl(url.toString(), {
          headers: { authorization: `Bearer ${box.credential}`, accept: 'application/json' },
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });
      } catch (err) {
        if ((err as Error).name === 'TimeoutError') throw new WebmailError('unavailable', 'The mail server did not respond in time.');
        continue;
      }
      lastStatus = res.status;
      if (res.status === 401 || res.status === 403) throw new WebmailError('unauthorized', 'The mailbox credential was rejected by the mail server.');
      if (!res.ok) continue;
      let body: JmapObject;
      try {
        body = (await res.json()) as JmapObject;
      } catch {
        continue;
      }
      const apiUrl = typeof body.apiUrl === 'string' ? new URL(body.apiUrl, this.baseUrl()).toString() : new URL(`${this.baseUrl()}/jmap/`).toString();
      const primary = (body.primaryAccounts as Record<string, string> | undefined)?.[MAIL_CAPABILITY];
      const accounts = (body.accounts as Record<string, JmapObject> | undefined) ?? {};
      const accountId = primary ?? Object.keys(accounts)[0] ?? box.engineId;
      const caps = body.capabilities as Record<string, JmapObject> | undefined;
      const mailCaps = (accounts[accountId]?.accountCapabilities as Record<string, JmapObject> | undefined)?.[MAIL_CAPABILITY] ?? caps?.[MAIL_CAPABILITY] ?? {};
      session = {
        apiUrl,
        uploadUrl: typeof body.uploadUrl === 'string' ? body.uploadUrl : `${this.baseUrl()}/jmap/upload/{accountId}/`,
        downloadUrl: typeof body.downloadUrl === 'string' ? body.downloadUrl : `${this.baseUrl()}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
        accountId,
        capabilities: {
          maxSizeUpload: typeof mailCaps.maxSizeUpload === 'number' ? mailCaps.maxSizeUpload : undefined,
          maxSizeAttachmentsPerEmail: typeof mailCaps.maxSizeAttachmentsPerEmail === 'number' ? mailCaps.maxSizeAttachmentsPerEmail : undefined,
        },
      };
      break;
    }
    if (!session) {
      if (lastStatus === 404) {
        // Some deployments expose /jmap/ directly without a session resource. The mailbox's engine
        // account id is known from provisioning, so continue with the documented endpoint.
        session = {
          apiUrl: new URL(`${this.baseUrl()}/jmap/`).toString(),
          uploadUrl: `${this.baseUrl()}/jmap/upload/{accountId}/`,
          downloadUrl: `${this.baseUrl()}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
          accountId: box.engineId,
          capabilities: {},
        };
      } else {
        throw new WebmailError('unavailable', lastStatus ? `The mail server JMAP endpoint returned HTTP ${lastStatus}.` : 'The mail server JMAP endpoint is unreachable.');
      }
    }
    this.sessions.set(box.credential, { at: Date.now(), value: session });
    return session;
  }

  private async call(box: WebmailMailbox, calls: [string, JmapObject, string][]): Promise<MethodResponse[]> {
    const s = await this.session(box);
    let res: Response;
    try {
      res = await this.fetchImpl(s.apiUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${box.credential}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ using: USING, methodCalls: calls }),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      if ((err as Error).name === 'TimeoutError') throw new WebmailError('unavailable', 'The mail server did not respond in time.');
      throw new WebmailError('unavailable', 'The mail server is unreachable.');
    }
    if (res.status === 401 || res.status === 403) throw new WebmailError('unauthorized', 'The mailbox credential was rejected by the mail server.');
    if (res.status === 404) throw new WebmailError('not_found', 'The requested mailbox item was not found.');
    if (!res.ok) throw new WebmailError('unavailable', `The mail server returned HTTP ${res.status}.`);
    let body: { methodResponses?: MethodResponse[] };
    try {
      body = (await res.json()) as { methodResponses?: MethodResponse[] };
    } catch {
      throw new WebmailError('unavailable', 'The mail server returned an unreadable response.');
    }
    const responses = body.methodResponses ?? [];
    for (const [name, args] of responses) {
      if (name === 'error') {
        const type = asString(args.type);
        if (type === 'forbidden' || type === 'unauthorized') throw new WebmailError('unauthorized', 'The mailbox is not permitted to perform this action.');
        if (type === 'notFound') throw new WebmailError('not_found', 'The requested mailbox item was not found.');
        throw new WebmailError('invalid', `The mail server rejected the request (${type || 'unknown'}).`);
      }
    }
    return responses;
  }

  private async one(box: WebmailMailbox, method: string, args: JmapObject): Promise<JmapObject> {
    const [first] = await this.call(box, [[method, args, 'c0']]);
    if (!first) throw new WebmailError('unavailable', 'The mail server returned no response.');
    return first[1];
  }

  private checkSet(resp: JmapObject, key: string, op: 'created' | 'updated'): JmapObject {
    const failures = resp[op === 'created' ? 'notCreated' : 'notUpdated'] as Record<string, { type?: string; description?: string }> | undefined;
    const failure = failures?.[key];
    if (failure) {
      const type = failure.type ?? 'unknown';
      if (type === 'notFound') throw new WebmailError('not_found', 'The mailbox item no longer exists.');
      if (type === 'forbidden') throw new WebmailError('unauthorized', 'The mailbox is not permitted to perform this action.');
      if (type === 'tooLarge') throw new WebmailError('too_large', 'The message exceeds the mail server size limit.');
      throw new WebmailError('invalid', `The mail server rejected the change (${type}).`);
    }
    const ok = (resp[op] as Record<string, JmapObject | null> | undefined) ?? {};
    return ok[key] ?? {};
  }

  private folderRole(raw: unknown): WebmailFolderRole {
    const role = asString(raw).toLowerCase();
    return role === 'inbox' || role === 'sent' || role === 'drafts' || role === 'trash' || role === 'junk' || role === 'archive' ? role : 'other';
  }

  async listFolders(box: WebmailMailbox): Promise<WebmailFolder[]> {
    const cached = this.mailboxes.get(box.mailboxId);
    if (cached && Date.now() - cached.at < 60_000) return cached.value;
    const resp = await this.one(box, 'Mailbox/get', { accountId: (await this.session(box)).accountId, ids: null, properties: ['id', 'name', 'role', 'parentId', 'totalEmails', 'unreadEmails'] });
    const folders = ((resp.list as JmapObject[] | undefined) ?? []).map((m) => ({
      id: String(m.id),
      name: asString(m.name),
      role: this.folderRole(m.role),
      totalMessages: Number(m.totalEmails ?? 0),
      unreadMessages: Number(m.unreadEmails ?? 0),
      parentId: typeof m.parentId === 'string' ? m.parentId : null,
    }));
    this.mailboxes.set(box.mailboxId, { at: Date.now(), value: folders });
    return folders;
  }

  private async folderByRole(box: WebmailMailbox, role: WebmailFolderRole): Promise<string> {
    const folders = await this.listFolders(box);
    const found = folders.find((f) => f.role === role);
    if (!found) throw new WebmailError('invalid', `The mailbox has no ${role} folder.`);
    return found.id;
  }

  private summary(raw: JmapObject): WebmailMessageSummary {
    const keywords = (raw.keywords as Record<string, boolean> | undefined) ?? {};
    return {
      id: String(raw.id),
      threadId: typeof raw.threadId === 'string' ? raw.threadId : null,
      folderIds: Object.keys((raw.mailboxIds as Record<string, boolean> | undefined) ?? {}),
      from: addr(raw.from),
      to: addr(raw.to),
      subject: asString(raw.subject) || '(no subject)',
      preview: asString(raw.preview).slice(0, 240),
      receivedAt: asString(raw.receivedAt) || new Date(0).toISOString(),
      unread: !keywords['$seen'],
      flagged: Boolean(keywords['$flagged']),
      hasAttachment: Boolean(raw.hasAttachment),
      size: Number(raw.size ?? 0),
    };
  }

  async listMessages(box: WebmailMailbox, input: WebmailListInput): Promise<{ messages: WebmailMessageSummary[]; total: number }> {
    const session = await this.session(box);
    const folderId = input.folderId ?? (await this.folderByRole(box, 'inbox'));
    const filter: JmapObject = { inMailbox: folderId };
    if (input.q) filter.text = input.q;
    if (input.unreadOnly) filter.notKeyword = '$seen';
    const queryResp = await this.one(box, 'Email/query', {
      accountId: session.accountId,
      filter,
      sort: [{ property: 'receivedAt', isAscending: false }],
      position: (input.page - 1) * input.pageSize,
      limit: input.pageSize,
      calculateTotal: true,
    });
    const ids = ((queryResp.ids as string[] | undefined) ?? []).slice(0, input.pageSize);
    const total = Number(queryResp.total ?? ids.length);
    if (ids.length === 0) return { messages: [], total };
    const getResp = await this.one(box, 'Email/get', {
      accountId: session.accountId,
      ids,
      properties: ['id', 'threadId', 'mailboxIds', 'keywords', 'from', 'to', 'subject', 'preview', 'receivedAt', 'size', 'hasAttachment'],
    });
    const byId = new Map(((getResp.list as JmapObject[] | undefined) ?? []).map((m) => [String(m.id), m]));
    return { messages: ids.map((id) => byId.get(id)).filter((m): m is JmapObject => Boolean(m)).map((m) => this.summary(m)), total };
  }

  private bodyTexts(raw: JmapObject): { text: string; html: string | null } {
    const values = (raw.bodyValues as Record<string, { value?: string }> | undefined) ?? {};
    const partValues = (parts: unknown): string => {
      if (!Array.isArray(parts)) return '';
      return parts
        .map((p) => values[asString((p as JmapObject).partId)]?.value ?? '')
        .filter(Boolean)
        .join('\n')
        .trim();
    };
    const text = partValues(raw.textBody);
    const html = partValues(raw.htmlBody) || null;
    return { text, html };
  }

  async getMessage(box: WebmailMailbox, messageId: string, _opts: { blockRemoteImages: boolean }): Promise<WebmailMessage> {
    const session = await this.session(box);
    const resp = await this.one(box, 'Email/get', {
      accountId: session.accountId,
      ids: [messageId],
      properties: ['id', 'threadId', 'mailboxIds', 'keywords', 'from', 'to', 'cc', 'bcc', 'replyTo', 'subject', 'preview', 'receivedAt', 'sentAt', 'size', 'hasAttachment', 'textBody', 'htmlBody', 'bodyValues', 'attachments'],
      bodyProperties: ['partId', 'blobId', 'size', 'name', 'type', 'charset', 'disposition', 'cid'],
      fetchTextBodyValues: true,
      fetchHTMLBodyValues: true,
      maxBodyValueBytes: 400_000,
    });
    const raw = ((resp.list as JmapObject[] | undefined) ?? [])[0];
    if (!raw) throw new WebmailError('not_found', 'Message not found.');
    const { text, html } = this.bodyTexts(raw);
    const attachments: WebmailAttachmentSummary[] = ((raw.attachments as JmapObject[] | undefined) ?? []).map((a) => ({
      partId: asString(a.partId),
      blobId: typeof a.blobId === 'string' ? a.blobId : null,
      name: asString(a.name) || 'attachment',
      type: asString(a.type) || 'application/octet-stream',
      size: Number(a.size ?? 0),
    }));
    return {
      ...this.summary(raw),
      cc: addr(raw.cc),
      bcc: addr(raw.bcc),
      replyTo: addr(raw.replyTo),
      sentAt: typeof raw.sentAt === 'string' ? raw.sentAt : null,
      html,
      text,
      attachments,
      remoteImagesBlocked: 0,
    };
  }

  async setRead(box: WebmailMailbox, messageId: string, read: boolean): Promise<void> {
    const session = await this.session(box);
    const resp = await this.one(box, 'Email/set', {
      accountId: session.accountId,
      update: { [messageId]: { 'keywords/$seen': read ? true : null } },
    });
    this.checkSet(resp, messageId, 'updated');
  }

  async move(box: WebmailMailbox, messageId: string, folderId: string): Promise<void> {
    const session = await this.session(box);
    const resp = await this.one(box, 'Email/set', {
      accountId: session.accountId,
      update: { [messageId]: { mailboxIds: { [folderId]: true } } },
    });
    this.checkSet(resp, messageId, 'updated');
  }

  async remove(box: WebmailMailbox, messageId: string): Promise<void> {
    const session = await this.session(box);
    const resp = await this.one(box, 'Email/set', { accountId: session.accountId, destroy: [messageId] });
    const failed = resp.notDestroyed as Record<string, unknown> | undefined;
    if (failed?.[messageId]) throw new WebmailError('invalid', 'The mail server did not delete the message.');
  }

  private async upload(box: WebmailMailbox, session: Session, att: WebmailAttachmentInput): Promise<{ blobId: string; type: string; size: number }> {
    const data = Buffer.from(att.data, 'base64');
    if (data.length === 0) throw new WebmailError('invalid', `Attachment "${att.name}" is empty.`);
    const url = session.uploadUrl.replace('{accountId}', encodeURIComponent(session.accountId));
    let res: Response;
    try {
      res = await this.fetchImpl(new URL(url, this.baseUrl()).toString(), {
        method: 'POST',
        headers: { authorization: `Bearer ${box.credential}`, 'content-type': att.type || 'application/octet-stream' },
        body: new Uint8Array(data),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch {
      throw new WebmailError('unavailable', 'The mail server could not accept the attachment.');
    }
    if (res.status === 401 || res.status === 403) throw new WebmailError('unauthorized', 'The mailbox credential was rejected by the mail server.');
    if (!res.ok) throw new WebmailError('invalid', `The mail server rejected attachment "${att.name}".`);
    const body = (await res.json()) as { blobId?: string; type?: string; size?: number };
    if (!body.blobId) throw new WebmailError('unavailable', 'The mail server did not return an attachment identifier.');
    return { blobId: body.blobId, type: body.type ?? att.type, size: body.size ?? data.length };
  }

  private addressList(list: string[]): JmapObject[] {
    return list.map((email) => ({ email }));
  }

  private async emailObject(box: WebmailMailbox, session: Session, input: WebmailDraftInput, folderId: string): Promise<JmapObject> {
    const uploaded = [];
    for (const att of input.attachments) uploaded.push({ ...(await this.upload(box, session, att)), name: att.name });
    const bodyValues: JmapObject = { text: { value: input.text || '' } };
    const textPart = { partId: 'text', type: 'text/plain' };
    const subParts: JmapObject[] = [textPart];
    if (input.html) {
      bodyValues.html = { value: input.html };
      subParts.push({ partId: 'html', type: 'text/html' });
    }
    for (const [i, att] of uploaded.entries()) {
      subParts.push({ partId: `att${i}`, type: att.type, blobId: att.blobId, name: att.name, disposition: 'attachment' });
    }
    return {
      mailboxIds: { [folderId]: true },
      keywords: { $draft: true, $seen: true },
      from: [{ email: box.address }],
      to: this.addressList(input.to),
      cc: this.addressList(input.cc),
      bcc: this.addressList(input.bcc),
      subject: input.subject,
      bodyValues,
      textBody: [textPart],
      ...(input.html ? { htmlBody: [{ partId: 'html', type: 'text/html' }] } : {}),
      ...(uploaded.length ? { bodyStructure: { type: 'multipart/mixed', subParts } } : {}),
    };
  }

  private async identityId(box: WebmailMailbox, session: Session): Promise<string> {
    const resp = await this.one(box, 'Identity/get', { accountId: session.accountId, ids: null });
    const identities = (resp.list as JmapObject[] | undefined) ?? [];
    const match = identities.find((i) => asString(i.email).toLowerCase() === box.address.toLowerCase()) ?? identities[0];
    if (!match) throw new WebmailError('invalid', 'This mailbox has no sending identity configured on the mail server.');
    return String(match.id);
  }

  async saveDraft(box: WebmailMailbox, input: WebmailDraftInput, draftId?: string): Promise<{ id: string }> {
    const session = await this.session(box);
    const draftsId = await this.folderByRole(box, 'drafts');
    const obj = await this.emailObject(box, session, input, draftsId);
    if (draftId) {
      const resp = await this.one(box, 'Email/set', { accountId: session.accountId, update: { [draftId]: obj } });
      this.checkSet(resp, draftId, 'updated');
      return { id: draftId };
    }
    const resp = await this.one(box, 'Email/set', { accountId: session.accountId, create: { draft: obj } });
    const created = this.checkSet(resp, 'draft', 'created');
    if (!created.id) throw new WebmailError('unavailable', 'The mail server did not return the draft identifier.');
    return { id: String(created.id) };
  }

  async send(box: WebmailMailbox, input: WebmailDraftInput, draftId?: string): Promise<{ id: string }> {
    if (input.to.length === 0 && input.cc.length === 0 && input.bcc.length === 0) throw new WebmailError('invalid', 'Add at least one recipient.');
    const session = await this.session(box);
    const draftsId = await this.folderByRole(box, 'drafts');
    const sentId = await this.folderByRole(box, 'sent');
    const identityId = await this.identityId(box, session);
    const obj = await this.emailObject(box, session, input, draftsId);
    let emailId: string;
    if (draftId) {
      const up = await this.one(box, 'Email/set', { accountId: session.accountId, update: { [draftId]: obj } });
      this.checkSet(up, draftId, 'updated');
      emailId = draftId;
    } else {
      const created = await this.one(box, 'Email/set', { accountId: session.accountId, create: { draft: obj } });
      const ok = this.checkSet(created, 'draft', 'created');
      if (!ok.id) throw new WebmailError('unavailable', 'The mail server did not return the message identifier.');
      emailId = String(ok.id);
    }
    const rcptTo = [...input.to, ...input.cc, ...input.bcc].map((email) => ({ email }));
    try {
      const sub = await this.one(box, 'EmailSubmission/set', {
        accountId: session.accountId,
        create: { send: { emailId, identityId, envelope: { mailFrom: { email: box.address }, rcptTo } } },
      });
      this.checkSet(sub, 'send', 'created');
    } catch (err) {
      // The message remains a draft so the user can retry; nothing is lost.
      throw err instanceof WebmailError ? err : new WebmailError('unavailable', 'Sending failed; the message was kept as a draft.');
    }
    // Submission was accepted: this is the point of no return. Moving the copy to Sent is
    // best-effort — reporting a failure here would invite a duplicate send.
    try {
      const moved = await this.one(box, 'Email/set', {
        accountId: session.accountId,
        update: { [emailId]: { mailboxIds: { [sentId]: true }, 'keywords/$draft': null, 'keywords/$seen': true } },
      });
      this.checkSet(moved, emailId, 'updated');
    } catch {
      // Already submitted; a later reconciliation/Mailbox/get will show the copy in Sent.
    } finally {
      this.mailboxes.delete(box.mailboxId);
    }
    return { id: emailId };
  }

  async downloadAttachment(box: WebmailMailbox, blobId: string, name: string, type: string) {
    const session = await this.session(box);
    const url = session.downloadUrl
      .replace('{accountId}', encodeURIComponent(session.accountId))
      .replace('{blobId}', encodeURIComponent(blobId))
      .replace('{name}', encodeURIComponent(name))
      .replace('{type}', encodeURIComponent(type));
    let res: Response;
    try {
      res = await this.fetchImpl(new URL(url, this.baseUrl()).toString(), {
        headers: { authorization: `Bearer ${box.credential}` },
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch {
      throw new WebmailError('unavailable', 'The mail server could not provide the attachment.');
    }
    if (!res.ok) throw new WebmailError(res.status === 404 ? 'not_found' : 'unavailable', 'The attachment could not be downloaded.');
    const buf = Buffer.from(await res.arrayBuffer());
    return { data: buf, contentType: res.headers.get('content-type') ?? type, filename: name };
  }
}

/** The engine account's primary address, used for identity matching in diagnostics. */
export const jmapPrimaryAddress = firstEmail;
