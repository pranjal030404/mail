// Live feature coverage beyond the security suite: aliases, DNS diagnostics, usage history,
// notifications, abuse intake, domain removal impact and admin read endpoints.
import { api, check, closeDb, newAdmin, newMailbox, newUser, newVerifiedDomain, newWorkspace, results, sql, summary } from './lib.mjs';

const user = await newUser('features');
const ws = await newWorkspace(user, 'Feature Tenant');
const tenantId = ws.id ?? ws.tenant?.id;
const domain = await newVerifiedDomain(user, tenantId);
const box = await newMailbox(user, tenantId, domain.id, 'owner');

const waitAlias = async (id) => {
  for (let i = 0; i < 100; i++) {
    const [a] = await sql('SELECT status, source_address FROM aliases WHERE id = ?', [id]);
    if (a && (a.status === 'active' || a.status === 'failed')) return a;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
};

const alias = await api(`/tenants/${tenantId}/domains/${domain.id}/aliases`, { method: 'POST', body: { localPart: 'support', destinationMailboxId: box.id }, auth: user.auth });
const aliasRow = alias.status === 201 ? await waitAlias(alias.json.id) : null;
check('alias can be created and reaches the mail engine', alias.status === 201 && aliasRow?.status === 'active', `create ${alias.status}, state ${aliasRow?.status}`);

const aliasList = await api(`/tenants/${tenantId}/aliases`, { auth: user.auth });
check('alias list shows the created alias', aliasList.status === 200 && aliasList.json.aliases.some((a) => a.source === aliasRow?.source_address), `${aliasList.json?.aliases?.length} aliases`);

const dupAlias = await api(`/tenants/${tenantId}/domains/${domain.id}/aliases`, { method: 'POST', body: { localPart: 'support', destinationMailboxId: box.id }, auth: user.auth });
check('duplicate alias is refused', dupAlias.status === 409 || dupAlias.status === 400, `status ${dupAlias.status}`);

const external = await api(`/tenants/${tenantId}/domains/${domain.id}/aliases`, { method: 'POST', body: { localPart: 'outside', externalAddress: 'someone@elsewhere.example' }, auth: user.auth });
check('external forwarding is gated by plan policy', external.status === 403, `status ${external.status}`);

const removeAlias = await api(`/tenants/${tenantId}/aliases/${alias.json.id}`, { method: 'DELETE', auth: user.auth });
check('alias deletion is accepted', removeAlias.status === 200, `status ${removeAlias.status}`);

const dnsCheck = await api(`/tenants/${tenantId}/domains/${domain.id}/dns-check`, { method: 'POST', auth: user.auth });
check('DNS diagnostics return record statuses', dnsCheck.status === 200 && typeof dnsCheck.json.inboundStatus === 'string' && dnsCheck.json.checks.length >= 4, `status ${dnsCheck.status}, inbound ${dnsCheck.json?.inboundStatus}, ${dnsCheck.json?.checks?.length} records`);
const failClosed = dnsCheck.json?.inboundStatus !== 'ok' && dnsCheck.json?.outboundStatus !== 'ok';
check('unpublished DNS is reported as not ready rather than assumed healthy', failClosed, `inbound ${dnsCheck.json?.inboundStatus}, outbound ${dnsCheck.json?.outboundStatus}`);

const impact = await api(`/tenants/${tenantId}/domains/${domain.id}/removal-impact`, { auth: user.auth });
check('domain removal impact is available before deletion', impact.status === 200, `status ${impact.status}`);

const usage = await api(`/tenants/${tenantId}/usage`, { auth: user.auth });
check('usage reports mailbox quota and allocated storage', usage.status === 200 && usage.json.mailboxes.length === 1 && usage.json.storage.allocatedBytes > 0, `mailboxes ${usage.json?.mailboxes?.length}`);
const history = await api(`/tenants/${tenantId}/usage/history?days=30`, { auth: user.auth });
check('usage history endpoint responds', history.status === 200 && Array.isArray(history.json.history), `rows ${history.json?.history?.length}`);

const client = await api(`/tenants/${tenantId}/mailboxes/${box.id}/client-settings`, { auth: user.auth });
check('client settings advertise IMAP/SMTP and flag simulations', client.status === 200 && client.json.imap?.host && 'simulated' in client.json, `imap ${client.json?.imap?.host}`);

const abuse = await api('/abuse-reports', { method: 'POST', body: { category: 'spam', summary: 'Audit: please ignore this test report.', reportedAddress: box.normalized_address } });
check('public abuse intake accepts a report', abuse.status === 202, `status ${abuse.status}`);

await api(`/tenants/${tenantId}/support-tickets`, { method: 'POST', body: { category: 'delivery', urgency: 'normal', subject: 'Audit ticket', message: 'Please check the audit ticket.' }, auth: user.auth });
const notes = await api('/notifications', { auth: user.auth });
const readAll = await api('/notifications/read-all', { method: 'POST', auth: user.auth });
check('notifications can be listed and marked read', notes.status === 200 && readAll.status === 200, `notifications ${notes.json?.notifications?.length}`);

const admin = await newAdmin('super_admin');
const plans = await api('/admin/plans', { auth: admin.auth });
check('admin can read the plan catalogue', plans.status === 200 && plans.json.plans.length >= 2, `${plans.json?.plans?.length} plans`);
const tickets = await api('/admin/support-tickets', { auth: admin.auth });
check('admin support queue lists open tickets', tickets.status === 200 && tickets.json.tickets.length >= 1, `${tickets.json?.tickets?.length} tickets`);
const reports = await api('/admin/abuse-reports', { auth: admin.auth });
check('admin abuse queue lists the new report', reports.status === 200 && reports.json.reports.length >= 1, `${reports.json?.reports?.length} reports`);

const mailboxSearch = await api(`/admin/mailboxes?q=${encodeURIComponent(box.normalized_address.split('@')[0])}`, { auth: admin.auth });
check('admin mailbox search returns metadata without content', mailboxSearch.status === 200 && mailboxSearch.json.mailboxes.some((m) => m.address === box.normalized_address), `${mailboxSearch.json?.mailboxes?.length} matches`);

// Regression guard: the admin tenant status filter must not be dropped from the query.
const activeTenants = await api('/admin/tenants?status=active', { auth: admin.auth });
const closedTenants = await api('/admin/tenants?status=closed', { auth: admin.auth });
check(
  'admin tenant list honours the status filter',
  activeTenants.status === 200 && activeTenants.json.tenants.every((t) => t.status === 'active') && closedTenants.json.tenants.every((t) => t.status === 'closed'),
  `active ${activeTenants.json?.tenants?.length}, closed ${closedTenants.json?.tenants?.length}`,
);

const failed = summary('feature checks');
const { writeFileSync } = await import('node:fs');
writeFileSync(new URL('../../var/audit/feature-results.json', import.meta.url), JSON.stringify({ results, failed }, null, 2));
await closeDb();
process.exit(failed > 0 ? 1 : 0);
