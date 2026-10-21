import { createGroupedRouter } from '../../server/router.js';
import completePasswordChange from '../../server/routes/auth/complete-password-change.js';
import resetPassword from '../../server/routes/auth/reset-password.js';
import sendEmailHook from '../../server/routes/auth/send-email-hook.js';

const router = createGroupedRouter('auth', {
  'complete-password-change': completePasswordChange,
  'reset-password': resetPassword,
  'send-email-hook': sendEmailHook,
});

export const { fetch, handleRequest, GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS } = router;
export default { fetch: router.fetch };
