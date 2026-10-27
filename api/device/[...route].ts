import { createGroupedRouter } from '../../server/router.js';
import createDevice from '../../server/routes/device/create-device.js';
import deleteDevice from '../../server/routes/device/delete-device.js';
import updateDevice from '../../server/routes/device/update-device.js';
import updateDeviceAuth from '../../server/routes/device/update-device-auth.js';
import reauthenticate from '../../server/routes/device/reauthenticate.js';
import thermalTemplate from '../../server/routes/device/thermal-template.js';

const router = createGroupedRouter('device', {
  'create-device': createDevice,
  'delete-device': deleteDevice,
  'update-device': updateDevice,
  'update-device-auth': updateDeviceAuth,
  'reauthenticate': reauthenticate,
  'thermal-template': thermalTemplate,
});

export const { fetch, handleRequest, GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS } = router;
export default { fetch: router.fetch };
