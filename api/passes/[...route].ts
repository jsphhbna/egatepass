import { createGroupedRouter } from '../../server/router.js';
import email from '../../server/routes/passes/email.js';
import issue from '../../server/routes/passes/issue.js';
import verifyIdentity from '../../server/routes/passes/verify-identity.js';
import identifyReturning from '../../server/routes/passes/identify-returning.js';
import capabilities from '../../server/routes/passes/capabilities.js';

const router = createGroupedRouter('passes', {
  email,
  issue,
  'verify-identity': verifyIdentity,
  'identify-returning': identifyReturning,
  capabilities,
});

export const { fetch, handleRequest, GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS } = router;
export default { fetch: router.fetch };
