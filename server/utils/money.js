/**
 * Shared currency rounding (TSh has no minor unit - whole shillings everywhere).
 * roundMoney: whole-shilling rounding for stored totals and payments.
 * roundCents: to-cents rounding for intermediate tax/discount math only.
 */
function roundMoney(x) {
  return typeof x === 'number' && !Number.isNaN(x) ? Math.round(x) : 0;
}

function roundCents(x) {
  return typeof x === 'number' && !Number.isNaN(x) ? Math.round(x * 100) / 100 : 0;
}

module.exports = { roundMoney, roundCents };
