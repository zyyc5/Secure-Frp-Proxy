const test = require('node:test');
const assert = require('node:assert/strict');
const { formatLogDate } = require('../src/utils/logger');

test('formats local dates for daily log file names', () => {
  assert.equal(formatLogDate(new Date(2026, 7, 3)), '2026-08-03');
  assert.equal(formatLogDate(new Date(2026, 11, 31)), '2026-12-31');
});
