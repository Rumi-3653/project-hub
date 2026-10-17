'use strict';
// Short-lived display snapshot. Only explicitly opted-in reads share results;
// mutation guards (noLinks, idle, handoffErrors, etc.) never use this cache.
// No async context is propagated: timers, promises and the next request are fresh.
let current = null;
function run(build) {
  const previous = current;
  current = new Map();
  try { return build(); } finally { current = previous; }
}
function memo(owner, key, read) {
  if (!current) return read();
  let entries = current.get(owner);
  if (!entries) current.set(owner, entries = new Map());
  if (entries.has(key)) return entries.get(key);
  const value = read(); // Failed reads are never remembered.
  entries.set(key, value);
  return value;
}
module.exports = { run, memo };
