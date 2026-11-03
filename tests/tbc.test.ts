import { test } from 'node:test';
import assert from 'node:assert/strict';
import { amountToMinor, PaymentProviderError, TbcPaymentProvider } from '../src/payments.js';
import type { Booking } from '../src/types.js';

const options = {
  apiKey: 'test-key-not-real', clientId: 'test-id', clientSecret: 'test-secret-not-real',
  appUrl: 'https://example.test',
};
const booking: Booking = {
  id: '0d16f829-3e68-4abd-a6e8-5b6c9dba0f21', requestKey: 'request-key', inputHash: 'hash',
  tokenHash: 'never-put-this-in-redirects', tourId: 'kazbegi', tourTitle: 'Kazbegi',
  date: '2027-01-15', guests: 2, name: 'Test Guest', email: 'guest@example.test',
  phone: '+995555123456', notes: '', totalMinor: 24990, currency: 'GEL',
  provider: 'tbc', status: 'creating', paymentId: null, checkoutUrl: null,
  providerStatus: null, createdAt: 1, updatedAt: 1, paidAt: null,
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function token(): Response {
  return json({ access_token: 'fake-token', token_type: 'Bearer', expires_in: 86400 });
}

function created(url = 'https://tpay.tbcbank.ge/checkout/choose-payment-method/tpay-123'): Response {
  return json({
    payId: 'tpay-123', status: 'Created', currency: 'GEL', amount: 249.9,
    links: [{ rel: 'approval_url', method: 'REDIRECT', uri: url }],
  });
}

function details(extra: Record<string, unknown> = {}): Response {
  return json({
    payId: 'tpay-123', status: 'Succeeded', currency: 'GEL', amount: 249.9,
    extra2: booking.id, preAuth: false, ...extra,
  });
}

test('TBC maps the documented request, keeps secrets server-side, and reuses its token', async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/access-token')) return token();
    if (init?.method === 'POST') return created();
    return details();
  };
  const provider = new TbcPaymentProvider(options, fetcher);
  const result = await provider.create(booking);
  assert.equal(result.paymentId, 'tpay-123');
  assert.equal(result.checkoutUrl, 'https://tpay.tbcbank.ge/checkout/choose-payment-method/tpay-123');
  assert.equal(calls[0]?.url, 'https://api.tbcbank.ge/v1/tpay/access-token');
  const auth = new URLSearchParams(String(calls[0]?.init?.body));
  assert.equal(auth.get('client_id'), options.clientId);
  assert.equal(auth.get('client_secret'), options.clientSecret);
  const call = calls[1];
  assert.equal(call?.url, 'https://api.tbcbank.ge/v1/tpay/payments');
  const requestHeaders = new Headers(call?.init?.headers);
  assert.equal(requestHeaders.get('apikey'), options.apiKey);
  assert.equal(requestHeaders.get('authorization'), 'Bearer fake-token');
  assert.equal(call?.init?.redirect, 'error');
  assert.ok(call?.init?.signal instanceof AbortSignal);
  const body = JSON.parse(String(call?.init?.body)) as Record<string, unknown>;
  assert.deepEqual(body.amount, { currency: 'GEL', total: 249.9 });
  assert.equal(body.returnurl, `https://example.test/?booking=${booking.id}`);
  assert.equal(body.callbackUrl, 'https://example.test/api/payments/tbc/callback');
  assert.equal(body.preAuth, false);
  assert.equal(body.extra2, booking.id);
  assert.deepEqual(body.methods, [5]);
  assert.equal(body.expirationMinutes, 12);
  assert.ok(!String(call?.init?.body).includes(booking.tokenHash));
  const snapshot = await provider.get('tpay-123');
  assert.deepEqual(snapshot, {
    paymentId: 'tpay-123', status: 'Succeeded', totalMinor: 24990,
    currency: 'GEL', reference: booking.id, preAuth: false,
  });
  assert.equal(calls.filter((item) => item.url.endsWith('/access-token')).length, 1);
});

test('concurrent status checks share one token request', async () => {
  let tokenCalls = 0;
  const fetcher: typeof fetch = async (input) => {
    if (String(input).endsWith('/access-token')) {
      tokenCalls++;
      await Promise.resolve();
      return token();
    }
    return details();
  };
  const provider = new TbcPaymentProvider(options, fetcher);
  await Promise.all([provider.get('tpay-123'), provider.get('tpay-123')]);
  assert.equal(tokenCalls, 1);
});

test('amount parsing tolerates binary noise but rejects fractional tetri and unsafe amounts', () => {
  assert.equal(amountToMinor(19.99), 1999);
  assert.equal(amountToMinor(0.1 + 0.2), 30);
  assert.equal(amountToMinor(249.9), 24990);
  assert.equal(amountToMinor(0), 0);
  for (const value of [1.001, -1, NaN, Infinity, '10.00', null, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => amountToMinor(value), PaymentProviderError);
  }
});

test('an uncertain payment creation is never retried and network details are not exposed', async () => {
  let paymentCalls = 0;
  const fetcher: typeof fetch = async (input) => {
    if (String(input).endsWith('/access-token')) return token();
    paymentCalls++;
    throw new Error(`network debug: ${options.clientSecret}`);
  };
  await assert.rejects(new TbcPaymentProvider(options, fetcher).create(booking), (error: unknown) => {
    assert.ok(error instanceof PaymentProviderError);
    assert.equal(error.kind, 'network');
    assert.ok(!error.message.includes(options.clientSecret));
    return true;
  });
  assert.equal(paymentCalls, 1);
});

test('checkout redirects reject attacker domains, insecure URLs, credentials, and custom ports', async () => {
  for (const url of [
    'https://tpay.tbcbank.ge.evil.example/checkout', 'https://evil.example/',
    'http://tpay.tbcbank.ge/checkout', 'https://user:pass@tpay.tbcbank.ge/checkout',
    'https://tpay.tbcbank.ge:8443/checkout', 'javascript:alert(1)',
  ]) {
    const fetcher: typeof fetch = async (input) => String(input).endsWith('/access-token') ? token() : created(url);
    await assert.rejects(new TbcPaymentProvider(options, fetcher).create(booking), PaymentProviderError);
  }
});

test('authentication failures are safe, do not retry payment creation, and invalidate cached tokens', async () => {
  let authCalls = 0;
  let paymentCalls = 0;
  const fetcher: typeof fetch = async (input) => {
    if (String(input).endsWith('/access-token')) { authCalls++; return token(); }
    paymentCalls++;
    return json({ sensitive: options.clientSecret }, 401);
  };
  const provider = new TbcPaymentProvider(options, fetcher);
  await assert.rejects(provider.create(booking), (error: unknown) => {
    assert.ok(error instanceof PaymentProviderError);
    assert.equal(error.kind, 'authentication');
    assert.ok(!error.message.includes(options.clientSecret));
    return true;
  });
  assert.equal(paymentCalls, 1);
  await assert.rejects(provider.get('tpay-123'), PaymentProviderError);
  assert.equal(authCalls, 2);
});

test('a failed token request does not send any create-payment request', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return json({}, 403); };
  await assert.rejects(new TbcPaymentProvider(options, fetcher).create(booking), PaymentProviderError);
  assert.equal(calls, 1);
});

test('non-success and preauthorization states remain visible to the booking service', async () => {
  const fetcher: typeof fetch = async (input) => String(input).endsWith('/access-token')
    ? token() : details({ status: 'WaitingConfirm', preAuth: 'true' });
  const result = await new TbcPaymentProvider(options, fetcher).get('tpay-123');
  assert.equal(result.status, 'WaitingConfirm');
  assert.equal(result.preAuth, true);
});

test('mismatched payment IDs and malformed money fail verification', async () => {
  for (const override of [{ payId: 'another-payment' }, { amount: 249.901 }, { extra2: null }, { preAuth: null }]) {
    const fetcher: typeof fetch = async (input) => String(input).endsWith('/access-token') ? token() : details(override);
    await assert.rejects(new TbcPaymentProvider(options, fetcher).get('tpay-123'), PaymentProviderError);
  }
});

test('TBC requires an HTTPS application origin', () => {
  for (const appUrl of ['http://localhost:3000', 'https://example.test/path', 'https://user:pass@example.test']) {
    assert.throws(() => new TbcPaymentProvider({ ...options, appUrl }), PaymentProviderError);
  }
});
