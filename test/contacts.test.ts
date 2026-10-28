import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, parseCsv, rowsToContacts } from '../src/contacts.js';

test('phone numbers in every common shape become 0XXXXXXXXX', () => {
  assert.equal(normalizePhone('052-123-4567'), '0521234567');
  assert.equal(normalizePhone('+972 52 123 4567'), '0521234567');
  assert.equal(normalizePhone('972521234567'), '0521234567');
  assert.equal(normalizePhone(521234567), '0521234567'); // Excel drops the leading zero
  assert.equal(normalizePhone('02-6543210'), '026543210');
  assert.equal(normalizePhone('12345'), null);
  assert.equal(normalizePhone(''), null);
});

test('a Hebrew header row picks the right columns, in any order', () => {
  const { contacts, skipped } = rowsToContacts([
    ['טלפון נייד', 'הערות', 'שם מלא'],
    ['0501234567', 'לקוח ותיק', 'שלמה לוי'],
    ['לא מספר', '', 'רחל'],
  ]);
  assert.deepEqual(contacts, [{ name: 'שלמה לוי', phone: '0501234567', notes: 'לקוח ותיק' }]);
  assert.equal(skipped, 1);
});

test('without a header, column A is the name and column B the phone', () => {
  const { contacts } = rowsToContacts([
    ['דוד', 521112222],
    ['', '0531112222'],
  ]);
  assert.deepEqual(contacts, [
    { name: 'דוד', phone: '0521112222', notes: '' },
    { name: '0531112222', phone: '0531112222', notes: '' },
  ]);
});

test('CSV with quotes, embedded commas and CRLF line ends', () => {
  assert.deepEqual(parseCsv('name,phone\r\n"כהן, משה",050-1234567\r\n"a ""b""",1\n'), [
    ['name', 'phone'],
    ['כהן, משה', '050-1234567'],
    ['a "b"', '1'],
  ]);
});
