import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  WebmailError,
  type WebmailAdapter,
  type WebmailAddress,
  type WebmailAttachmentInput,
  type WebmailDraftInput,
  type WebmailFolder,
  type WebmailFolderRole,
  type WebmailListInput,
  type WebmailMailbox,
  type WebmailMessage,
  type WebmailMessageSummary,
} from './webmail.interface.js';

/**
 * DEVELOPMENT-ONLY simulated webmail store.
 *
 * It exists so the webmail UI can be developed and tested without a mail server. It stores only
 * simulated messages in a local JSON file; nothing is sent, received or delivered. Configuration
 * validation refuses the development stack in production.
 */
interface DevAttachment {
  partId: string;
  name: string;
  type: string;
  size: number;
  dataBase64: string;
}

interface DevMessage {
  id: string;
  folderRole: WebmailFolderRole;
  from: WebmailAddress[];
  to: WebmailAddress[];
  cc: WebmailAddress[];
  bcc: WebmailAddress[];
  subject: string;
  text: string;
  html: string | null;
  receivedAt: string;
  read: boolean;
  flagged: boolean;
  size: number;
  draft: boolean;
  attachments: DevAttachment[];
}

interface DevMailbox {
  folders: Record<string, { id: string; role: WebmailFolderRole; name: string }>;
  messages: DevMessage[];
  seeded: boolean;
}

interface DevState {
  seq: number;
  mailboxes: Record<string, DevMailbox>;
}

const FOLDER_LAYOUT: { role: WebmailFolderRole; name: string }[] = [
  { role: 'inbox', name: 'Inbox' },
  { role: 'drafts', name: 'Drafts' },
  { role: 'sent', name: 'Sent' },
  { role: 'archive', name: 'Archive' },
  { role: 'junk', name: 'Junk' },
  { role: 'trash', name: 'Trash' },
];

const normalizeAddress = (raw: string): WebmailAddress => {
  const trimmed = raw.trim();
  const m = /^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/.exec(trimmed);
  if (m && m[2]) return { name: m[1]?.trim() || null, email: m[2].trim().toLowerCase() };
  return { name: null, email: trimmed.toLowerCase() };
};

export class DevWebmailAdapter implements WebmailAdapter {
  readonly kind = 'dev' as const;
  readonly description = 'DEVELOPMENT webmail simulation — messages are not sent, received or stored by a mail server';
  private memory: DevState = { seq: 1, mailboxes: {} };

  constructor(private readonly statePath: string | null) {}

  private load(): DevState {
    if (!this.statePath) return this.memory;
    if (!existsSync(this.statePath)) return { seq: 1, mailboxes: {} };
    try {
      return JSON.parse(readFileSync(this.statePath, 'utf8')) as DevState;
    } catch {
      return { seq: 1, mailboxes: {} };
    }
  }

  private save(state: DevState): void {
    if (!this.statePath) {
      this.memory = state;
      return;
    }
    mkdirSync(dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.statePath);
  }

  private mailbox(state: DevState, box: WebmailMailbox): DevMailbox {
    let m = state.mailboxes[box.mailboxId];
    if (!m) {
      const folders: DevMailbox['folders'] = {};
      for (const f of FOLDER_LAYOUT) folders[f.role] = { id: `${box.mailboxId}-${f.role}`, role: f.role, name: f.name };
      m = { folders, messages: [], seeded: false };
      state.mailboxes[box.mailboxId] = m;
    }
    if (!m.seeded) {
      m.seeded = true;
      m.messages.push({
        id: `${box.mailboxId}-welcome`,
        folderRole: 'inbox',
        from: [{ name: 'ARTHVEX', email: 'welcome@arthvex.invalid' }],
        to: [{ name: null, email: box.address }],
        cc: [],
        bcc: [],
        subject: 'Welcome to the simulated webmail',
        text: `This mailbox (${box.address}) is simulated. No real email is sent or received.\n\nUse Compose to try the interface. Messages you send are stored in Sent and never leave this machine.`,
        html: `<p>This mailbox (<strong>${box.address}</strong>) is <strong>simulated</strong>. No real email is sent or received.</p><p>Use <em>Compose</em> to try the interface. Messages you send are stored in Sent and never leave this machine.</p>`,
        receivedAt: new Date().toISOString(),
        read: false,
        flagged: false,
        size: 900,
        draft: false,
        attachments: [],
      });
    }
    return m;
  }

  private next(state: DevState, prefix: string): string {
    return `${prefix}-${state.seq++}`;
  }

  private folderId(m: DevMailbox, role: WebmailFolderRole): string {
    return m.folders[role]!.id;
  }

  async healthCheck() {
    return { ok: true, detail: 'Development webmail simulation (no real mail)' };
  }

  async listFolders(box: WebmailMailbox): Promise<WebmailFolder[]> {
    const state = this.load();
    const m = this.mailbox(state, box);
    return FOLDER_LAYOUT.map((f) => {
      const msgs = m.messages.filter((x) => x.folderRole === f.role);
      return {
        id: m.folders[f.role]!.id,
        name: f.name,
        role: f.role,
        totalMessages: msgs.length,
        unreadMessages: msgs.filter((x) => !x.read).length,
        parentId: null,
      };
    });
  }

  private summary(m: DevMailbox, msg: DevMessage): WebmailMessageSummary {
    return {
      id: msg.id,
      threadId: null,
      folderIds: [this.folderId(m, msg.folderRole)],
      from: msg.from,
      to: msg.to,
      subject: msg.subject,
      preview: msg.text.slice(0, 240),
      receivedAt: msg.receivedAt,
      unread: !msg.read,
      flagged: msg.flagged,
      hasAttachment: msg.attachments.length > 0,
      size: msg.size,
    };
  }

  async listMessages(box: WebmailMailbox, input: WebmailListInput) {
    const state = this.load();
    const m = this.mailbox(state, box);
    const role = (Object.values(m.folders).find((f) => f.id === input.folderId)?.role ?? 'inbox') as WebmailFolderRole;
    const q = input.q?.trim().toLowerCase();
    const filtered = m.messages
      .filter((msg) => msg.folderRole === role)
      .filter((msg) => (input.unreadOnly ? !msg.read : true))
      .filter((msg) => (!q ? true : `${msg.subject} ${msg.from.map((a) => a.email).join(' ')} ${msg.to.map((a) => a.email).join(' ')} ${msg.text}`.toLowerCase().includes(q)))
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    const start = (input.page - 1) * input.pageSize;
    return { messages: filtered.slice(start, start + input.pageSize).map((msg) => this.summary(m, msg)), total: filtered.length };
  }

  async getMessage(box: WebmailMailbox, messageId: string, _opts: { blockRemoteImages: boolean }): Promise<WebmailMessage> {
    const state = this.load();
    const m = this.mailbox(state, box);
    const msg = m.messages.find((x) => x.id === messageId);
    if (!msg) throw new WebmailError('not_found', 'Message not found.');
    return {
      ...this.summary(m, msg),
      cc: msg.cc,
      bcc: msg.bcc,
      replyTo: [],
      sentAt: msg.receivedAt,
      html: msg.html,
      text: msg.text,
      remoteImagesBlocked: 0,
      attachments: msg.attachments.map((a) => ({ partId: a.partId, blobId: a.partId, name: a.name, type: a.type, size: a.size })),
    };
  }

  async setRead(box: WebmailMailbox, messageId: string, read: boolean): Promise<void> {
    const state = this.load();
    const m = this.mailbox(state, box);
    const msg = m.messages.find((x) => x.id === messageId);
    if (!msg) throw new WebmailError('not_found', 'Message not found.');
    msg.read = read;
    this.save(state);
  }

  async move(box: WebmailMailbox, messageId: string, folderId: string): Promise<void> {
    const state = this.load();
    const m = this.mailbox(state, box);
    const msg = m.messages.find((x) => x.id === messageId);
    if (!msg) throw new WebmailError('not_found', 'Message not found.');
    const folder = Object.values(m.folders).find((f) => f.id === folderId);
    if (!folder) throw new WebmailError('invalid', 'Unknown folder.');
    msg.folderRole = folder.role;
    if (folder.role !== 'drafts') msg.draft = false;
    this.save(state);
  }

  async remove(box: WebmailMailbox, messageId: string): Promise<void> {
    const state = this.load();
    const m = this.mailbox(state, box);
    const idx = m.messages.findIndex((x) => x.id === messageId);
    if (idx < 0) throw new WebmailError('not_found', 'Message not found.');
    m.messages.splice(idx, 1);
    this.save(state);
  }

  private toDevAttachments(input: WebmailAttachmentInput[]): DevAttachment[] {
    return input.map((a, i) => ({ partId: `att-${i}`, name: a.name, type: a.type, size: Buffer.from(a.data, 'base64').length, dataBase64: a.data }));
  }

  private buildMessage(state: DevState, box: WebmailMailbox, input: WebmailDraftInput, role: WebmailFolderRole, id?: string): DevMessage {
    const attachments = this.toDevAttachments(input.attachments);
    const text = input.text || (input.html ? input.html.replace(/<[^>]+>/g, ' ') : '');
    return {
      id: id ?? this.next(state, 'msg'),
      folderRole: role,
      from: [{ name: null, email: box.address }],
      to: input.to.map(normalizeAddress),
      cc: input.cc.map(normalizeAddress),
      bcc: input.bcc.map(normalizeAddress),
      subject: input.subject,
      text,
      html: input.html,
      receivedAt: new Date().toISOString(),
      read: true,
      flagged: false,
      size: text.length + attachments.reduce((s, a) => s + a.size, 0),
      draft: role === 'drafts',
      attachments,
    };
  }

  async saveDraft(box: WebmailMailbox, input: WebmailDraftInput, draftId?: string): Promise<{ id: string }> {
    const state = this.load();
    const m = this.mailbox(state, box);
    if (draftId) {
      const idx = m.messages.findIndex((x) => x.id === draftId && x.folderRole === 'drafts');
      if (idx >= 0) {
        m.messages[idx] = this.buildMessage(state, box, input, 'drafts', draftId);
        this.save(state);
        return { id: draftId };
      }
    }
    const msg = this.buildMessage(state, box, input, 'drafts');
    m.messages.push(msg);
    this.save(state);
    return { id: msg.id };
  }

  async send(box: WebmailMailbox, input: WebmailDraftInput, draftId?: string): Promise<{ id: string }> {
    if (input.to.length === 0 && input.cc.length === 0 && input.bcc.length === 0) throw new WebmailError('invalid', 'Add at least one recipient.');
    const state = this.load();
    const m = this.mailbox(state, box);
    if (draftId) {
      const idx = m.messages.findIndex((x) => x.id === draftId);
      if (idx >= 0) m.messages.splice(idx, 1);
    }
    const msg = this.buildMessage(state, box, input, 'sent');
    m.messages.push(msg);
    this.save(state);
    return { id: msg.id };
  }

  async downloadAttachment(box: WebmailMailbox, blobId: string, _name: string, _type: string) {
    const state = this.load();
    const m = this.mailbox(state, box);
    for (const msg of m.messages) {
      const found = msg.attachments.find((a) => a.partId === blobId);
      if (found) return { data: Buffer.from(found.dataBase64, 'base64'), contentType: found.type, filename: found.name };
    }
    throw new WebmailError('not_found', 'Attachment not found.');
  }
}
