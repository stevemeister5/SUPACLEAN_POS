const crypto = require('crypto');

/** Internal marker stored in DB when a customer has no phone yet (bulk import, etc.) */
const PLACEHOLDER_PREFIX = 'NO-PHONE:';

function generatePlaceholderPhone() {
  return `${PLACEHOLDER_PREFIX}${crypto.randomBytes(8).toString('hex')}`;
}

function isPlaceholderPhone(phone) {
  if (phone == null) return true;
  const trimmed = String(phone).trim();
  return trimmed === '' || trimmed.startsWith(PLACEHOLDER_PREFIX);
}

function normalizePhoneDigits(phone) {
  if (!phone || typeof phone !== 'string') return '';
  const trimmed = phone.trim();
  if (isPlaceholderPhone(trimmed)) return '';
  let digits = trimmed.replace(/\D/g, '');
  if (!digits) return '';
  // Tanzania mobile: 0XXXXXXXXX (10 digits) -> drop leading 0
  if (digits.length === 10 && digits.startsWith('0')) {
    digits = digits.slice(1);
  }
  if (digits.length === 9) {
    return '255' + digits;
  }
  if (digits.length === 12 && digits.startsWith('255')) {
    return digits;
  }
  return digits;
}

/** Values from Excel that should be treated as "no phone" during bulk import. */
const IMPORT_PHONE_EMPTY = /^(n\/a|na|none|nil|null|no|no phone|no number|-|—|\.+)$/i;

function sanitizeImportPhone(raw) {
  if (raw == null) return '';
  let s = String(raw).trim();
  if (!s) return '';
  if (IMPORT_PHONE_EMPTY.test(s)) return '';
  // Excel sometimes stores TZ mobiles as numbers (loses leading zero).
  if (/^\d{9}$/.test(s)) s = '0' + s;
  if (/^\d{12}$/.test(s) && s.startsWith('255')) s = '0' + s.slice(3);
  return s;
}

/**
 * SQL expression that reduces a phone column to digits only.
 *
 * Uses nested replace() instead of PostgreSQL's regexp_replace() so the same
 * statement runs unchanged on SQLite and PostgreSQL. Every printable ASCII
 * character that is not a digit is stripped, which matches the JavaScript
 * `replace(/\D/g, '')` normalisation closely.
 *
 * `?` and `$` are excluded on purpose: the query helpers rewrite every `?` into
 * a positional placeholder (`$1`, `$2`, ...), which would turn these literals
 * into parameters and break the statement.
 */
const UNSAFE_IN_SQL_LITERAL = new Set(['?', '$', '\\']);
const NON_DIGIT_CHARS = (() => {
  let chars = '';
  for (let code = 32; code <= 126; code += 1) {
    const ch = String.fromCharCode(code);
    if (ch >= '0' && ch <= '9') continue;
    if (UNSAFE_IN_SQL_LITERAL.has(ch)) continue;
    chars += ch;
  }
  return chars;
})();

function digitsOnlySql(column) {
  let expr = column;
  for (const ch of NON_DIGIT_CHARS) {
    const literal = ch === "'" ? "''" : ch;
    expr = `replace(${expr}, '${literal}', '')`;
  }
  return expr;
}

function resolveInsertId(result) {
  if (!result) return null;
  const id = result.row?.id ?? result.lastID;
  if (id == null || id === '') return null;
  const n = Number(id);
  return Number.isFinite(n) ? n : id;
}

module.exports = {
  PLACEHOLDER_PREFIX,
  generatePlaceholderPhone,
  isPlaceholderPhone,
  normalizePhoneDigits,
  digitsOnlySql,
  sanitizeImportPhone,
  resolveInsertId,
};
