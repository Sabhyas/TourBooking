import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createApplication } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { Repository } from '../src/db.js';
import { dateBounds, tours } from '../src/catalog.js';
import type { SendMail } from '../src/mail.js';
import type { Booking, BookingInput, MailMessage, PaymentProvider, PaymentSnapshot } from '../src/types.js';

class FakeBank implements PaymentProvider {
  creates = 0;
  gets = 0;
  failCreation = false;
  failVerification = false;
  snapshots = new Map<string, PaymentSnapshot>();

  async create(booking: Booking) {
    this.creates++;
    const paymentId = `payment_${booking.id}`;
    this.snapshots.set(paymentId, {
      paymentId, reference: booking.id, status: 'Created',
      totalMinor: booking.totalMinor, currency: 'GEL', preAuth: false
    });
    if (this.failCreation) throw new Error('Simulated timeout after bank acceptance');
    return { paymentId, checkoutUrl: `https://tpay.tbcbank.ge/checkout/${paymentId}` };
  }

  async get(paymentId: string) {
    this.gets++;
    if (this.failVerification) throw new Error('Simulated bank outage');
    const result = this.snapshots.get(paymentId);
    if (!result) throw new Error('Unknown payment');
    return { ...result };
  }

  change(paymentId: string, patch: Partial<PaymentSnapshot>) {
    const previous = this.snapshots.get(paymentId);
    assert.ok(previous);
    this.snapshots.set(paymentId, { ...previous, ...patch });
  }
}

interface PublicBooking {
  bookingId: string;
  status: string;
  totalMinor: number;
  notificationStatus: string;
  demoEmail?: { to: string; subject: string; text: string };
}

const input = (patch: Partial<BookingInput> = {}): BookingInput => ({
  tourId: 'kazbegi', date: dateBounds().maxDate, guests: 2,
  name: 'სატესტო სტუმარი', email: 'guest@example.org', phone: '+995 555 123 456',
  notes: 'A plain-text booking note', ...patch
});

const credentials = () => ({ key: randomUUID(), token: randomBytes(32).toString('hex') });

async function fixture(options: {
  mode?: 'demo' | 'tbc';
  path?: string;
  bank?: FakeBank;
  sendMail?: SendMail;
} = {}) {
  const mode = options.mode ?? 'tbc';
  const repo = new Repository(options.path ?? ':memory:', mode);
  const bank = options.bank ?? new FakeBank();
  const sent: MailMessage[] = [];
  const config = readConfig({
    NODE_ENV: 'test', PAYMENT_PROVIDER: mode, EMAIL_TRANSPORT: 'preview',
    APP_URL: 'https://tours.example.org', OWNER_EMAIL: 'owner@example.org',
    TBC_PAYMENTS_ENABLED: 'true', TBC_API_KEY: 'fake-api-key',
    TBC_CLIENT_ID: 'fake-client', TBC_CLIENT_SECRET: 'fake-secret'
  });
  const { app, service } = createApplication({
    config, repo,
    ...(mode === 'tbc' ? { provider: bank } : {}),
    sendMail: options.sendMail ?? (async message => { sent.push(message); return 'preview'; })
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;

  async function request(path: string, options: { body?: unknown; token?: string; headers?: Record<string, string>; method?: string } = {}) {
    return fetch(`${base}${path}`, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...options.headers
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
    });
  }
  async function create(body: unknown = input(), auth = credentials()) {
    const response = await request('/api/bookings', { body, headers: { 'idempotency-key': auth.key, 'x-booking-token': auth.token } });
    const data = await response.json() as PublicBooking;
    return { response, data, auth };
  }
  async function callback(paymentId: string, extra: Record<string, unknown> = {}) {
    const response = await request('/api/payments/tbc/callback', { body: { PaymentId: paymentId, ...extra } });
    await response.text();
    await nextTurn();
    return response;
  }
  async function flush() { await nextTurn(); await service.tick(); await nextTurn(); await service.tick(); }
  async function close() {
    await flush();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    repo.close();
  }
  return { repo, bank, sent, service, request, create, callback, flush, close };
}

test('server owns prices, rejects extra amount fields, and keeps booking data private', async () => {
  const f = await fixture();
  try {
    const manipulated = await f.create({ ...input(), totalMinor: 1 });
    assert.equal(manipulated.response.status, 400);
    assert.equal(f.bank.creates, 0);
    const booking = await f.create();
    assert.equal(booking.response.status, 201);
    assert.equal(booking.data.totalMinor, tours[0].priceMinor * 2);
    assert.equal(booking.data.status, 'pending');
    assert.equal(f.repo.booking(booking.data.bookingId)?.totalMinor, 24000);
    assert.equal((await f.request(`/api/bookings/${booking.data.bookingId}`)).status, 404);
    assert.equal((await f.request(`/api/bookings/${booking.data.bookingId}`, { token: credentials().token })).status, 404);
    const response = await f.request(`/api/bookings/${booking.data.bookingId}`, { token: booking.auth.token });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const data = await response.json() as Record<string, unknown>;
    for (const secret of ['name', 'email', 'phone', 'tokenHash', 'requestKey', 'inputHash']) assert.equal(data[secret], undefined);
    assert.equal(f.repo.booking(booking.data.bookingId)?.tokenHash === booking.auth.token, false);
    assert.equal(f.sent.length, 0);
  } finally { await f.close(); }
});

test('same key replays one payment; changed payload or token cannot reuse it', async () => {
  const f = await fixture();
  try {
    const first = await f.create();
    const replay = await f.create(input(), first.auth);
    assert.equal(replay.response.status, 200);
    assert.equal(replay.data.bookingId, first.data.bookingId);
    assert.equal(f.bank.creates, 1);
    assert.equal((await f.create(input({ guests: 3 }), first.auth)).response.status, 409);
    assert.equal((await f.create(input(), { key: first.auth.key, token: credentials().token })).response.status, 409);
    assert.equal(f.bank.creates, 1);
  } finally { await f.close(); }
});

test('invalid calendar dates, past dates and guest counts are rejected before payment creation', async () => {
  const f = await fixture();
  try {
    for (const patch of [{ date: '2027-02-30' }, { date: '2000-01-01' }, { guests: 0 }, { guests: 1.5 }, { guests: 11 }, { tourId: 'unknown' }]) {
      assert.equal((await f.create(input(patch))).response.status, 400);
    }
    assert.equal(f.bank.creates, 0);
  } finally { await f.close(); }
});

test('forged success fields and browser redirects never confirm an unpaid bank payment', async () => {
  const f = await fixture();
  try {
    const b = await f.create();
    const paymentId = f.repo.booking(b.data.bookingId)!.paymentId!;
    assert.equal((await f.callback(paymentId, { status: 'Succeeded', amount: 240, currency: 'GEL' })).status, 200);
    await f.flush();
    assert.equal(f.repo.booking(b.data.bookingId)?.status, 'pending');
    assert.equal(f.repo.email(b.data.bookingId), undefined);
    const response = await f.request(`/?booking=${b.data.bookingId}&status=Succeeded`);
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(f.repo.booking(b.data.bookingId)?.status, 'pending');
    assert.equal(f.sent.length, 0);
    assert.ok(f.bank.gets >= 1);
  } finally { await f.close(); }
});

test('bank-verified success queues one owner message despite duplicate callbacks', async () => {
  const f = await fixture();
  try {
    const b = await f.create();
    const paymentId = f.repo.booking(b.data.bookingId)!.paymentId!;
    f.bank.change(paymentId, { status: 'Succeeded' });
    await f.callback(paymentId);
    await f.flush();
    await f.callback(paymentId);
    await f.callback(paymentId);
    await f.flush();
    assert.equal(f.repo.booking(b.data.bookingId)?.status, 'paid');
    assert.equal(f.sent.length, 1);
    assert.equal(f.repo.email(b.data.bookingId)?.status, 'preview');
    const message = f.sent[0]!;
    assert.equal(message.to, 'owner@example.org');
    for (const value of [input().name, input().email, input().phone, input().date, '240.00 GEL', b.data.bookingId]) assert.ok(message.text.includes(value));
    const data = await (await f.request(`/api/bookings/${b.data.bookingId}`, { token: b.auth.token })).json() as PublicBooking;
    assert.equal(data.demoEmail, undefined, 'real-bank mode does not reveal owner mail to customers');
  } finally { await f.close(); }
});

test('failed and expired payments never produce a confirmation email', async t => {
  for (const status of ['Failed', 'Expired']) {
    await t.test(status, async () => {
      const f = await fixture();
      try {
        const b = await f.create();
        const paymentId = f.repo.booking(b.data.bookingId)!.paymentId!;
        f.bank.change(paymentId, { status });
        await f.callback(paymentId);
        await f.flush();
        assert.equal(f.repo.booking(b.data.bookingId)?.status, status.toLowerCase());
        assert.equal(f.repo.email(b.data.bookingId), undefined);
        assert.equal(f.sent.length, 0);
      } finally { await f.close(); }
    });
  }
});

test('successful bank statuses with mismatched money, reference or preauthorization need review', async t => {
  const cases: [string, Partial<PaymentSnapshot>][] = [
    ['amount', { totalMinor: 1 }], ['currency', { currency: 'USD' }],
    ['reference', { reference: randomUUID() }], ['preauthorization', { preAuth: true }],
    ['payment identity', { paymentId: 'different-payment' }]
  ];
  for (const [name, patch] of cases) {
    await t.test(name, async () => {
      const f = await fixture();
      try {
        const b = await f.create();
        const paymentId = f.repo.booking(b.data.bookingId)!.paymentId!;
        f.bank.change(paymentId, { status: 'Succeeded', ...patch });
        await f.callback(paymentId);
        await f.flush();
        assert.equal(f.repo.booking(b.data.bookingId)?.status, 'review');
        assert.equal(f.repo.email(b.data.bookingId), undefined);
        assert.equal(f.sent.length, 0);
      } finally { await f.close(); }
    });
  }
});

test('an uncertain create is never automatically repeated and can recover from a verified callback', async () => {
  const bank = new FakeBank();
  bank.failCreation = true;
  const f = await fixture({ bank });
  try {
    const first = await f.create();
    assert.equal(first.data.status, 'unknown');
    assert.equal(f.repo.booking(first.data.bookingId)?.paymentId, null);
    const replay = await f.create(input(), first.auth);
    assert.equal(replay.data.status, 'unknown');
    assert.equal(bank.creates, 1);
    const paymentId = `payment_${first.data.bookingId}`;
    bank.change(paymentId, { status: 'Succeeded' });
    await f.callback(paymentId);
    await f.flush();
    assert.equal(f.repo.booking(first.data.bookingId)?.paymentId, paymentId);
    assert.equal(f.repo.booking(first.data.bookingId)?.status, 'paid');
    assert.equal(f.sent.length, 1);
    assert.equal(bank.creates, 1);
  } finally { await f.close(); }
});

test('bank outage leaves a durable verification job rather than a false success', async () => {
  const f = await fixture();
  try {
    const b = await f.create();
    const paymentId = f.repo.booking(b.data.bookingId)!.paymentId!;
    f.bank.failVerification = true;
    await f.callback(paymentId);
    await f.flush();
    assert.equal(f.repo.booking(b.data.bookingId)?.status, 'pending');
    assert.equal(f.sent.length, 0);
    assert.ok(f.repo.db.prepare('SELECT paymentId FROM verification_jobs WHERE paymentId=?').get(paymentId));
    f.bank.failVerification = false;
    f.bank.change(paymentId, { status: 'Succeeded' });
    await f.callback(paymentId);
    await f.flush();
    assert.equal(f.repo.booking(b.data.bookingId)?.status, 'paid');
  } finally { await f.close(); }
});

test('a recent unlinked callback survives more than six transient failures and recovers', async () => {
  const bank = new FakeBank();
  bank.failCreation = true;
  const f = await fixture({ bank });
  try {
    const b = await f.create();
    const paymentId = `payment_${b.data.bookingId}`;
    assert.equal(f.repo.booking(b.data.bookingId)?.paymentId, null);
    assert.equal(b.data.status, 'unknown');
    f.repo.enqueueCheck(paymentId);
    const createdAt = Date.now() - 10 * 60_000;
    f.repo.db.prepare('UPDATE verification_jobs SET attempts=8, nextRunAt=0, createdAt=? WHERE paymentId=?').run(createdAt, paymentId);
    bank.failVerification = true;
    await f.flush();
    const retained = f.repo.db.prepare('SELECT attempts,createdAt FROM verification_jobs WHERE paymentId=?').get(paymentId) as { attempts: number; createdAt: number } | undefined;
    assert.ok(retained, 'transient failures must not discard a recent unlinked bank callback');
    assert.ok(retained.attempts > 8);
    assert.equal(retained.createdAt, createdAt);
    assert.equal(f.repo.booking(b.data.bookingId)?.status, 'unknown');
    assert.equal(f.sent.length, 0);

    bank.failVerification = false;
    bank.change(paymentId, { status: 'Succeeded' });
    await f.callback(paymentId);
    await f.flush();
    assert.equal(f.repo.booking(b.data.bookingId)?.status, 'paid');
    assert.equal(f.repo.booking(b.data.bookingId)?.paymentId, paymentId);
    assert.equal(f.sent.length, 1);
    assert.equal(bank.creates, 1);
  } finally { await f.close(); }
});

test('email failure preserves payment and survives database/server restart with retry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tour-booking-test-'));
  const path = join(dir, 'bookings.sqlite');
  const bank = new FakeBank();
  let id = '';
  let paymentId = '';
  const f = await fixture({ path, bank, sendMail: async () => { throw new Error('Simulated SMTP outage'); } });
  try {
    const b = await f.create();
    id = b.data.bookingId;
    paymentId = f.repo.booking(id)!.paymentId!;
    bank.change(paymentId, { status: 'Succeeded' });
    await f.callback(paymentId);
    await f.flush();
    assert.equal(f.repo.booking(id)?.status, 'paid');
    assert.equal(f.repo.email(id)?.status, 'queued');
    assert.equal(f.repo.email(id)?.attempts, 1);
    assert.ok(f.repo.email(id)!.nextRunAt > Date.now());
  } finally { await f.close(); }
  const restarted = await fixture({ path, bank });
  try {
    assert.equal(restarted.repo.booking(id)?.status, 'paid');
    assert.equal(restarted.repo.booking(id)?.paymentId, paymentId);
    // Advance the durable due time without sleeping for retry backoff.
    restarted.repo.db.prepare('UPDATE email_jobs SET nextRunAt=0 WHERE bookingId=?').run(id);
    await restarted.flush();
    assert.equal(restarted.repo.email(id)?.status, 'preview');
    assert.equal(restarted.sent.length, 1);
    await restarted.callback(paymentId);
    await restarted.flush();
    assert.equal(restarted.sent.length, 1);
  } finally { await restarted.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('demo-only payment endpoints are absent with TBC enabled', async () => {
  const f = await fixture();
  try {
    const b = await f.create();
    const response = await f.request(`/api/demo/bookings/${b.data.bookingId}/complete`, { body: { outcome: 'success' }, token: b.auth.token });
    assert.equal(response.status, 404);
    await response.text();
    assert.equal(f.repo.booking(b.data.bookingId)?.status, 'pending');
    assert.equal(f.sent.length, 0);
  } finally { await f.close(); }
});

test('local demo walks through booking, fake payment and owner message preview', async () => {
  const f = await fixture({ mode: 'demo' });
  try {
    const b = await f.create();
    const response = await f.request(`/api/demo/bookings/${b.data.bookingId}/complete`, { body: { outcome: 'success' }, token: b.auth.token });
    assert.equal(response.status, 200);
    const data = await response.json() as PublicBooking;
    assert.equal(data.status, 'paid');
    assert.equal(data.notificationStatus, 'preview');
    assert.ok(data.demoEmail?.subject.startsWith('[DEMO]'));
    assert.ok(data.demoEmail?.text.includes(input().date));
    assert.equal(f.bank.creates, 0);
    assert.equal(f.bank.gets, 0);
    assert.equal((await f.request('/api/payments/tbc/callback', { body: { PaymentId: 'anything' } })).status, 404);
  } finally { await f.close(); }
});

test('demo and live payment data cannot share one database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tour-booking-mode-'));
  const path = join(dir, 'bookings.sqlite');
  try {
    const repo = new Repository(path, 'demo');
    repo.close();
    assert.throws(() => new Repository(path, 'tbc'), /different DB_PATH/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
