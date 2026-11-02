import { ChevronLeft, ChevronRight, Lock } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Alert, Button, ConfirmDialog, EmptyState, Spinner } from '../../components/ui';
import { useAuth } from '../../lib/auth';

export type Row = Record<string, any>;

/** Plain table; loading/empty/error states are handled by the callers around it. */
export function Table({ head, rows, empty = 'Nothing to show.', caption }: { head: string[]; rows: ReactNode[][]; empty?: string; caption?: string }) {
  if (rows.length === 0) return <EmptyState title={empty} />;
  return (
    <div className="table-wrap">
      <table className="responsive-table">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead><tr>{head.map((h, i) => <th key={`${h}-${i}`} scope="col">{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} data-label={head[j]}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  return (
    <nav className="pager" aria-label="Pagination">
      <span className="muted" aria-live="polite">{from}–{Math.min(total, page * pageSize)} of {total}</span>
      <Button small disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page"><ChevronLeft size={14} /></Button>
      <span>Page {page} of {pages}</span>
      <Button small disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page"><ChevronRight size={14} /></Button>
    </nav>
  );
}

/** Sortable column header button. */
export function SortHead({ label, field, sort, dir, onSort }: { label: string; field: string; sort: string; dir: 'asc' | 'desc'; onSort: (f: string) => void }) {
  const active = sort === field;
  return <button type="button" className="sort-btn" onClick={() => onSort(field)} aria-label={`Sort by ${label}${active ? `, currently ${dir}ending` : ''}`}>{label}{active ? (dir === 'asc' ? ' ▲' : ' ▼') : ''}</button>;
}

export function usePermissions() {
  const { me } = useAuth();
  const set = useMemo(() => new Set(me?.user.permissions ?? []), [me]);
  return { has: (p: string) => set.has(p), any: (...ps: string[]) => ps.some((p) => set.has(p)), set };
}

/** Route guard. The API enforces the same rule; this only avoids showing screens that would always fail. */
export function Can({ perm, children }: { perm: string; children: ReactNode }) {
  const { has } = usePermissions();
  if (has(perm)) return <>{children}</>;
  return (
    <div className="page narrow">
      <EmptyState icon={<Lock size={28} aria-hidden />} title="You don’t have access to this page">Your role does not include <code>{perm}</code>. Ask a Super Administrator if you need it.</EmptyState>
    </div>
  );
}

interface Toast { id: number; kind: 'success' | 'error' | 'info'; text: string }
const ToastCtx = createContext<{ push: (text: string, kind?: Toast['kind']) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast['kind'] = 'success') => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, kind, text }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 5000);
  }, []);
  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((t) => <Alert key={t.id} kind={t.kind} onClose={() => setItems((x) => x.filter((y) => y.id !== t.id))}>{t.text}</Alert>)}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx) ?? { push: () => undefined };

/** Dialog helper: every sensitive action collects a reason and sends `confirm: true`. */
export function useSensitive() {
  const [action, setAction] = useState<{ title: string; label: string; danger?: boolean; typed?: string; run: (reason: string) => Promise<unknown>; body?: ReactNode; noReason?: boolean } | null>(null);
  const dialog = (done: () => void) => (
    <ConfirmDialog
      open={!!action}
      title={action?.title ?? ''}
      confirmLabel={action?.label ?? 'Confirm'}
      {...(action?.danger ? { danger: true } : {})}
      {...(action?.typed ? { typeToConfirm: action.typed } : {})}
      askReason={!action?.noReason}
      onCancel={() => setAction(null)}
      onConfirm={async (reason) => { await action!.run(reason); setAction(null); done(); }}
    >
      <div>{action?.body ?? 'This action is recorded in the audit log with your name and the reason below.'}</div>
    </ConfirmDialog>
  );
  return { setAction, dialog };
}

export const LoadingBlock = ({ show }: { show: boolean }) => (show ? <Spinner /> : null);

/** Debounce-free filter bar state helper: values apply on submit, so typing never fires requests. */
export function useFilters<T extends Record<string, string>>(initial: T) {
  const [draft, setDraft] = useState<T>(initial);
  const [applied, setApplied] = useState<T>(initial);
  return { draft, applied, set: (k: keyof T, v: string) => setDraft((d) => ({ ...d, [k]: v })), apply: () => setApplied(draft), reset: () => { setDraft(initial); setApplied(initial); } };
}

export const qs = (o: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};
