import { describe, expect, it } from 'vitest';
import { DevWebmailAdapter } from './dev-webmail.adapter.js';
import type { WebmailDraftInput, WebmailMailbox } from './webmail.interface.js';

const boxA: WebmailMailbox = { mailboxId: 'mbx-a', address: 'alice@example.test', engineId: 'eng-a', credential: 'secret-a' };
const boxB: WebmailMailbox = { mailboxId: 'mbx-b', address: 'bob@example.test', engineId: 'eng-b', credential: 'secret-b' };
const draft = (over: Partial<WebmailDraftInput> = {}): WebmailDraftInput => ({
  to: ['friend@example.test'],
  cc: [],
  bcc: [],
  subject: 'Hello',
  text: 'Body text',
  html: '<p>Body text</p>',
  attachments: [],
  ...over,
});

describe('development webmail simulator', () => {
  it('seeds each mailbox independently', async () => {
    const dev = new DevWebmailAdapter(null);
    const folders = await dev.listFolders(boxA);
    expect(folders.map((f) => f.role)).toContain('inbox');
    const a = await dev.listMessages(boxA, { page: 1, pageSize: 25 });
    expect(a.messages).toHaveLength(1);
    expect(a.messages[0]!.subject).toContain('simulated');
  });

  it('never exposes one mailbox\'s messages to another', async () => {
    const dev = new DevWebmailAdapter(null);
    const a = await dev.listMessages(boxA, { page: 1, pageSize: 25 });
    const id = a.messages[0]!.id;
    await expect(dev.getMessage(boxB, id, { blockRemoteImages: true })).rejects.toMatchObject({ kind: 'not_found' });
    const b = await dev.listMessages(boxB, { page: 1, pageSize: 25 });
    expect(b.messages.some((m) => m.id === id)).toBe(false);
  });

  it('sends into Sent and removes the draft', async () => {
    const dev = new DevWebmailAdapter(null);
    const saved = await dev.saveDraft(boxA, draft({ subject: 'Draft subject' }));
    const sent = await dev.send(boxA, draft({ subject: 'Sent subject' }), saved.id);
    const folders = await dev.listFolders(boxA);
    const drafts = folders.find((f) => f.role === 'drafts')!;
    const sentFolder = folders.find((f) => f.role === 'sent')!;
    const draftList = await dev.listMessages(boxA, { folderId: drafts.id, page: 1, pageSize: 25 });
    const sentList = await dev.listMessages(boxA, { folderId: sentFolder.id, page: 1, pageSize: 25 });
    expect(draftList.messages.find((m) => m.id === saved.id)).toBeUndefined();
    expect(sentList.messages.find((m) => m.id === sent.id)?.subject).toBe('Sent subject');
  });

  it('updates a draft in place instead of duplicating it', async () => {
    const dev = new DevWebmailAdapter(null);
    const saved = await dev.saveDraft(boxA, draft({ subject: 'One' }));
    const again = await dev.saveDraft(boxA, draft({ subject: 'Two' }), saved.id);
    expect(again.id).toBe(saved.id);
    const folders = await dev.listFolders(boxA);
    const drafts = folders.find((f) => f.role === 'drafts')!;
    const list = await dev.listMessages(boxA, { folderId: drafts.id, page: 1, pageSize: 25 });
    expect(list.total).toBe(1);
    expect(list.messages[0]!.subject).toBe('Two');
  });

  it('searches only inside the selected mailbox and marks read state', async () => {
    const dev = new DevWebmailAdapter(null);
    const found = await dev.listMessages(boxA, { q: 'simulated', page: 1, pageSize: 25 });
    expect(found.total).toBe(1);
    await dev.setRead(boxA, found.messages[0]!.id, true);
    const after = await dev.listMessages(boxA, { q: 'simulated', page: 1, pageSize: 25 });
    expect(after.messages[0]!.unread).toBe(false);
    const none = await dev.listMessages(boxA, { q: 'no-such-text', page: 1, pageSize: 25 });
    expect(none.total).toBe(0);
  });

  it('moves messages to another folder and downloads attachments', async () => {
    const dev = new DevWebmailAdapter(null);
    const folders = await dev.listFolders(boxA);
    const trash = folders.find((f) => f.role === 'trash')!;
    const inbox = folders.find((f) => f.role === 'inbox')!;
    const msg = (await dev.listMessages(boxA, { folderId: inbox.id, page: 1, pageSize: 25 })).messages[0]!;
    await dev.move(boxA, msg.id, trash.id);
    const trashed = await dev.listMessages(boxA, { folderId: trash.id, page: 1, pageSize: 25 });
    expect(trashed.messages.map((m) => m.id)).toContain(msg.id);

    const withFile = await dev.send(boxA, draft({ attachments: [{ name: 'notes.txt', type: 'text/plain', data: Buffer.from('hello').toString('base64') }] }));
    const detail = await dev.getMessage(boxA, withFile.id, { blockRemoteImages: true });
    expect(detail.attachments).toHaveLength(1);
    const file = await dev.downloadAttachment(boxA, detail.attachments[0]!.blobId!, 'notes.txt', 'text/plain');
    expect(file.data.toString()).toBe('hello');
  });

  it('rejects a send with no recipients', async () => {
    const dev = new DevWebmailAdapter(null);
    await expect(dev.send(boxA, draft({ to: [] }))).rejects.toMatchObject({ kind: 'invalid' });
  });
});
