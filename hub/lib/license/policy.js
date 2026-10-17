'use strict';
const { createPublicKey } = require('node:crypto');
// Build constants, never loaded from user settings or environment variables.
module.exports = Object.freeze({
  licenseEnforcement: true,
  endpoint: 'https://project-hub-license.kieiyellow.workers.dev',
  trialDays: 30, // Owner selected 30 days. Set the issuer's TRIAL_DAYS to 30 before distribution.
  trustedKeys: Object.freeze({
    'hub-ed25519--esZsIozabMh900UWuzuk3BpFihKVTuUWHMNhgVFw3s': Object.freeze({
      publicKey: createPublicKey({ key: Buffer.from('MCowBQYDK2VwAyEAy+P+rfdhiWHpbYDgKhyAdVpwQk7v6fqI9o/NefIbBfw=', 'base64'), format: 'der', type: 'spki' }),
      purposes: Object.freeze(['proof', 'time']),
    }),
  }),
  build: Object.freeze({ channel: 'release', buildId: 'project-hub-4.124.0-mac-arm64', product: 'project-hub-4.123', bugfixOf: Object.freeze([]) }),
});
