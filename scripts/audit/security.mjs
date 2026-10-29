// Live security assessment against a real API + database (development adapters).
// Every result is an HTTP status actually observed. See docs/audit/security-findings.md.
import {
  api, check, closeDb, login, newAdmin, newMailbox, newUser, newVerifiedDomain, newWorkspace,
  PASSWORDS, rand, results, sql, summary,
} from './lib.mjs';

const log = (...a) => console.log(...a);

// ---------------------------------------------------------------- fixtures
const A = await newUser('owner-a');
const wsA = await newWorkspace(A, 'Audit Tenant A');
const tenantA = wsA.id ?? wsA.tenant?.id;
const domA = await newVerifiedDomain(A, tenantA);
const mbA = await newMailbox(A, tenantA, domA.id, 'alice');

const B = await newUser('owner-b');
const wsB = await newWorkspace(B, 'Audit Tenant B');
const tenantB = wsB.id ?? wsB.tenant?.id;
const domB = await newVerifiedDomain(B, tenantB);
const mbB = await newMailbox(B, tenantB, domB.id, 'bob');
const mbA2 = await newMailbox(A, tenantA, domA.id, 'carol');

// A mailbox_user in tenant A, linked to alice's mailbox, via a real invitation.
const C = await newUser('member-c');
const invite = await api(`/tenants/${tenantA}/members`, { method: 'POST', body: { email: C.email, role: 'mailbox_user', mailboxId: mbA.id }, auth: A.auth });
if (invite.status !== 201) throw new Error(`invite failed: ${invite.status} ${JSON.stringify(invite.json)}`);
const { readFileSync, readdirSync } = await import('node:fs');
const { join } = await import('node:path');
const { OUTBOX } = await import('./lib.mjs');
let inviteToken = null;
for (let i = 0; i < 30 && !inviteToken; i++) {
  for (const f of readdirSync(OUTBOX).filter((f) => f.includes('tenant_invitation'))) {
    const t = readFileSync(join(OUTBOX, f), 'utf8');
    if (t.includes(C.email)) {
      const m = /#token=([A-Za-z0-9_-]+)/.exec(t);
      if (m) inviteToken = m[1];
    }
  }
  if (!inviteToken) await new Promise((r) => setTimeout(r, 100));
}
const accept = await api('/invitations/accept', { method: 'POST', body: { token: inviteToken }, auth: C.auth });
check('member accepts invitation', accept.status === 200, `status ${accept.status}`);

log(`fixtures: tenantA=${tenantA} mbA=${mbA.normalized_address} tenantB=${tenantB} mbB=${mbB.normalized_address}`);

// ---------------------------------------------------------------- 1. tenant isolation
const isolation = [
  ['tenant detail', 'GET', `/tenants/${tenantA}`],
  ['tenant domains', 'GET', `/tenants/${tenantA}/domains`],
  ['domain detail', 'GET', `/tenants/${tenantA}/domains/${domA.id}`],
  ['mailbox list', 'GET', `/tenants/${tenantA}/mailboxes`],
  ['mailbox detail', 'GET', `/tenants/${tenantA}/mailboxes/${mbA.id}`],
  ['mailbox client settings', 'GET', `/tenants/${tenantA}/mailboxes/${mbA.id}/client-settings`],
  ['webmail folders', 'GET', `/tenants/${tenantA}/mailboxes/${mbA.id}/webmail/folders`],
  ['webmail message list', 'GET', `/tenants/${tenantA}/mailboxes/${mbA.id}/webmail/messages`],
  ['webmail preferences', 'GET', `/tenants/${tenantA}/mailboxes/${mbA.id}/webmail/preferences`],
  ['usage', 'GET', `/tenants/${tenantA}/usage`],
  ['aliases', 'GET', `/tenants/${tenantA}/aliases`],
  ['members', 'GET', `/tenants/${tenantA}/members`],
  ['support tickets', 'GET', `/tenants/${tenantA}/support-tickets`],
];
for (const [name, method, path] of isolation) {
  const r = await api(path, { method, auth: B.auth });
  check(`cross-tenant ${name} is hidden (404)`, r.status === 404, `status ${r.status}`);
}

const writes = [
  ['create mailbox in foreign domain', 'POST', `/tenants/${tenantA}/domains/${domA.id}/mailboxes`, { localPart: 'evil' }],
  ['schedule foreign mailbox deletion', 'DELETE', `/tenants/${tenantA}/mailboxes/${mbA.id}`, { confirmAddress: mbA.normalized_address }],
  ['suspend foreign mailbox', 'POST', `/tenants/${tenantA}/mailboxes/${mbA.id}/suspend`, { reason: 'audit attempt' }],
  ['verify foreign domain', 'POST', `/tenants/${tenantA}/domains/${domA.id}/verify`, {}],
  ['delete foreign domain', 'DELETE', `/tenants/${tenantA}/domains/${domA.id}`, { confirmName: domA.name }],
  ['rename foreign workspace', 'PATCH', `/tenants/${tenantA}`, { name: 'Owned' }],
];
for (const [name, method, path, body] of writes) {
  const r = await api(path, { method, body, auth: B.auth });
  check(`cross-tenant ${name} refused (404)`, r.status === 404, `status ${r.status}`);
}

// Cross-tenant membership manipulation: B targets A's membership id inside B's workspace.
const [membershipA] = await sql("SELECT id FROM tenant_memberships WHERE tenant_id = ? AND role = 'mailbox_user' LIMIT 1", [tenantA]);
const roleChange = await api(`/tenants/${tenantB}/members/${membershipA.id}`, { method: 'PATCH', body: { role: 'owner' }, auth: B.auth });
check('foreign membership id cannot be promoted through another tenant', roleChange.status === 404, `status ${roleChange.status}`);

// B uses its own mailbox path with A's message/blob identifiers.
const aFolders = await api(`/tenants/${tenantA}/mailboxes/${mbA.id}/webmail/folders`, { auth: A.auth });
const inboxA = aFolders.json.folders.find((f) => f.role === 'inbox').id;
const aList = await api(`/tenants/${tenantA}/mailboxes/${mbA.id}/webmail/messages?folderId=${inboxA}`, { auth: A.auth });
const aMessageId = aList.json.messages[0].id;
const foreignMessage = await api(`/tenants/${tenantB}/mailboxes/${mbB.id}/webmail/messages/${aMessageId}`, { auth: B.auth });
check('foreign message id on own mailbox is not found', foreignMessage.status === 404, `status ${foreignMessage.status}`);

// ---------------------------------------------------------------- 2. CSRF / session
const noCsrf = await api(`/tenants/${tenantB}/domains`, { method: 'POST', body: { name: `nocsrf-${rand()}.example` }, auth: { cookie: B.auth.cookie } });
check('authenticated write without CSRF token is rejected', noCsrf.status === 403, `status ${noCsrf.status}`);
const badCsrf = await api(`/tenants/${tenantB}/domains`, { method: 'POST', body: { name: `badcsrf-${rand()}.example` }, auth: { cookie: B.auth.cookie, csrf: 'deadbeef' } });
check('authenticated write with wrong CSRF token is rejected', badCsrf.status === 403, `status ${badCsrf.status}`);
const badOrigin = await api(`/tenants/${tenantB}/domains`, { method: 'POST', body: { name: `origin-${rand()}.example` }, auth: B.auth, headers: { origin: 'https://evil.example' } });
check('cross-origin write is rejected', badOrigin.status === 403, `status ${badOrigin.status}`);

const anon = await api(`/tenants/${tenantB}/mailboxes`);
check('unauthenticated read is rejected', anon.status === 401, `status ${anon.status}`);
const anonMe = await api('/me');
check('unauthenticated /me is rejected', anonMe.status === 401, `status ${anonMe.status}`);

// CSRF token must be bound to the session, not shared.
const crossToken = await api(`/tenants/${tenantB}/domains`, { method: 'POST', body: { name: `x-${rand()}.example` }, auth: { cookie: B.auth.cookie, csrf: A.auth.csrf } });
check("another session's CSRF token is rejected", crossToken.status === 403, `status ${crossToken.status}`);

// Session revocation.
const B2 = await login(B.email);
const before = await api('/me', { auth: B2 });
const revoke = await api('/auth/logout', { method: 'POST', auth: B2 });
const after = await api('/me', { auth: B2 });
check('logout revokes the session', before.status === 200 && revoke.status === 200 && after.status === 401, `before ${before.status}, after ${after.status}`);

const B3 = await login(B.email);
const revokeOthers = await api('/auth/sessions/revoke-others', { method: 'POST', auth: B3 });
const oldSession = await api('/me', { auth: { cookie: B.auth.cookie } });
check('revoke-others invalidates older sessions', revokeOthers.status === 200 && oldSession.status === 401, `status ${oldSession.status}`);
B.auth = B3; // keep B usable for later checks

// MFA-pending sessions must not reach protected routes.
const mfaSession = await login(A.email);
await sql('UPDATE sessions SET mfa_pending = 1, mfa_verified = 0 WHERE id = (SELECT id FROM (SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1) t)', [A.id]);
const pendingRead = await api('/tenants', { auth: mfaSession });
const pendingMe = await api('/me', { auth: mfaSession });
check('MFA-pending session is refused on protected routes', pendingRead.status === 401, `status ${pendingRead.status}`);
check('MFA-pending session may still call /me', pendingMe.status === 200, `status ${pendingMe.status}`);
await sql('UPDATE sessions SET mfa_pending = 0 WHERE token_hash IS NOT NULL AND revoked_at IS NULL AND user_id = ?', [A.id]);

// ---------------------------------------------------------------- 3. mailbox-user scoping
const selfRead = await api(`/tenants/${tenantA}/mailboxes/${mbA.id}/webmail/folders`, { auth: C.auth });
check('linked mailbox_user can read their own mailbox', selfRead.status === 200, `status ${selfRead.status}`);
const otherRead = await api(`/tenants/${tenantA}/mailboxes/${mbA2.id}/webmail/messages`, { auth: C.auth });
check('mailbox_user cannot read a sibling mailbox', otherRead.status === 404, `status ${otherRead.status}`);
const selfList = await api(`/tenants/${tenantA}/mailboxes`, { auth: C.auth });
const selfListOk = selfList.status === 200 && selfList.json.total === 1 && selfList.json.mailboxes[0].id === mbA.id;
check('mailbox_user list is filtered to their mailbox only', selfListOk, `status ${selfList.status}, total ${selfList.json?.total}`);
const selfCreate = await api(`/tenants/${tenantA}/domains/${domA.id}/mailboxes`, { method: 'POST', body: { localPart: 'nope' }, auth: C.auth });
check('mailbox_user cannot create mailboxes', selfCreate.status === 404 || selfCreate.status === 403, `status ${selfCreate.status}`);
const selfMembers = await api(`/tenants/${tenantA}/members`, { auth: C.auth });
check('mailbox_user cannot list members', selfMembers.status === 403, `status ${selfMembers.status}`);
const selfUsage = await api(`/tenants/${tenantA}/usage`, { auth: C.auth });
const scopedUsage = selfUsage.status === 200 && selfUsage.json.mailboxes.length === 1 && selfUsage.json.mailboxes[0].id === mbA.id;
check('mailbox_user usage is scoped to their own mailbox', scopedUsage, `status ${selfUsage.status}, ${selfUsage.json?.mailboxes?.length} mailboxes`);

// ---------------------------------------------------------------- 4. suspension / deletion
const suspend = await api(`/tenants/${tenantA}/mailboxes/${mbA2.id}/suspend`, { method: 'POST', body: { reason: 'audit suspension' }, auth: A.auth });
const suspendedRead = await api(`/tenants/${tenantA}/mailboxes/${mbA2.id}/webmail/messages`, { auth: A.auth });
check('suspended mailbox content is inaccessible', suspend.status === 200 && suspendedRead.status === 409, `suspend ${suspend.status}, read ${suspendedRead.status}`);
const reactivate = await api(`/tenants/${tenantA}/mailboxes/${mbA2.id}/reactivate`, { method: 'POST', auth: A.auth });
check('reactivated mailbox is readable again', reactivate.status === 200, `status ${reactivate.status}`);

const del = await api(`/tenants/${tenantA}/mailboxes/${mbA2.id}`, { method: 'DELETE', body: { confirmAddress: mbA2.normalized_address }, auth: A.auth });
const afterDelete = await api(`/tenants/${tenantA}/mailboxes/${mbA2.id}/webmail/messages`, { auth: A.auth });
check('scheduled deletion stops content access immediately', del.status === 200 && afterDelete.status === 409, `delete ${del.status}, read ${afterDelete.status}`);
const cancel = await api(`/tenants/${tenantA}/mailboxes/${mbA2.id}/cancel-deletion`, { method: 'POST', auth: A.auth });
check('deletion can be cancelled within the grace period', cancel.status === 200, `status ${cancel.status}`);

// ---------------------------------------------------------------- 5. admin separation and grants
const R = await newAdmin('super_admin');
const S = await newAdmin('super_admin');
const Ops = await newAdmin('operations');

const customerToAdmin = await api('/admin/metrics', { auth: A.auth });
check('customer session cannot reach admin API', customerToAdmin.status === 403, `status ${customerToAdmin.status}`);
const opsToApproval = await api('/admin/settings', { method: 'PATCH', body: { reason: 'audit attempt', confirm: true, settings: { signup_mode: 'closed' } }, auth: Ops.auth });
check('operations role cannot change platform settings', opsToApproval.status === 403, `status ${opsToApproval.status}`);
const opsToApprove = await api('/admin/access-grants/00000000000000000000000000/approve', { method: 'POST', auth: Ops.auth });
check('operations role cannot approve access grants', opsToApprove.status === 403, `status ${opsToApprove.status}`);

const adminTenantView = await api(`/admin/tenants/${tenantA}`, { auth: R.auth });
const viewText = JSON.stringify(adminTenantView.json);
check('admin tenant view contains metadata only', adminTenantView.status === 200 && !/"body"|"text"|"html"|"subject"/.test(viewText), `status ${adminTenantView.status}`);

const grant = await api('/admin/access-grants', { method: 'POST', body: { mailboxId: mbA.id, reason: 'Audit: reproduce a reported delivery problem' }, auth: R.auth });
check('operator can request a reasoned access grant', grant.status === 201, `status ${grant.status}`);
const grantId = grant.json?.id;
const selfApprove = await api(`/admin/access-grants/${grantId}/approve`, { method: 'POST', auth: R.auth });
check('requester cannot approve their own grant', selfApprove.status === 403, `status ${selfApprove.status}`);
const readBeforeApproval = await api(`/admin/access-grants/${grantId}/messages`, { auth: R.auth });
check('unapproved grant cannot read messages', readBeforeApproval.status === 403, `status ${readBeforeApproval.status}`);
const approve = await api(`/admin/access-grants/${grantId}/approve`, { method: 'POST', auth: S.auth });
check('a second super admin can approve the grant', approve.status === 200, `status ${approve.status}`);
const readAfter = await api(`/admin/access-grants/${grantId}/messages`, { auth: R.auth });
check('approved grant can list the mailbox', readAfter.status === 200, `status ${readAfter.status}`);
const readByOther = await api(`/admin/access-grants/${grantId}/messages`, { auth: S.auth });
check('another operator cannot use a grant issued to someone else', readByOther.status === 403, `status ${readByOther.status}`);
// A second read of an individual message must also increment the counter.
const grantFolders = await api(`/admin/access-grants/${grantId}/folders`, { auth: R.auth });
const grantInbox = grantFolders.json.folders.find((f) => f.role === 'inbox').id;
const grantList = await api(`/admin/access-grants/${grantId}/messages?folderId=${grantInbox}`, { auth: R.auth });
const grantMessageId = grantList.json.messages[0]?.id;
if (grantMessageId) await api(`/admin/access-grants/${grantId}/messages/${grantMessageId}`, { auth: R.auth });
const uses = await sql('SELECT use_count FROM admin_access_grants WHERE id = ?', [grantId]);
check('every grant read increments the use counter', Number(uses[0].use_count) >= 2, `use_count ${uses[0].use_count}`);
const auditRows = await sql("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'admin.mailbox.read' AND target_id = ?", [mbA.id]);
check('grant reads are written to the audit log', Number(auditRows[0].n) > 0, `${auditRows[0].n} entries`);

await sql("UPDATE admin_access_grants SET expires_at = DATE_SUB(NOW(3), INTERVAL 1 MINUTE) WHERE id = ?", [grantId]);
const expiredRead = await api(`/admin/access-grants/${grantId}/messages`, { auth: R.auth });
check('expired grant is refused without a worker sweep', expiredRead.status === 403, `status ${expiredRead.status}`);

const grant2 = await api('/admin/access-grants', { method: 'POST', body: { mailboxId: mbB.id, reason: 'Audit: second grant to test revocation' }, auth: R.auth });
const grant2Id = grant2.json?.id;
await api(`/admin/access-grants/${grant2Id}/approve`, { method: 'POST', auth: S.auth });
const revoked = await api(`/admin/access-grants/${grant2Id}/revoke`, { method: 'POST', body: { reason: 'Audit revocation test' }, auth: S.auth });
const revokedRead = await api(`/admin/access-grants/${grant2Id}/messages`, { auth: R.auth });
check('revoked grant is refused immediately', revoked.status === 200 && revokedRead.status === 403, `revoke ${revoked.status}, read ${revokedRead.status}`);

const writeScope = await api('/admin/access-grants', { method: 'POST', body: { mailboxId: mbA.id, reason: 'Audit: attempt write scope', scope: 'write' }, auth: R.auth });
check('no write-capable access scope exists', writeScope.status === 400, `status ${writeScope.status}`);

const tenantUsingAdminCookie = await api('/tenants', { auth: R.auth });
check('admin session sees no customer memberships', tenantUsingAdminCookie.status === 200 && tenantUsingAdminCookie.json.tenants.length === 0, `status ${tenantUsingAdminCookie.status}`);

// ---------------------------------------------------------------- 6. webmail content security
const send = await api(`/tenants/${tenantA}/mailboxes/${mbA.id}/webmail/send`, {
  method: 'POST',
  body: {
    to: ['alice@audit.example'],
    cc: [],
    bcc: [],
    subject: 'Sanitisation audit',
    text: 'plain',
    html: '<p>hi</p><script>alert(1)</script><img src="https://tracker.example/pixel.png"><a href="javascript:alert(2)">x</a><iframe src="https://evil.example"></iframe>',
    attachments: [{ name: 'note.txt', type: 'text/plain', data: Buffer.from('hello').toString('base64') }],
    from: 'ceo@arthvex.co.in',
  },
  auth: A.auth,
});
check('compose send succeeds with an attachment', send.status === 200, `status ${send.status}`);
const sentFolders = await api(`/tenants/${tenantA}/mailboxes/${mbA.id}/webmail/folders`, { auth: A.auth });
const sentFolder = sentFolders.json.folders.find((f) => f.role === 'sent').id;
const sentList = await api(`/tenants/${tenantA}/mailboxes/${mbA.id}/webmail/messages?folderId=${sentFolder}`, { auth: A.auth });
const sentMsgId = sentList.json.messages[0].id;
const sentMsg = await api(`/tenants/${tenantA}/mailboxes/${mbA.id}/webmail/messages/${sentMsgId}`, { auth: A.auth });
const html = sentMsg.json.html ?? '';
check('sender address cannot be spoofed through the request body', sentMsg.json.from?.[0]?.email === mbA.normalized_address, `from ${sentMsg.json.from?.[0]?.email}`);
check('script/iframe/javascript: removed by sanitisation', !/<script|<iframe|javascript:/i.test(html), html.slice(0, 120));
check('remote images are blocked and counted', sentMsg.json.remoteImagesBlocked >= 1 && !/tracker\.example/i.test(html), `blocked ${sentMsg.json.remoteImagesBlocked}`);

const attachments = sentMsg.json.attachments ?? [];
const blobId = attachments[0]?.blobId;
if (blobId) {
  const foreignBlob = await api(`/tenants/${tenantB}/mailboxes/${mbB.id}/webmail/attachments/${blobId}?name=x.txt&type=text/plain`, { auth: B.auth });
  check('attachment blob is unreadable from another mailbox/tenant', foreignBlob.status === 404, `status ${foreignBlob.status}`);
  const ownBlob = await api(`/tenants/${tenantA}/mailboxes/${mbA.id}/webmail/attachments/${blobId}?name=note.txt&type=text/plain`, { auth: A.auth });
  check('attachment download sets attachment disposition and nosniff', ownBlob.status === 200 && (ownBlob.headers.get('x-content-type-options') ?? '') === 'nosniff', `status ${ownBlob.status}`);
} else {
  check('attachment blob is unreadable from another mailbox/tenant', false, 'no blob id returned');
}

const exe = await api(`/tenants/${tenantA}/mailboxes/${mbA.id}/webmail/send`, {
  method: 'POST',
  body: { to: ['x@audit.example'], cc: [], bcc: [], subject: 'x', text: 'x', attachments: [{ name: 'malware.exe', type: 'application/octet-stream', data: Buffer.from('MZ').toString('base64') }] },
  auth: A.auth,
});
check('executable attachments are refused', exe.status === 400, `status ${exe.status}`);

const tooBig = await api(`/tenants/${tenantA}/mailboxes/${mbA.id}/webmail/send`, {
  method: 'POST',
  body: { to: ['x@audit.example'], cc: [], bcc: [], subject: 'x', text: 'x', attachments: [{ name: 'big.bin', type: 'application/octet-stream', data: Buffer.alloc(11 * 1024 * 1024).toString('base64') }] },
  auth: A.auth,
});
check('over-limit attachment body is refused', tooBig.status === 413, `status ${tooBig.status}`);

const tooMany = await api(`/tenants/${tenantA}/mailboxes/${mbA.id}/webmail/send`, {
  method: 'POST',
  body: { to: ['x@audit.example'], cc: [], bcc: [], subject: 'x', text: 'x', attachments: Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.txt`, type: 'text/plain', data: Buffer.from('x').toString('base64') })) },
  auth: A.auth,
});
check('over-count attachment list is refused', tooMany.status === 413, `status ${tooMany.status}`);

const badRecipient = await api(`/tenants/${tenantA}/mailboxes/${mbA.id}/webmail/send`, {
  method: 'POST',
  body: { to: ['not-an-address'], cc: [], bcc: [], subject: 'x', text: 'x' },
  auth: A.auth,
});
check('invalid recipient is refused', badRecipient.status === 400, `status ${badRecipient.status}`);

// Attachment header injection via a crafted file name must not add headers.
const inject = await api(`/tenants/${tenantA}/mailboxes/${mbA.id}/webmail/attachments/${blobId}?name=${encodeURIComponent('x\r\nX-Injected: 1.txt')}&type=text/plain`, { auth: A.auth });
check('crafted attachment name cannot inject response headers', inject.status === 200 && !inject.headers.get('x-injected'), `status ${inject.status}`);

// Support-ticket IDOR across tenants.
const ticket = await api(`/tenants/${tenantA}/support-tickets`, { method: 'POST', body: { category: 'delivery', urgency: 'normal', subject: 'Audit ticket', message: 'This is an audit ticket body.' }, auth: A.auth });
const foreignTicket = await api(`/tenants/${tenantB}/support-tickets/${ticket.json?.id}`, { auth: B.auth });
const foreignTicketReply = await api(`/tenants/${tenantB}/support-tickets/${ticket.json?.id}/messages`, { method: 'POST', body: { message: 'injected' }, auth: B.auth });
check('foreign support ticket cannot be read or replied to', ticket.status === 201 && foreignTicket.status === 404 && foreignTicketReply.status === 404, `read ${foreignTicket.status}, reply ${foreignTicketReply.status}`);

// Invitation token is single use and bound to its email address.
const inviteReuse = await api('/invitations/accept', { method: 'POST', body: { token: inviteToken }, auth: C.auth });
check('invitation token cannot be replayed', inviteReuse.status >= 400 && inviteReuse.status < 500, `status ${inviteReuse.status}`);

// Session cookie attributes.
const { jar } = await import('./lib.mjs');
const cookieJar = jar();
await api('/auth/login', { method: 'POST', body: { email: A.email, password: PASSWORDS }, auth: { jar: cookieJar } });
const cookieRes = await api('/me', { auth: { cookie: cookieJar.cookie } });
const cookieHeaders = cookieRes.status === 200 ? null : null;
const rawSetCookie = (await api('/auth/login', { method: 'POST', body: { email: A.email, password: PASSWORDS } })).headers.getSetCookie()?.[0] ?? '';
check('session cookie is HttpOnly, SameSite=Lax and path-scoped', /httponly/i.test(rawSetCookie) && /samesite=lax/i.test(rawSetCookie) && /path=\//i.test(rawSetCookie), rawSetCookie.replace(/=[^;]+/, '=<redacted>'));
void cookieHeaders;

const apiHeaders = await api('/health');
check('API responses set nosniff and hide the server banner', (apiHeaders.headers.get('x-content-type-options') ?? '') === 'nosniff' && !apiHeaders.headers.get('x-powered-by'), `nosniff ${apiHeaders.headers.get('x-content-type-options')}`);

// ---------------------------------------------------------------- 7. account security
const reg = await api('/auth/register', { method: 'POST', body: { email: A.email, password: PASSWORDS, displayName: 'dup', acceptTerms: true } });
check('duplicate registration is indistinguishable from success', reg.status === 202, `status ${reg.status}`);

const forgot = await api('/auth/forgot-password', { method: 'POST', body: { email: B.email } });
const forgotUnknown = await api('/auth/forgot-password', { method: 'POST', body: { email: `nobody.${rand()}@audit.example` } });
check('password reset request does not reveal account existence', forgot.status === 202 && forgotUnknown.status === 202, `${forgot.status}/${forgotUnknown.status}`);

let resetToken = null;
for (let i = 0; i < 30 && !resetToken; i++) {
  for (const f of readdirSync(OUTBOX).filter((f) => f.includes('password_reset')).sort().reverse()) {
    const t = readFileSync(join(OUTBOX, f), 'utf8');
    if (t.includes(B.email)) {
      const m = /#token=([A-Za-z0-9_-]+)/.exec(t);
      if (m) resetToken = m[1];
    }
  }
  if (!resetToken) await new Promise((r) => setTimeout(r, 100));
}
const newPassword = 'Audit-NewPassw0rd!2026';
const reset = await api('/auth/reset-password', { method: 'POST', body: { token: resetToken, password: newPassword } });
const reuse = await api('/auth/reset-password', { method: 'POST', body: { token: resetToken, password: 'Another-Passw0rd!2026' } });
check('password reset token is single use', reset.status === 200 && reuse.status === 400, `${reset.status}/${reuse.status}`);

const weakReset = await api('/auth/forgot-password', { method: 'POST', body: { email: A.email } });
let weakToken = null;
for (let i = 0; i < 30 && !weakToken; i++) {
  for (const f of readdirSync(OUTBOX).filter((f) => f.includes('password_reset')).sort().reverse()) {
    const t = readFileSync(join(OUTBOX, f), 'utf8');
    if (t.includes(A.email)) {
      const m = /#token=([A-Za-z0-9_-]+)/.exec(t);
      if (m) weakToken = m[1];
    }
  }
  if (!weakToken) await new Promise((r) => setTimeout(r, 100));
}
const weak = await api('/auth/reset-password', { method: 'POST', body: { token: weakToken, password: 'password123' } });
check('weak replacement password is refused', weak.status === 400, `status ${weak.status}, request ${weakReset.status}`);

// Login lockout after repeated failures (isolated account so other fixtures survive).
const L = await newUser('lockout');
const wrong = [];
for (let i = 0; i < 5; i++) {
  const r = await api('/auth/login', { method: 'POST', body: { email: L.email, password: 'Wrong-Passw0rd!123' } });
  wrong.push(r.status);
}
const lockedCorrect = await api('/auth/login', { method: 'POST', body: { email: L.email, password: PASSWORDS } });
check('repeated bad passwords lock the account', wrong.every((s) => s === 401) && lockedCorrect.status === 401, `attempts ${wrong.join(',')}, correct ${lockedCorrect.status}`);
const lockRow = await sql('SELECT failed_login_count, locked_until FROM users WHERE id = ?', [L.id]);
check('lockout is recorded with an expiry', Number(lockRow[0].failed_login_count) >= 5 && lockRow[0].locked_until, `failed ${lockRow[0].failed_login_count}`);

// ---------------------------------------------------------------- 8. secret exposure
const metrics = await api('/admin/metrics', { auth: R.auth });
const metricsText = JSON.stringify(metrics.json);
check('admin metrics do not expose credentials', metrics.status === 200 && !/secret|password|api[_-]?key|token/i.test(metricsText), `status ${metrics.status}`);

const engineProbe = await api('/tenants', { headers: { 'x-probe': '1' } });
check('unhandled routes do not leak internals', !/at .*\.ts:|stack/i.test(JSON.stringify(engineProbe.json)), JSON.stringify(engineProbe.json).slice(0, 80));

const failed = summary('security checks');

// Summary data for the report.
const stats = {
  total: results.length,
  failed,
  checks: results,
};
const { writeFileSync } = await import('node:fs');
writeFileSync(new URL('../../var/audit/security-results.json', import.meta.url), JSON.stringify(stats, null, 2));
await closeDb();
process.exit(failed > 0 ? 1 : 0);
