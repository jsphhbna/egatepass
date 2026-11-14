import { createGroupedRouter } from '../../server/router.js';
import createUser from '../../server/routes/system/create-user.js';
import updateUser from '../../server/routes/system/update-user.js';
import decommissionUser from '../../server/routes/system/decommission-user.js';
import updateSettings from '../../server/routes/system/update-settings.js';
import purgeImages from '../../server/routes/system/purge-images.js';
import reconciliationItems from '../../server/routes/system/reconciliation-items.js';
import calendar from '../../server/routes/system/calendar.js';
import version from '../../server/routes/system/version.js';
import health from '../../server/routes/system/health.js';

const router = createGroupedRouter('system', {
  'create-user': createUser,
  'update-user': updateUser,
  'decommission-user': decommissionUser,
  'update-settings': updateSettings,
  'purge-images': purgeImages,
  'reconciliation-items': reconciliationItems,
  calendar,
  version,
  health,
});

export const { fetch, handleRequest, GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS } = router;
export default { fetch: router.fetch };
