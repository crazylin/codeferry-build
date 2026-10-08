import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAN, validateUpload } from '../resume-gateway-037.mjs';

const sample = () => ({
  id: PLAN.upload, releaseId: PLAN.release, status: 'active',
  size: PLAN.size, chunkSize: PLAN.chunkSize,
  chunkCount: 4, received: [], expiresAt: Date.now() + 60000,
});

test('only missing exact immutable 16MiB chunks are scheduled', () => {
  assert.deepEqual(validateUpload(sample()), [0, 1, 2, 3]);
  assert.deepEqual(validateUpload({ ...sample(), received: [1, 3] }), [0, 2]);
});
test('a different release or upload is never resumed', () => {
  assert.throws(() => validateUpload({ ...sample(), id: 'untrusted' }));
  assert.throws(() => validateUpload({ ...sample(), releaseId: 'untrusted' }));
});
test('expired, completed, or changed uploads are rejected', () => {
  assert.throws(() => validateUpload({ ...sample(), status: 'complete' }));
  assert.throws(() => validateUpload({ ...sample(), size: PLAN.size + 1 }));
  assert.throws(() => validateUpload({ ...sample(), expiresAt: Date.now() - 1 }));
  assert.throws(() => validateUpload({ ...sample(), chunkSize: 1048576 }));
});
test('duplicate and invalid received indexes are rejected', () => {
  assert.throws(() => validateUpload({ ...sample(), received: [1, 1] }));
  assert.throws(() => validateUpload({ ...sample(), received: [-1] }));
  assert.throws(() => validateUpload({ ...sample(), received: [4] }));
  assert.throws(() => validateUpload({ ...sample(), received: ['1'] }));
});
