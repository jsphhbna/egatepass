import { createGroupedRouter } from '../../server/router.js';
import scanPass from '../../server/routes/gate/scan-pass.js';
import decideVisit from '../../server/routes/gate/decide-visit.js';
import evidence from '../../server/routes/gate/evidence.js';
import syncOfflineRegistration from '../../server/routes/gate/sync-offline-registration.js';

const router = createGroupedRouter('gate', {
  'scan-pass': scanPass,
  'decide-visit': decideVisit,
  evidence,
  'sync-offline-registration': syncOfflineRegistration,
});

export const { fetch, handleRequest, GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS } = router;
export default { fetch: router.fetch };
