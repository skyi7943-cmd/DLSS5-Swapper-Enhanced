'use strict';
const path = require('node:path');
const PORTABLE_DIR = 'Skyi-DLSS-Enhanced';
function missingPayload({ packaged, appRoot, userDataDir, payloadDir } = {}) {
  const directory = payloadDir || path.join(userDataDir || appRoot || '.', 'payload');
  return { code: 'errPayloadMissing', message:
    `This community build does not bundle third-party game runtimes. Supply files you are entitled to use at ${directory}, or set DLSS5_ENHANCED_PAYLOAD_DIR to your private component folder. Keep the original licenses. ` +
    (!packaged ? 'For an explicit local copy, use npm run payload -- <source> <private-destination>. ' : '') +
    'See README for the folder layout and official sources. No game files were changed.' };
}
module.exports = { missingPayload, PORTABLE_DIR };
