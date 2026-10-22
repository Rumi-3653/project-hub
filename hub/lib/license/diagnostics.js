'use strict';
// Only fixed stages/codes and UTC may leave the licensing implementation.
const stages = new Set(['load-state', 'load-device', 'key-restore', 'clock-create', 'tick-elapsed', 'tick-save', 'clock-request', 'clock-response', 'time-save', 'resume-watch', 'resume-tick', 'status-tick']);
const defaults = { 'load-state': 'STATE_READ_FAILED', 'load-device': 'DEVICE_READ_FAILED', 'key-restore': 'KEY_RESTORE_FAILED', 'clock-create': 'CLOCK_CREATE_FAILED', 'tick-elapsed': 'CLOCK_SAMPLE_FAILED', 'tick-save': 'TICK_SAVE_FAILED', 'clock-request': 'CLOCK_SAMPLE_FAILED', 'clock-response': 'CLOCK_SAMPLE_FAILED', 'time-save': 'TIME_SAVE_FAILED', 'resume-watch': 'RESUME_WATCH_FAILED', 'resume-tick': 'RESUME_TICK_FAILED' };
function failure(stage, error) {
  stage = stages.has(stage) ? stage : 'load-state';
  const safe = require('../platform/win32-native').diagnostic(error).errorCode;
  return Object.freeze({ stage, code: safe === 'CHECK_FAILED' ? defaults[stage] || 'TICK_FAILED' : safe, utc: new Date().toISOString() });
}
module.exports = { failure };
