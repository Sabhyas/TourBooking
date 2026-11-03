import type { Booking, CreatedPayment, PaymentProvider, PaymentSnapshot } from './types.js';

// Official API and checkout URLs:
// https://developers.tbcbank.ge/docs/checkout-create-checkout-payment
// TBC's documented merchant test phase uses this API too. It is NOT a fake-money sandbox.
const API_BASE = 'https://api.tbcbank.ge/v1/tpay';
const CHECKOUT_HOSTS = new Set(['tpay.tbcbank.ge']);
const PAYMENT_ID = /^[A-Za-z0-9_-]{1,160}$/;

type JsonObject = Record<string, unknown>;
type FailureKind = 'configuration' | 'network' | 'authentication' | 'rejected' | 'response';

/** Safe to show/log: never contains credentials or a provider's raw response. */
export class PaymentProviderError extends Error {
  constructor(readonly kind: FailureKind) {
    const messages: Record<FailureKind, string> = {
      configuration: 'TBC configuration is invalid.',
      network: 'TBC could not be reached. The payment outcome needs verification.',
      authentication: 'TBC authentication failed. Check the server configuration.',
      rejected: 'TBC did not accept the request. The payment outcome needs verification.',
      response: 'TBC returned an unexpected response. The payment outcome needs verification.',
    };
    super(messages[kind]);
    this.name = 'PaymentProviderError';
  }
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PaymentProviderError('response');
  }
  return value as JsonObject;
}

function text(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength) {
    throw new PaymentProviderError('response');
  }
  return value;
}

/** Accept binary floating-point noise, but never silently round a third decimal. */
export function amountToMinor(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new PaymentProviderError('response');
  }
  const scaled = value * 100;
  const minor = Math.round(scaled);
  if (!Number.isSafeInteger(minor) || Math.abs(scaled - minor) > 0.000001) {
    throw new PaymentProviderError('response');
  }
  return minor;
}

function paymentId(value: unknown): string {
  const id = text(value, 160);
  if (!PAYMENT_ID.test(id)) throw new PaymentProviderError('response');
  return id;
}

function checkoutUrl(value: unknown): string {
  try {
    const url = new URL(text(value, 2048));
    if (
      url.protocol !== 'https:' || !CHECKOUT_HOSTS.has(url.hostname) ||
      url.username || url.password || (url.port && url.port !== '443')
    ) throw new PaymentProviderError('response');
    return url.href;
  } catch {
    throw new PaymentProviderError('response');
  }
}

function boolean(value: unknown): boolean {
  // The docs describe a string; their sample response uses a JSON boolean.
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new PaymentProviderError('response');
}

export interface TbcOptions {
  apiKey: string;
  clientId: string;
  clientSecret: string;
  appUrl: string;
}

export class TbcPaymentProvider implements PaymentProvider {
  private token: { value: string; expiresAt: number } | undefined;
  private tokenRequest: Promise<string> | undefined;
  private readonly appUrl: string;

  constructor(private readonly options: TbcOptions, private readonly fetchImpl: typeof fetch = fetch) {
    try {
      const url = new URL(options.appUrl);
      if (
        url.protocol !== 'https:' || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash ||
        !options.apiKey.trim() || !options.clientId.trim() || !options.clientSecret.trim()
      ) throw new PaymentProviderError('configuration');
      this.appUrl = url.origin;
    } catch {
      throw new PaymentProviderError('configuration');
    }
  }

  private async request(path: string, init: RequestInit): Promise<JsonObject> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${API_BASE}${path}`, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      // No automatic POST retries: a timeout can happen after the bank created a payment.
      throw new PaymentProviderError('network');
    }
    if (response.status === 401 || response.status === 403) {
      this.token = undefined;
      throw new PaymentProviderError('authentication');
    }
    if (!response.ok) throw new PaymentProviderError('rejected');
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new PaymentProviderError('response');
    }
    const result = object(data);
    if (result.httpStatusCode !== undefined && result.httpStatusCode !== 200) {
      throw new PaymentProviderError('rejected');
    }
    return result;
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    if (this.tokenRequest) return this.tokenRequest;
    const pending = (async () => {
      const result = await this.request('/access-token', {
        method: 'POST',
        headers: {
          apikey: this.options.apiKey,
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: this.options.clientId,
          client_secret: this.options.clientSecret,
        }),
      });
      const value = text(result.access_token, 16_384);
      const lifetime = result.expires_in;
      if (
        !/^[\x21-\x7e]+$/.test(value) || result.token_type !== 'Bearer' ||
        typeof lifetime !== 'number' || !Number.isSafeInteger(lifetime) ||
        lifetime <= 0 || lifetime > 604_800
      ) throw new PaymentProviderError('response');
      const skew = Math.min(60, Math.max(1, lifetime / 10));
      this.token = { value, expiresAt: Date.now() + (lifetime - skew) * 1000 };
      return value;
    })();
    this.tokenRequest = pending;
    try {
      return await pending;
    } finally {
      if (this.tokenRequest === pending) this.tokenRequest = undefined;
    }
  }

  private async headers(): Promise<Record<string, string>> {
    return {
      apikey: this.options.apiKey,
      authorization: `Bearer ${await this.accessToken()}`,
      accept: 'application/json',
      'content-type': 'application/json',
    };
  }

  async create(booking: Booking): Promise<CreatedPayment> {
    if (
      !/^[\x21-\x7e]{1,52}$/.test(booking.id) || booking.currency !== 'GEL' ||
      !Number.isSafeInteger(booking.totalMinor) || booking.totalMinor <= 0
    ) throw new PaymentProviderError('configuration');
    const result = await this.request('/payments', {
      method: 'POST',
      headers: await this.headers(),
      body: JSON.stringify({
        amount: { currency: booking.currency, total: booking.totalMinor / 100 },
        returnurl: `${this.appUrl}/?booking=${encodeURIComponent(booking.id)}`,
        callbackUrl: `${this.appUrl}/api/payments/tbc/callback`,
        preAuth: false,
        language: 'KA',
        merchantPaymentId: booking.id,
        extra2: booking.id,
        expirationMinutes: 12,
        methods: [5],
        description: 'Tour booking',
      }),
    });
    if (
      result.status !== 'Created' || result.currency !== booking.currency ||
      amountToMinor(result.amount) !== booking.totalMinor || !Array.isArray(result.links)
    ) throw new PaymentProviderError('response');
    const links = result.links.map(object).filter((link) => link.rel === 'approval_url');
    if (links.length !== 1) throw new PaymentProviderError('response');
    return { paymentId: paymentId(result.payId), checkoutUrl: checkoutUrl(links[0]?.uri) };
  }

  async get(id: string): Promise<PaymentSnapshot> {
    const validId = paymentId(id);
    const result = await this.request(`/payments/${encodeURIComponent(validId)}`, {
      method: 'GET',
      headers: await this.headers(),
    });
    const returnedId = paymentId(result.payId);
    const currency = text(result.currency, 3);
    const reference = text(result.extra2, 52);
    if (returnedId !== validId || !/^[A-Z]{3}$/.test(currency)) {
      throw new PaymentProviderError('response');
    }
    return {
      paymentId: returnedId,
      status: text(result.status, 80),
      totalMinor: amountToMinor(result.amount),
      currency,
      reference,
      preAuth: boolean(result.preAuth),
    };
  }
}
