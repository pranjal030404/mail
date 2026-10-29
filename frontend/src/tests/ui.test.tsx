import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { ConfirmDialog, ProgressBar, StatusBadge, TextField } from '../components/ui';
import { api, ApiError, setCsrfToken } from '../lib/api';
import { AuthProvider } from '../lib/auth';
import { formatBytes } from '../lib/format';

type FetchMock = ReturnType<typeof vi.fn>;
let fetchMock: FetchMock;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  setCsrfToken('');
});

describe('api client', () => {
  it('sends the CSRF token on requests and JSON bodies', async () => {
    fetchMock.mockResolvedValue(json(200, { ok: true }));
    setCsrfToken('tok123');
    await api('POST', '/x', { a: 1 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/x');
    expect(init.headers['x-csrf-token']).toBe('tok123');
    expect(init.credentials).toBe('same-origin');
    expect(init.body).toBe('{"a":1}');
  });

  it('turns API error bodies into ApiError with code and correlation id', async () => {
    fetchMock.mockResolvedValue(json(409, { error: { code: 'domain_claimed', message: 'Already registered', correlationId: 'abc' } }));
    await expect(api('GET', '/x')).rejects.toMatchObject({ status: 409, code: 'domain_claimed', message: 'Already registered', correlationId: 'abc' });
  });

  it('reports network failure with a friendly message and non-JSON errors safely', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(api('GET', '/x')).rejects.toMatchObject({ code: 'network' });
    fetchMock.mockResolvedValueOnce(new Response('<html>502</html>', { status: 502 }));
    const err = (await api('GET', '/x').catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).not.toContain('<html>');
  });
});

describe('components', () => {
  it('ConfirmDialog keeps the destructive button disabled until the exact text and a reason are given', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<ConfirmDialog open title="Delete" confirmLabel="Delete it" typeToConfirm="acme.com" askReason onCancel={() => {}} onConfirm={onConfirm}>body</ConfirmDialog>);
    const btn = screen.getByRole('button', { name: 'Delete it', hidden: true });
    expect(btn).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Type “acme.com”/, { selector: 'input' }), 'acme.co');
    expect(btn).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Type “acme.com”/), 'm');
    await userEvent.type(screen.getByLabelText(/Reason/), 'no longer needed');
    expect(btn).toBeEnabled();
    await userEvent.click(btn);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('no longer needed'));
  });

  it('ConfirmDialog shows server errors instead of closing', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new ApiError(409, 'invalid_state', 'Cannot do that right now.'));
    render(<ConfirmDialog open title="X" confirmLabel="Go" onCancel={() => {}} onConfirm={onConfirm}>b</ConfirmDialog>);
    await userEvent.click(screen.getByRole('button', { name: 'Go', hidden: true }));
    expect(await screen.findByText('Cannot do that right now.')).toBeInTheDocument();
  });

  it('form fields are labelled and expose errors accessibly', () => {
    render(<TextField label="Domain name" error="Invalid domain" />);
    const input = screen.getByLabelText('Domain name');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Invalid domain');
  });

  it('ProgressBar exposes its value and StatusBadge maps statuses to tones', () => {
    render(<><ProgressBar percent={92} label="Storage" /><StatusBadge status="provisioning_failed" /><StatusBadge status="ok" /></>);
    expect(screen.getByRole('progressbar', { name: 'Storage' })).toHaveAttribute('aria-valuenow', '92');
    expect(screen.getByText('provisioning failed')).toHaveClass('badge-bad');
    expect(screen.getByText('ok')).toHaveClass('badge-good');
  });

  it('formats byte sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(100 * 1024 * 1024)).toBe('100 MB');
    expect(formatBytes(null)).toBe('—');
  });
});

function renderApp(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><AuthProvider><App /></AuthProvider></MemoryRouter>);
}

describe('routing and auth', () => {
  it('anonymous visitors to the dashboard are sent to sign-in', async () => {
    fetchMock.mockResolvedValue(json(401, { error: { code: 'unauthenticated', message: 'Sign in to continue.' } }));
    renderApp('/dashboard/mailboxes');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('the public home page makes honest claims (free community software, no SLA, no guarantee)', async () => {
    fetchMock.mockResolvedValue(json(401, { error: { code: 'unauthenticated', message: 'x' } }));
    renderApp('/');
    expect((await screen.findAllByText(/Free and open source/)).length).toBeGreaterThan(0);
    expect(screen.getByText(/no uptime guarantee/i)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/unlimited|guaranteed delivery/i);
  });

  it('shows a login error without revealing which part was wrong', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/me')) return json(401, { error: { code: 'unauthenticated', message: 'x' } });
      return json(401, { error: { code: 'invalid_credentials', message: 'Incorrect email or password.' } });
    });
    renderApp('/login');
    await userEvent.type(await screen.findByLabelText('Email'), 'a@example.test');
    await userEvent.type(screen.getByLabelText('Password'), 'whatever-123456');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Incorrect email or password.')).toBeInTheDocument();
  });

  it('a signed-in customer sees a workspace creation prompt, and non-admins cannot reach /admin', async () => {
    const me = { csrfToken: 'c', mfaPending: false, mfaSetupRequired: false, user: { id: '1', email: 'u@example.test', displayName: 'U', mfaEnabled: false, platformRole: 'none', timezone: 'UTC', locale: 'en' }, memberships: [] };
    fetchMock.mockImplementation(async (url: string) => (url.endsWith('/me') ? json(200, me) : json(200, { notifications: [] })));
    const { unmount } = renderApp('/dashboard');
    expect(await screen.findByText('Create your workspace')).toBeInTheDocument();
    unmount();
    renderApp('/admin/tenants');
    await waitFor(() => expect(screen.getByText('Create your workspace')).toBeInTheDocument());
    expect(screen.queryByText('Tenants')).not.toBeInTheDocument();
  });
});
