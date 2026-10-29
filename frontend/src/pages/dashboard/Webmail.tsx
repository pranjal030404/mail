import { ArrowLeft, Archive, ChevronLeft, ChevronRight, Inbox, Mail, MailOpen, Paperclip, PenLine, RefreshCw, Reply, ReplyAll, Search, Send, Settings2, ShieldAlert, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Alert, Button, EmptyState, ErrorAlert, Spinner, StatusBadge, TextField } from '../../components/ui';
import { del, get, patch, post } from '../../lib/api';
import { formatBytes, formatDate, timeAgo } from '../../lib/format';
import type { Mailbox, WebmailAddress, WebmailFolder, WebmailMessage, WebmailMessageSummary, WebmailPreferences } from '../../lib/types';
import { useAsync } from '../../lib/useAsync';
import { useTenant } from './shared';

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;

interface AttachmentDraft {
  name: string;
  type: string;
  data: string;
  size: number;
}

interface ComposeState {
  open: boolean;
  draftId: string | null;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  text: string;
  attachments: AttachmentDraft[];
  showCc: boolean;
}

const emptyCompose = (): ComposeState => ({ open: false, draftId: null, to: '', cc: '', bcc: '', subject: '', text: '', attachments: [], showCc: false });

const addressText = (list: WebmailAddress[]): string => list.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', ');
const splitAddresses = (value: string): string[] => value.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
const roleIcon = (role: string) => {
  if (role === 'inbox') return <Inbox size={16} />;
  if (role === 'sent') return <Send size={16} />;
  if (role === 'drafts') return <PenLine size={16} />;
  if (role === 'trash') return <Trash2 size={16} />;
  if (role === 'archive') return <Archive size={16} />;
  if (role === 'junk') return <ShieldAlert size={16} />;
  return <Mail size={16} />;
};

function wrapHtml(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><base target="_blank"><style>
    :root { color-scheme: light dark; }
    body { margin: 0; padding: 12px; font: 14px/1.55 -apple-system, "Segoe UI", Roboto, system-ui, sans-serif; color: #15181e; background: #fff; word-wrap: break-word; }
    a { color: #1f5eff; } img { max-width: 100%; height: auto; } table { max-width: 100%; } blockquote { border-left: 3px solid #dde1e8; margin: .5rem 0; padding-left: .8rem; color: #5a6372; }
    @media (prefers-color-scheme: dark) { body { color: #e8ebf0; background: #171b23; } a { color: #8fb0ff; } blockquote { border-color: #2a303c; color: #9aa3b2; } }
  </style></head><body>${html}</body></html>`;
}

export default function Webmail() {
  const { tenantId } = useTenant();
  const [sp, setSp] = useSearchParams();
  const folderId = sp.get('folder') ?? '';
  const messageId = sp.get('message') ?? '';
  const requestedMailbox = sp.get('mailbox') ?? '';
  const q = sp.get('q') ?? '';
  const page = Number(sp.get('page') ?? '1');
  const [showImages, setShowImages] = useState(false);

  const mailboxes = useAsync(() => get<{ mailboxes: Mailbox[] }>(`/tenants/${tenantId}/mailboxes?pageSize=100&sort=address&order=asc`), [tenantId]);
  const usable = useMemo(() => (mailboxes.data?.mailboxes ?? []).filter((m) => m.status === 'active' || m.status === 'suspended'), [mailboxes.data]);
  const mailbox = usable.find((m) => m.id === requestedMailbox) ?? usable.find((m) => m.status === 'active') ?? null;
  const mailboxBase = mailbox ? `/tenants/${tenantId}/mailboxes/${mailbox.id}/webmail` : '';

  const folders = useAsync(() => (mailbox ? get<{ folders: WebmailFolder[] }>(`${mailboxBase}/folders`) : Promise.resolve({ folders: [] })), [mailboxBase, mailbox?.id]);
  const activeFolder = folders.data?.folders.find((f) => f.id === folderId) ?? folders.data?.folders.find((f) => f.role === 'inbox') ?? null;
  const list = useAsync(
    () =>
      mailbox && activeFolder
        ? get<{ messages: WebmailMessageSummary[]; total: number }>(
            `${mailboxBase}/messages?folderId=${encodeURIComponent(activeFolder.id)}&page=${page}&pageSize=25${q ? `&q=${encodeURIComponent(q)}` : ''}`,
          )
        : Promise.resolve({ messages: [], total: 0 }),
    [mailboxBase, mailbox?.id, activeFolder?.id, page, q],
  );
  const prefs = useAsync(() => (mailbox ? get<WebmailPreferences>(`${mailboxBase}/preferences`) : Promise.resolve({ signature: '', blockRemoteImages: true })), [mailboxBase, mailbox?.id]);
  // Remote images load only when the user opted in for this message, or disabled blocking for the mailbox.
  const loadRemoteImages = showImages || prefs.data?.blockRemoteImages === false;
  const message = useAsync(
    () => (mailbox && messageId ? get<WebmailMessage>(`${mailboxBase}/messages/${encodeURIComponent(messageId)}?images=${loadRemoteImages ? 'true' : 'false'}`) : Promise.resolve(null)),
    [mailboxBase, mailbox?.id, messageId, loadRemoteImages],
  );

  const [compose, setCompose] = useState<ComposeState>(emptyCompose);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [searchText, setSearchText] = useState(q);
  const searchRef = useRef<HTMLInputElement>(null);

  const nav = useCallback(
    (changes: Record<string, string | null>, resetPage = false) => {
      const next = new URLSearchParams(sp);
      for (const [k, v] of Object.entries(changes)) {
        if (v === null || v === '') next.delete(k);
        else next.set(k, v);
      }
      if (resetPage) next.delete('page');
      if (changes.mailbox) {
        next.delete('folder');
        next.delete('message');
        next.delete('page');
      }
      if (changes.folder) next.delete('message');
      setSp(next);
    },
    [sp, setSp],
  );

  // Remember the chosen mailbox so folders can resolve on the next visit.
  useEffect(() => {
    if (!sp.get('mailbox') && mailbox) nav({ mailbox: mailbox.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mailbox?.id]);

  // Opening an unread message marks it read (server-side keyword change).
  const markReadDone = useRef<string | null>(null);
  useEffect(() => {
    if (!mailbox || !message.data || !message.data.unread || markReadDone.current === message.data.id) return;
    markReadDone.current = message.data.id;
    void patch(`${mailboxBase}/messages/${encodeURIComponent(message.data.id)}`, { read: true })
      .then(() => list.reload())
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message.data?.id]);

  useEffect(() => {
    setShowImages(false);
  }, [messageId]);

  const openMessage = (id: string) => nav({ message: id });
  const currentList = list.data?.messages ?? [];
  const currentIndex = currentList.findIndex((m) => m.id === messageId);

  const refreshAll = useCallback(async () => {
    await Promise.all([folders.reload(), list.reload()]);
  }, [folders, list]);

  const act = async (name: string, fn: () => Promise<unknown>, after?: () => Promise<void> | void) => {
    setBusy(name);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (after) await after();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const closeCompose = () => setCompose(emptyCompose());

  const startCompose = (state: Partial<ComposeState> = {}) => {
    const signature = prefs.data?.signature?.trim();
    const base = emptyCompose();
    const text = state.text ?? '';
    setCompose({ ...base, ...state, open: true, text: text || (signature ? `\n\n--\n${signature}` : ''), draftId: state.draftId ?? null });
  };

  const reply = (mode: 'reply' | 'reply-all' | 'forward') => {
    const m = message.data;
    if (!m) return;
    const own = mailbox?.address ?? '';
    if (mode === 'forward') {
      return startCompose({ subject: m.subject.startsWith('Fwd:') ? m.subject : `Fwd: ${m.subject}`, text: `\n\n---------- Forwarded message ----------\nFrom: ${addressText(m.from)}\nDate: ${formatDate(m.receivedAt)}\nSubject: ${m.subject}\n\n${m.text}` });
    }
    const to = m.replyTo.length ? m.replyTo : m.from;
    const cc = mode === 'reply-all' ? [...m.to, ...m.cc].filter((a) => a.email !== own && !to.some((t) => t.email === a.email)) : [];
    startCompose({
      to: to.map((a) => a.email).join(', '),
      cc: cc.map((a) => a.email).join(', '),
      showCc: cc.length > 0,
      subject: m.subject.toLowerCase().startsWith('re:') ? m.subject : `Re: ${m.subject}`,
      text: `\n\nOn ${formatDate(m.receivedAt)}, ${addressText(m.from)} wrote:\n> ${m.text.split('\n').join('\n> ')}`,
    });
  };

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    if (compose.attachments.length + files.length > MAX_ATTACHMENTS) {
      setError(new Error(`You can attach at most ${MAX_ATTACHMENTS} files.`));
      return;
    }
    const next: AttachmentDraft[] = [];
    for (const file of Array.from(files)) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setError(new Error(`"${file.name}" is larger than ${formatBytes(MAX_ATTACHMENT_BYTES)}.`));
        continue;
      }
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      next.push({ name: file.name, type: file.type || 'application/octet-stream', data, size: file.size });
    }
    setCompose((c) => ({ ...c, attachments: [...c.attachments, ...next] }));
  };

  const composeBody = (c: ComposeState) => ({
    to: splitAddresses(c.to),
    cc: splitAddresses(c.cc),
    bcc: splitAddresses(c.bcc),
    subject: c.subject,
    text: c.text,
    html: null,
    attachments: c.attachments.map((a) => ({ name: a.name, type: a.type, data: a.data })),
    ...(c.draftId ? { draftId: c.draftId } : {}),
  });

  const saveDraft = async (c: ComposeState): Promise<string | null> => {
    if (!mailbox) return null;
    const res = await post<{ id: string }>(`${mailboxBase}/drafts`, composeBody(c));
    setCompose((cur) => ({ ...cur, draftId: res.id }));
    setNotice('Draft saved.');
    await refreshAll();
    return res.id;
  };

  const send = async () => {
    if (!mailbox) return;
    setBusy('send');
    setError(null);
    setNotice(null);
    try {
      await post(`${mailboxBase}/send`, composeBody(compose));
      closeCompose();
      setNotice('Message accepted by the mail server and moved to Sent.');
      await refreshAll();
    } catch (e) {
      setError(e);
      // Keeping the draft makes an uncertain send recoverable: the user can retry.
      try {
        await saveDraft(compose);
      } catch {
        /* the error above is the important one */
      }
    } finally {
      setBusy(null);
    }
  };

  const reorder = (delta: number) => {
    if (currentIndex < 0) return;
    const next = currentList[currentIndex + delta];
    if (next) openMessage(next.id);
  };

  // Keyboard navigation: only outside form fields and with no dialog open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (compose.open) {
        if (e.key === 'Escape') closeCompose();
        return;
      }
      if (e.key === 'c') {
        e.preventDefault();
        startCompose();
      } else if (e.key === 'j') {
        reorder(1);
      } else if (e.key === 'k') {
        reorder(-1);
      } else if (e.key === 'r' && messageId) {
        reply('reply');
      } else if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === 'Escape') {
        if (compose.open) closeCompose();
        else if (messageId) nav({ message: null });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compose.open, messageId, currentIndex, currentList.length, prefs.data?.signature]);

  if (!tenantId) return null;
  if (mailboxes.loading && !mailboxes.data) return <Spinner label="Loading mailboxes" />;
  if (mailboxes.error) return <ErrorAlert error={mailboxes.error} onRetry={mailboxes.reload} />;
  if (usable.length === 0) {
    return (
      <EmptyState icon={<Mail size={28} />} title="No mailbox to open">
        Webmail needs an active mailbox. Create one from <a href="/dashboard/mailboxes">Mailboxes</a> and set a password there first. Provisioning may take a moment.
      </EmptyState>
    );
  }
  if (!mailbox) return <Spinner label="Selecting a mailbox" />;
  if (mailbox.status !== 'active') {
    return <Alert kind="warning" title="This mailbox is suspended">{mailbox.suspendedReason ?? 'Reactivate the mailbox to read or send email.'}</Alert>;
  }

  const base = mailboxBase;
  const total = list.data?.total ?? 0;
  const unreadTotal = folders.data?.folders.reduce((n, f) => n + f.unreadMessages, 0) ?? 0;

  return (
    <div className="wm">
      <div className="wm-toolbar">
        <div className="row">
          <h1 style={{ fontSize: '1.25rem' }}>Webmail</h1>
          <StatusBadge status={mailbox.status} />
          {unreadTotal > 0 && <span className="badge badge-neutral">{unreadTotal} unread</span>}
        </div>
        <div className="row">
          <select aria-label="Mailbox" value={mailbox.id} onChange={(e) => nav({ mailbox: e.target.value })} style={{ maxWidth: 260 }}>
            {usable.map((m) => <option key={m.id} value={m.id}>{m.address}</option>)}
          </select>
          <Button variant="primary" onClick={() => startCompose()} title="Compose (c)"><PenLine size={16} /> Compose</Button>
        </div>
      </div>

      <div className="wm-shell">
        <nav className="wm-folders" aria-label="Folders">
          {folders.loading && !folders.data && <Spinner label="Folders" />}
          <ErrorAlert error={folders.error} onRetry={folders.reload} />
          {folders.data?.folders.map((f) => (
            <button
              key={f.id}
              className={`wm-folder${activeFolder?.id === f.id ? ' active' : ''}`}
              aria-current={activeFolder?.id === f.id ? 'page' : undefined}
              onClick={() => nav({ folder: f.id, message: null })}
            >
              {roleIcon(f.role)}
              <span>{f.name}</span>
              {f.unreadMessages > 0 && <span className="wm-count">{f.unreadMessages}</span>}
              {f.unreadMessages === 0 && f.totalMessages > 0 && <span className="wm-count muted-count">{f.totalMessages}</span>}
            </button>
          ))}
          <button className="wm-folder" onClick={() => nav({ folder: folders.data?.folders.find((f) => f.role === 'archive')?.id ?? null })} disabled={!folders.data?.folders.some((f) => f.role === 'archive')}>
            <Archive size={16} /><span>Archive</span>
          </button>
          <div className="wm-hint">
            <strong>Shortcuts</strong>
            <span><kbd>c</kbd> compose · <kbd>j</kbd>/<kbd>k</kbd> next/previous</span>
            <span><kbd>r</kbd> reply · <kbd>/</kbd> search · <kbd>esc</kbd> close</span>
          </div>
        </nav>

        <section className="wm-list" aria-label="Messages">
          <form
            className="wm-search"
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              nav({ q: searchText, message: null }, true);
            }}
          >
            <Search size={15} aria-hidden />
            <input ref={searchRef} aria-label="Search this mailbox" placeholder="Search this mailbox…" value={searchText} onChange={(e) => setSearchText(e.target.value)} />
            {q && <button type="button" className="icon-btn" aria-label="Clear search" onClick={() => { setSearchText(''); nav({ q: null, message: null }, true); }}><X size={15} /></button>}
            <button type="button" className="icon-btn" aria-label="Refresh messages" onClick={() => void refreshAll()}><RefreshCw size={15} /></button>
          </form>
          {notice && <Alert kind="success" onClose={() => setNotice(null)}>{notice}</Alert>}
          <ErrorAlert error={error} />
          {list.loading && !list.data && <Spinner label="Messages" />}
          <ErrorAlert error={list.error} onRetry={list.reload} />
          {list.data && currentList.length === 0 && (
            <EmptyState icon={<MailOpen size={26} />} title={q ? 'No matches' : activeFolder?.role === 'drafts' ? 'No drafts' : 'Nothing here'}>
              {q ? 'Try a different search term.' : activeFolder?.role === 'inbox' ? 'New mail will appear here. Compose a message to try sending.' : 'This folder is empty.'}
            </EmptyState>
          )}
          <ul className="wm-items">
            {currentList.map((m) => (
              <li key={m.id}>
                <button className={`wm-item${m.unread ? ' unread' : ''}${messageId === m.id ? ' selected' : ''}`} onClick={() => openMessage(m.id)} aria-current={messageId === m.id ? 'true' : undefined}>
                  <span className="wm-item-top">
                    <span className="wm-from">{m.from[0]?.name || m.from[0]?.email || '(unknown sender)'}</span>
                    <span className="wm-date">{timeAgo(m.receivedAt)}</span>
                  </span>
                  <span className="wm-subject">{m.subject}</span>
                  <span className="wm-preview">{m.preview}</span>
                  <span className="wm-meta">{m.hasAttachment && <Paperclip size={13} aria-label="Has attachment" />}{m.unread && <span className="wm-dot" aria-label="Unread" />}</span>
                </button>
              </li>
            ))}
          </ul>
          {total > 25 && (
            <div className="row spread wm-pager">
              <Button small disabled={page <= 1} onClick={() => nav({ page: String(page - 1) })}><ChevronLeft size={14} /> Newer</Button>
              <small className="muted">{Math.min(total, (page - 1) * 25 + 1)}–{Math.min(total, page * 25)} of {total}</small>
              <Button small disabled={page * 25 >= total} onClick={() => nav({ page: String(page + 1) })}>Older <ChevronRight size={14} /></Button>
            </div>
          )}
        </section>

        <section className="wm-reader" aria-label="Message">
          {!messageId && <EmptyState icon={<Mail size={30} />} title="Select a message">Choose a message to read it here. Nothing is downloaded until you open it.</EmptyState>}
          {message.loading && !message.data && <Spinner label="Opening message" />}
          <ErrorAlert error={message.error} onRetry={message.reload} />
          {message.data && (
            <article>
              <header className="wm-reader-head">
                <div className="row spread">
                  <h2>{message.data.subject}</h2>
                  <div className="row">
                    <Button small onClick={() => nav({ message: null })} title="Close (Esc)"><ArrowLeft size={14} /> Back</Button>
                  </div>
                </div>
                <dl className="wm-headers">
                  <dt>From</dt><dd>{addressText(message.data.from)}</dd>
                  <dt>To</dt><dd>{addressText(message.data.to)}</dd>
                  {message.data.cc.length > 0 && <><dt>Cc</dt><dd>{addressText(message.data.cc)}</dd></>}
                  <dt>Date</dt><dd>{formatDate(message.data.receivedAt)} <span className="muted">({new Date(message.data.receivedAt).toISOString()})</span></dd>
                </dl>
                <div className="row wm-actions">
                  <Button small onClick={() => reply('reply')} title="Reply (r)"><Reply size={14} /> Reply</Button>
                  <Button small onClick={() => reply('reply-all')}><ReplyAll size={14} /> Reply all</Button>
                  <Button small onClick={() => reply('forward')}>Forward</Button>
                  <Button small busy={busy === 'read'} onClick={() => act('read', () => patch(`${base}/messages/${encodeURIComponent(message.data!.id)}`, { read: message.data!.unread }), refreshAll)}>
                    {message.data.unread ? <Mail size={14} /> : <MailOpen size={14} />} Mark {message.data.unread ? 'read' : 'unread'}
                  </Button>
                  <select
                    aria-label="Move message"
                    defaultValue=""
                    onChange={(e) => {
                      const target = e.target.value;
                      if (target) void act('move', () => post(`${base}/messages/${encodeURIComponent(message.data!.id)}/move`, { folderId: target }), async () => { nav({ message: null }); await refreshAll(); });
                      e.currentTarget.value = '';
                    }}
                    style={{ maxWidth: 150 }}
                  >
                    <option value="">Move to…</option>
                    {folders.data?.folders.filter((f) => !message.data!.folderIds.includes(f.id)).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                  </select>
                  <Button small variant="danger" busy={busy === 'delete'} onClick={() => act('delete', () => del(`${base}/messages/${encodeURIComponent(message.data!.id)}`), async () => { nav({ message: null }); await refreshAll(); })}>
                    <Trash2 size={14} /> Delete
                  </Button>
                </div>
              </header>

              {message.data.remoteImagesBlocked > 0 && (
                <Alert kind="info" title={`${message.data.remoteImagesBlocked} remote image${message.data.remoteImagesBlocked === 1 ? '' : 's'} blocked`}>
                  Remote images can tell the sender that you opened this message. <Button small onClick={() => setShowImages(true)}>Load images</Button>
                </Alert>
              )}

              <div className="wm-body">
                {message.data.html ? (
                  <iframe title="Message content" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={wrapHtml(message.data.html)} className="wm-frame" />
                ) : (
                  <pre className="wm-text">{message.data.text || '(This message has no displayable content.)'}</pre>
                )}
              </div>

              {message.data.attachments.length > 0 && (
                <div className="wm-attachments">
                  <h3><Paperclip size={15} /> Attachments</h3>
                  <ul>
                    {message.data.attachments.map((a) => (
                      <li key={a.partId}>
                        {a.blobId ? (
                          <a className="btn btn-sm" href={`/api/v1${base}/attachments/${encodeURIComponent(a.blobId)}?name=${encodeURIComponent(a.name)}&type=${encodeURIComponent(a.type)}`} download={a.name}>{a.name}</a>
                        ) : <span>{a.name}</span>}
                        <small className="muted">{a.type} · {formatBytes(a.size)}</small>
                      </li>
                    ))}
                  </ul>
                  <p className="muted"><small>Attachments are downloaded from the mail server after an authorization check; they are never stored by ARTHVEX.</small></p>
                </div>
              )}
            </article>
          )}
        </section>
      </div>

      {compose.open && (
        <div className="wm-compose" role="dialog" aria-modal="true" aria-labelledby="wm-compose-title">
          <div className="wm-compose-card">
            <header className="row spread">
              <h2 id="wm-compose-title">{compose.draftId ? 'Edit draft' : 'New message'}</h2>
              <button className="icon-btn" aria-label="Close compose" onClick={closeCompose}><X size={18} /></button>
            </header>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <TextField label="To" autoFocus value={compose.to} onChange={(e) => setCompose({ ...compose, to: e.target.value })} placeholder="name@example.com, …" autoComplete="off" />
              {compose.showCc ? (
                <div className="row">
                  <div style={{ flex: 1 }}><TextField label="Cc" value={compose.cc} onChange={(e) => setCompose({ ...compose, cc: e.target.value })} /></div>
                  <div style={{ flex: 1 }}><TextField label="Bcc" value={compose.bcc} onChange={(e) => setCompose({ ...compose, bcc: e.target.value })} /></div>
                </div>
              ) : (
                <Button type="button" small variant="ghost" onClick={() => setCompose({ ...compose, showCc: true })}>Add Cc/Bcc</Button>
              )}
              <TextField label="Subject" value={compose.subject} onChange={(e) => setCompose({ ...compose, subject: e.target.value })} />
              <div className="field">
                <label htmlFor="wm-body-input">Message</label>
                <textarea id="wm-body-input" rows={12} value={compose.text} onChange={(e) => setCompose({ ...compose, text: e.target.value })} />
                <small className="muted">Plain text. Your signature is inserted automatically when configured in preferences.</small>
              </div>
              <div className="row spread">
                <label className="btn btn-sm" style={{ cursor: 'pointer' }}>
                  <Paperclip size={14} /> Attach files
                  <input type="file" multiple hidden onChange={(e) => void addFiles(e.target.files)} />
                </label>
                <small className="muted">{compose.attachments.length}/{MAX_ATTACHMENTS} · max {formatBytes(MAX_ATTACHMENT_BYTES)} each</small>
              </div>
              {compose.attachments.length > 0 && (
                <ul className="wm-chips">
                  {compose.attachments.map((a, i) => (
                    <li key={`${a.name}-${i}`} className="wm-chip">
                      <Paperclip size={13} /> {a.name} <small>{formatBytes(a.size)}</small>
                      <button type="button" className="icon-btn" aria-label={`Remove ${a.name}`} onClick={() => setCompose({ ...compose, attachments: compose.attachments.filter((_, j) => j !== i) })}><X size={13} /></button>
                    </li>
                  ))}
                </ul>
              )}
              <ErrorAlert error={error} />
              <div className="row spread" style={{ marginTop: '.75rem' }}>
                <span className="row">
                  <Button type="button" busy={busy === 'draft'} onClick={() => void act('draft', () => saveDraft(compose))}>Save draft</Button>
                  <Button type="button" onClick={closeCompose}>Discard</Button>
                </span>
                <span className="row">
                  {prefs.data && <Button type="button" small variant="ghost" onClick={async () => {
                    const next = !prefs.data!.blockRemoteImages;
                    await patch(`${base}/preferences`, { blockRemoteImages: next });
                    await prefs.reload();
                  }} title="Remote-image preference for this mailbox"><Settings2 size={14} /> {prefs.data.blockRemoteImages ? 'Remote images blocked' : 'Remote images allowed'}</Button>}
                  <Button type="submit" variant="primary" busy={busy === 'send'} disabled={!compose.to.trim() && !compose.cc.trim() && !compose.bcc.trim()}><Send size={15} /> Send</Button>
                </span>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
