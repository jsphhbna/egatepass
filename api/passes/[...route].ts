import { createGroupedRouter } from '../../server/router.js';
import email from '../../server/routes/passes/email.js';
import issue from '../../server/routes/passes/issue.js';
import verifyIdentity from '../../server/routes/passes/verify-identity.js';
import abandonIntent from '../../server/routes/passes/abandon-intent.js';
import identifyReturning from '../../server/routes/passes/identify-returning.js';
import lookupReturning from '../../server/routes/passes/lookup-returning.js';
import returningIdPreview from '../../server/routes/passes/returning-id-preview.js';
import returningPhotoPreview from '../../server/routes/passes/returning-photo-preview.js';
import capabilities from '../../server/routes/passes/capabilities.js';
import vehiclesMakes from '../../server/routes/vehicles/makes.js';
import vehiclesModels from '../../server/routes/vehicles/models.js';
import locationSearch from '../../server/routes/location/search.js';
import officeVisits from '../../server/routes/office/visits.js';
import officeDecide from '../../server/routes/office/decide.js';
import officeConfirmArrival from '../../server/routes/office/confirm-arrival.js';
import officePersonnel from '../../server/routes/office/personnel.js';
import officePortraitPreview from '../../server/routes/office/portrait-preview.js';
import officeVerifyEmail from '../../server/routes/office/verify-email.js';
import officeRetryEmail from '../../server/routes/office/retry-email.js';
import officeCalendar from '../../server/routes/office/calendar.js';
import requestOfficeVisit from '../../server/routes/passes/request-office-visit.js';
import track from '../../server/routes/passes/track.js';

const router = createGroupedRouter('passes', {
  email,
  issue,
  'verify-identity': verifyIdentity,
  'abandon-intent': abandonIntent,
  'abandon/intent': abandonIntent,
  'lookup-returning': lookupReturning,
  'lookup/returning': lookupReturning,
  'identify-returning': identifyReturning,
  'returning-id-preview': returningIdPreview,
  'returning/id-preview': returningIdPreview,
  'returning-photo-preview': returningPhotoPreview,
  'returning/photo-preview': returningPhotoPreview,
  capabilities,
  'vehicles-makes': vehiclesMakes,
  'vehicles-models': vehiclesModels,
  'vehicles/makes': vehiclesMakes,
  'vehicles/models': vehiclesModels,
  'location-search': locationSearch,
  'location/search': locationSearch,
  'office/visits': officeVisits,
  'office-visits': officeVisits,
  'office/decide': officeDecide,
  'office-decide': officeDecide,
  'office/confirm-arrival': officeConfirmArrival,
  'office-confirm-arrival': officeConfirmArrival,
  'office/personnel': officePersonnel,
  'office-personnel': officePersonnel,
  'office/portrait-preview': officePortraitPreview,
  'office-portrait-preview': officePortraitPreview,
  'office/verify-email': officeVerifyEmail,
  'office-verify-email': officeVerifyEmail,
  'office/retry-email': officeRetryEmail,
  'office/retry/email': officeRetryEmail,
  'office-retry-email': officeRetryEmail,
  'office/calendar': officeCalendar,
  'office-calendar': officeCalendar,
  'request-office-visit': requestOfficeVisit,
  track,
  'track-visit': track,
});

export const { fetch, handleRequest, GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS } = router;
export default { fetch: router.fetch };
