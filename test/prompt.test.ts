import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeSystemPrompt, openingNudge } from '../src/agent/prompt.js';
import type { Contact, User } from '../src/db.js';

const owner: User = {
  id: 1,
  email: 'a@b.c',
  name: 'ישראל',
  role: 'user',
  active: true,
  passwordHash: '',
  channelKey: 'k',
  channelSecret: 's',
  instructions: 'שאל מה המתקשר רוצה למסור.',
  greeting: 'שלום, הגעתם לשירות ההודעות של ישראל',
  greetByName: true,
  notifyEmail: '',
  voice: 'Charon',
  createdAt: '',
};
const contact: Contact = { id: 1, userId: 1, name: 'שלמה', phone: '0501234567', notes: 'ספק' };

test('global rules come before the owner instructions and are declared binding', () => {
  const p = composeSystemPrompt('כלל גלובלי', owner, { caller: '0501234567', contact: null });
  assert.ok(p.indexOf('כלל גלובלי') < p.indexOf('שאל מה המתקשר רוצה למסור.'));
  assert.match(p, /הכללים שלמעלה גוברים תמיד/);
  assert.match(p, /0501234567/);
});

test('voice gender sets the grammatical gender', () => {
  assert.match(composeSystemPrompt('g', owner, { caller: null, contact: null }), /לשון זכר/);
  assert.match(composeSystemPrompt('g', { ...owner, voice: 'Kore' }, { caller: null, contact: null }), /לשון נקבה/);
});

test('a known contact is named only when the owner allows it', () => {
  const ctx = { caller: contact.phone, contact };
  assert.match(openingNudge(owner, ctx), /בשמו \(שלמה\)/);
  assert.match(composeSystemPrompt('g', owner, ctx), /אפשר לפנות אליו בשמו/);

  const quiet = { ...owner, greetByName: false };
  assert.doesNotMatch(openingNudge(quiet, ctx), /שלמה/);
  assert.match(composeSystemPrompt('g', quiet, ctx), /אל תפנה אליו בשמו/);
});

test('the greeting is spoken when set, otherwise the instructions decide', () => {
  assert.match(openingNudge(owner, { caller: null, contact: null }), /שלום, הגעתם לשירות ההודעות של ישראל/);
  assert.match(openingNudge({ ...owner, greeting: '' }, { caller: null, contact: null }), /לפי ההנחיות/);
});
