import { Alert, Card, ErrorAlert, PageHeader, ProgressBar, Spinner, StatusBadge } from '../../components/ui';
import { get } from '../../lib/api';
import { formatBytes, formatDate } from '../../lib/format';
import type { Usage as UsageT } from '../../lib/types';
import { useAsync } from '../../lib/useAsync';
import { useTenant } from './shared';

export default function Usage() {
  const { tenantId } = useTenant();
  const q = useAsync(() => get<UsageT>(`/tenants/${tenantId}/usage`), [tenantId]);
  const h = useAsync(() => get<{ history: { date: string; storageBytes: number }[] }>(`/tenants/${tenantId}/usage/history?days=30`).catch(() => ({ history: [] })), [tenantId]);
  const u = q.data;
  return (
    <>
      <PageHeader title="Usage and quotas" subtitle={u ? `Collected ${formatDate(u.collectedAt)}` : undefined} />
      {q.loading && <Spinner />}
      <ErrorAlert error={q.error} onRetry={q.reload} />
      {u && (
        <>
          <Alert kind="info">{u.note} Warnings are sent at 75%, 90% and 100% of a mailbox quota.</Alert>
          <Card title="Plan limits">
            <div className="table-wrap"><table><tbody>
              <tr><th>Domains</th><td>{u.counts.domains} of {u.limits.domains}</td></tr>
              <tr><th>Mailboxes</th><td>{u.counts.mailboxes} of {u.limits.mailboxes}</td></tr>
              <tr><th>Aliases</th><td>{u.counts.aliases} of {u.limits.aliases}</td></tr>
              <tr><th>Storage allocated</th><td>{formatBytes(u.storage.allocatedBytes)} of {formatBytes(u.limits.storageBytes)}<ProgressBar percent={u.storage.allocatedPercent} label="Allocated storage" /></td></tr>
              <tr><th>Daily sending limit</th><td>{u.limits.dailySendLimit} messages per mailbox</td></tr>
              <tr><th>Largest attachment</th><td>{formatBytes(u.limits.attachmentMaxBytes)}</td></tr>
            </tbody></table></div>
          </Card>
          <Card title="Mailboxes">
            <div className="table-wrap"><table>
              <thead><tr><th>Address</th><th>Status</th><th>Used</th><th>Quota</th><th>% full</th></tr></thead>
              <tbody>{u.mailboxes.map((m) => (
                <tr key={m.id}><td>{m.address}</td><td><StatusBadge status={m.status} /></td><td>{formatBytes(m.usedBytes)}</td><td>{formatBytes(m.quotaBytes)}</td>
                  <td style={{ minWidth: 140 }}>{m.percent ?? '—'}%<ProgressBar percent={m.percent ?? 0} label={`${m.address} usage`} /></td></tr>
              ))}</tbody>
            </table></div>
          </Card>
          {h.data && h.data.history.length > 0 && (
            <Card title="Storage over the last 30 days">
              <div className="table-wrap"><table><thead><tr><th>Date</th><th>Total used</th></tr></thead><tbody>{h.data.history.map((r) => <tr key={r.date}><td>{r.date}</td><td>{formatBytes(r.storageBytes)}</td></tr>)}</tbody></table></div>
            </Card>
          )}
        </>
      )}
    </>
  );
}
