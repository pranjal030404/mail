/**
 * Provider-neutral webmail contract.
 *
 * Implementations talk to the mail engine (JMAP in production) or to the development simulator.
 * Message bodies and attachments are never copied into MySQL: only application metadata (mailbox
 * credentials, preferences) is stored there.
 */

export type WebmailFolderRole = 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | 'other';

export interface WebmailFolder {
  id: string;
  name: string;
  role: WebmailFolderRole;
  totalMessages: number;
  unreadMessages: number;
  parentId: string | null;
}

export interface WebmailAddress {
  name: string | null;
  email: string;
}

export interface WebmailAttachmentSummary {
  partId: string;
  blobId: string | null;
  name: string;
  type: string;
  size: number;
}

export interface WebmailMessageSummary {
  id: string;
  threadId: string | null;
  folderIds: string[];
  from: WebmailAddress[];
  to: WebmailAddress[];
  subject: string;
  preview: string;
  receivedAt: string;
  unread: boolean;
  flagged: boolean;
  hasAttachment: boolean;
  size: number;
}

export interface WebmailMessage extends WebmailMessageSummary {
  cc: WebmailAddress[];
  bcc: WebmailAddress[];
  replyTo: WebmailAddress[];
  sentAt: string | null;
  /** Server-sanitised HTML (scripts, forms, frames and event handlers removed). */
  html: string | null;
  /** Plain-text alternative, always present. */
  text: string;
  attachments: WebmailAttachmentSummary[];
  /** Number of remote images removed by the sanitiser. */
  remoteImagesBlocked: number;
}

export interface WebmailAttachmentInput {
  name: string;
  type: string;
  /** Base64 bytes. Bounded by WEBMAIL_MAX_ATTACHMENT_BYTES. */
  data: string;
}

export interface WebmailDraftInput {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  html: string | null;
  attachments: WebmailAttachmentInput[];
}

export interface WebmailListInput {
  folderId?: string | undefined;
  q?: string | undefined;
  unreadOnly?: boolean | undefined;
  page: number;
  pageSize: number;
}

export interface WebmailMailbox {
  mailboxId: string;
  address: string;
  /** Mail engine account identifier. */
  engineId: string;
  /** Mailbox-scoped bearer credential. Never logged or returned to clients. */
  credential: string;
}

export interface WebmailAdapter {
  readonly kind: 'jmap' | 'dev';
  readonly description: string;
  healthCheck(): Promise<{ ok: boolean; detail: string }>;
  listFolders(box: WebmailMailbox): Promise<WebmailFolder[]>;
  listMessages(box: WebmailMailbox, input: WebmailListInput): Promise<{ messages: WebmailMessageSummary[]; total: number }>;
  getMessage(box: WebmailMailbox, messageId: string, opts: { blockRemoteImages: boolean }): Promise<WebmailMessage>;
  setRead(box: WebmailMailbox, messageId: string, read: boolean): Promise<void>;
  move(box: WebmailMailbox, messageId: string, folderId: string): Promise<void>;
  remove(box: WebmailMailbox, messageId: string): Promise<void>;
  /** Creates or updates a draft. Passing `draftId` updates in place. */
  saveDraft(box: WebmailMailbox, input: WebmailDraftInput, draftId?: string): Promise<{ id: string }>;
  /** Sends a message. On failure the draft remains so the user can retry. */
  send(box: WebmailMailbox, input: WebmailDraftInput, draftId?: string): Promise<{ id: string }>;
  downloadAttachment(box: WebmailMailbox, blobId: string, name: string, type: string): Promise<{ data: Buffer; contentType: string; filename: string }>;
}

export class WebmailError extends Error {
  constructor(
    public readonly kind: 'unavailable' | 'unauthorized' | 'not_found' | 'invalid' | 'too_large',
    message: string,
  ) {
    super(message);
    this.name = 'WebmailError';
  }
}

export const KNOWN_ATTACHMENT_BLOCKLIST = ['.exe', '.com', '.bat', '.cmd', '.scr', '.msi', '.js', '.vbs', '.jar', '.ps1', '.hta', '.cpl', '.pif'];
