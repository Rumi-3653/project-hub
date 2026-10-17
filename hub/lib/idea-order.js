'use strict';
const U = require('./idea-utils');
function normalize(d) {
  const ids = Object.keys(d.items);
  if (d.itemOrder === undefined) {
    d.itemOrder = ids.sort((a,b) => d.items[a].createdAt.localeCompare(d.items[b].createdAt) || a.localeCompare(b));
    d.orderRev = 0;
  }
  U.check(Array.isArray(d.itemOrder) && d.itemOrder.length === ids.length && new Set(d.itemOrder).size === ids.length && d.itemOrder.every(id => d.items[id]) && Number.isSafeInteger(d.orderRev) && d.orderRev >= 0, 'item-order', '一覧の順序を照合する必要があります', 503);
  return d.itemOrder;
}
module.exports = { normalize };
