'use strict';
// Finder aggregates each volume's own Trash. Keep trash moves atomic on that
// volume so inode fingerprints and interruption/restore receipts remain valid.
const path = require('node:path');
const platforms = require('./platform');
const { existingParent, volumeRoot } = platforms;
const homeTrash = () => platforms.trashDir();
function trashRootFor(source, configured, options = {}) {
  return (options.platformApi || platforms.forPlatform(options.platform)).trashRootFor(source, configured, options);
}
function isTrashDestination(source, destination, configured) {
  const inside = root => destination === root || destination.startsWith(root + path.sep);
  const original = path.resolve(configured || process.env.HUB_TRASH || homeTrash());
  // Existing home-trash receipts remain restorable; new moves use source-volume Trash.
  if (inside(original)) return true;
  return inside(trashRootFor(source, configured));
}
module.exports = { trashRootFor, isTrashDestination, volumeRoot, existingParent };
