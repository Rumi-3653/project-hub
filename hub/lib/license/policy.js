'use strict';
const { createPublicKey } = require('node:crypto');
// 4系列の固定名。版を上げても変えない（公開済み4.123.11との互換性）。
const SERIES_PRODUCT = 'project-hub-4.123';
// Build constants, never loaded from user settings or environment variables.
module.exports = Object.freeze({
  SERIES_PRODUCT,
  licenseEnforcement: true,
  endpoint: 'https://project-hub-license.kieiyellow.workers.dev',
  trialDays: 30, // Owner selected 30 days. Set the issuer's TRIAL_DAYS to 30 before distribution.
  // Release candidate only: enable the live issuer separately before publishing this build.
  // The stable issuer entry keeps changeable Stripe Links outside the distributed App.
  purchaseUrl: 'https://project-hub-license.kieiyellow.workers.dev/buy',
  trustedKeys: Object.freeze({
    'hub-ed25519--esZsIozabMh900UWuzuk3BpFihKVTuUWHMNhgVFw3s': Object.freeze({
      publicKey: createPublicKey({ key: Buffer.from('MCowBQYDK2VwAyEAy+P+rfdhiWHpbYDgKhyAdVpwQk7v6fqI9o/NefIbBfw=', 'base64'), format: 'der', type: 'spki' }),
      purposes: Object.freeze(['proof', 'time']),
    }),
  }),
  build: Object.freeze({ channel: 'release', buildId: 'project-hub-4.124.2-mac-arm64', product: SERIES_PRODUCT, bugfixOf: Object.freeze([]) }),
});
