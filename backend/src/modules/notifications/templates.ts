/** Plain-text transactional email templates. Links carry tokens in the URL fragment so they never reach server logs. */

export const templates = {
  verifyEmail: (baseUrl: string, token: string) => ({
    subject: 'Verify your ARTHVEX email address',
    text: `Welcome to ARTHVEX Email Hosting.\n\nConfirm your login email by opening this link (valid for 24 hours):\n\n${baseUrl}/verify-email#token=${token}\n\nIf you did not create an account, you can ignore this message.`,
  }),
  accountExists: (baseUrl: string) => ({
    subject: 'Someone tried to register with your email address',
    text: `Someone tried to create an ARTHVEX account with this email address, but an account already exists.\n\nIf this was you, sign in at ${baseUrl}/login or reset your password at ${baseUrl}/forgot-password.\n\nIf it was not you, no action is needed.`,
  }),
  passwordReset: (baseUrl: string, token: string) => ({
    subject: 'Reset your ARTHVEX password',
    text: `A password reset was requested for your ARTHVEX account.\n\nOpen this link within 30 minutes to choose a new password:\n\n${baseUrl}/reset-password#token=${token}\n\nIf you did not request this, ignore this message — your password has not changed.`,
  }),
  passwordChanged: () => ({
    subject: 'Your ARTHVEX password was changed',
    text: 'The password for your ARTHVEX account was just changed and all other sessions were signed out.\n\nIf you did not do this, reset your password immediately and contact support.',
  }),
  newLogin: (ip: string, ua: string) => ({
    subject: 'New sign-in to your ARTHVEX account',
    text: `A new sign-in to your account occurred.\n\nIP address: ${ip}\nDevice: ${ua.slice(0, 120)}\n\nIf this was not you, change your password and revoke unknown sessions in Security settings.`,
  }),
  mfaChanged: (enabled: boolean) => ({
    subject: `Two-factor authentication ${enabled ? 'enabled' : 'disabled'}`,
    text: `Two-factor authentication was ${enabled ? 'enabled' : 'disabled'} on your ARTHVEX account.\n\nIf you did not do this, contact support immediately.`,
  }),
  tenantInvitation: (baseUrl: string, tenantName: string, role: string, token: string) => ({
    subject: `You have been invited to ${tenantName} on ARTHVEX`,
    text: `You have been invited to join the workspace "${tenantName}" as ${role}.\n\nAccept the invitation (valid for 7 days):\n\n${baseUrl}/accept-invitation#token=${token}\n\nYou will need to sign in or register with this email address.`,
  }),
  signupInvitation: (baseUrl: string, token: string) => ({
    subject: 'Your invitation to ARTHVEX Email Hosting',
    text: `You have been invited to ARTHVEX Email Hosting.\n\nRegister using this link (valid for 14 days):\n\n${baseUrl}/register#invite=${token}\n\nLimits and the absence of an SLA are described at ${baseUrl}/limitations.`,
  }),
  forwardingConfirmation: (baseUrl: string, source: string, token: string) => ({
    subject: `Confirm forwarding from ${source}`,
    text: `The owner of ${source} asked to forward messages to this address through ARTHVEX Email Hosting.\n\nForwarding will only start if you confirm (link valid for 7 days):\n\n${baseUrl}/confirm-forwarding#token=${token}\n\nIf you do not recognise this request, ignore this message and nothing will be forwarded.`,
  }),
};
