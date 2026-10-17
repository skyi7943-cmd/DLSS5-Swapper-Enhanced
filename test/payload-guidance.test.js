'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { missingPayload, PORTABLE_DIR } = require('../src/core/payload-guidance');
test('developer guidance describes an explicit private import', () => {
  const { code, message } = missingPayload({ packaged:false, appRoot:'C:\\src\\app' });
  assert.equal(code,'errPayloadMissing');
  assert.match(message,/npm run payload -- <source> <private-destination>/);
  assert.match(message,/does not bundle third-party/);
});
test('installed and portable builds explain intentionally absent runtimes without blaming antivirus', () => {
  for(const portable of [true,false]) {
    const { message } = missingPayload({packaged:true,portable,userDataDir:'C:\\private'});
    assert.match(message,/C:\\private\\payload/);
    assert.match(message,/DLSS5_ENHANCED_PAYLOAD_DIR/);
    assert.match(message,/No game files were changed/);
    assert.doesNotMatch(message,/antivirus|quarantine|exclude|delete|npm/);
  }
});
test('explicit local payload path is shown and portable identity is independent', () => {
  assert.ok(missingPayload({payloadDir:'D:\\private-components'}).message.includes('D:\\private-components'));
  assert.equal(PORTABLE_DIR,require('../package.json').build.portable.unpackDirName);
});
