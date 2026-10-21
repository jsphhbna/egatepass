import { createGroupedRouter } from '../../server/router.js';
import activity from '../../server/routes/admin/activity.js';
import dashboard from '../../server/routes/admin/dashboard.js';
import devices from '../../server/routes/admin/devices.js';
import emergency from '../../server/routes/admin/emergency.js';
import holds from '../../server/routes/admin/holds.js';
import records from '../../server/routes/admin/records.js';
import retentionMaintenance from '../../server/routes/admin/retention-maintenance.js';
import settings from '../../server/routes/admin/settings.js';
import users from '../../server/routes/admin/users.js';

const router = createGroupedRouter('admin', {
  activity,
  dashboard,
  devices,
  emergency,
  holds,
  records,
  'retention-maintenance': retentionMaintenance,
  settings,
  users,
});

export const { fetch, handleRequest, GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS } = router;
export default { fetch: router.fetch };
