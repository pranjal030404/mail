import { Navigate, Route, Routes } from 'react-router-dom';
import { Notifications, Profile, Security } from './Account';
import Aliases from './Aliases';
import Domains from './Domains';
import Mailboxes from './Mailboxes';
import Members from './Members';
import Overview from './Overview';
import { Clients, SupportRoutes } from './Support';
import { NeedsWorkspace } from './shared';
import Usage from './Usage';
import Webmail from './Webmail';

export default function Dashboard() {
  return (
    <Routes>
      <Route index element={<Overview />} />
      <Route path="webmail" element={<NeedsWorkspace><Webmail /></NeedsWorkspace>} />
      <Route path="domains/*" element={<NeedsWorkspace><Domains /></NeedsWorkspace>} />
      <Route path="mailboxes/*" element={<NeedsWorkspace><Mailboxes /></NeedsWorkspace>} />
      <Route path="aliases" element={<NeedsWorkspace><Aliases /></NeedsWorkspace>} />
      <Route path="usage" element={<NeedsWorkspace><Usage /></NeedsWorkspace>} />
      <Route path="members" element={<NeedsWorkspace><Members /></NeedsWorkspace>} />
      <Route path="clients" element={<NeedsWorkspace><Clients /></NeedsWorkspace>} />
      <Route path="support/*" element={<NeedsWorkspace><SupportRoutes /></NeedsWorkspace>} />
      <Route path="security" element={<Security />} />
      <Route path="notifications" element={<Notifications />} />
      <Route path="profile" element={<Profile />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
