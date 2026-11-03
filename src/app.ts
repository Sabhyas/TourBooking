import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { tours, dateBounds } from './catalog.js';
import type { Config } from './config.js';
import { Repository } from './db.js';
import { BookingService, DemoPaymentProvider } from './service.js';
import { createMailSender, type SendMail } from './mail.js';
import { TbcPaymentProvider } from './payments.js';
import type { Booking, BookingInput, PaymentProvider } from './types.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const keyPattern = /^[0-9a-f-]{36}$/i;
const tokenPattern = /^[0-9a-f]{64}$/i;
const inputSchema = z.object({
  tourId: z.string().min(1).max(60),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  guests: z.number().int().min(1).max(10),
  name: z.string().trim().min(2).max(120).regex(/^[^\x00-\x1f\x7f]+$/),
  email: z.email().max(254),
  phone: z.string().trim().min(7).max(30).regex(/^\+?[0-9 ()-]+$/),
  notes: z.string().trim().max(1000).default('')
}).strict();

function allowedToken(booking: Booking, token: string): boolean {
  return tokenPattern.test(token) && timingSafeEqual(Buffer.from(booking.tokenHash, 'hex'), Buffer.from(hash(token), 'hex'));
}

export function createApplication(options: {
  config: Config;
  repo: Repository;
  provider?: PaymentProvider;
  sendMail?: SendMail;
}) {
  const { config: cfg, repo } = options;
  const provider = options.provider ?? (cfg.PAYMENT_PROVIDER === 'demo'
    ? new DemoPaymentProvider(repo)
    : new TbcPaymentProvider({ apiKey: cfg.TBC_API_KEY, clientId: cfg.TBC_CLIENT_ID, clientSecret: cfg.TBC_CLIENT_SECRET, appUrl: cfg.APP_URL }));
  const service = new BookingService(repo, provider, cfg.OWNER_EMAIL, options.sendMail ?? createMailSender(cfg));
  const app = express();
  app.disable('x-powered-by');
  if (cfg.TRUST_PROXY_HOPS) app.set('trust proxy', cfg.TRUST_PROXY_HOPS);
  app.use(helmet({
    referrerPolicy: { policy: 'no-referrer' },
    contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], frameAncestors: ["'none'"], formAction: ["'self'"], upgradeInsecureRequests: cfg.NODE_ENV === 'production' ? [] : null } }
  }));
  app.use(express.json({ limit: '12kb' }));
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  function view(booking: Booking) {
    const email = repo.email(booking.id);
    return {
      bookingId: booking.id,
      status: booking.status,
      mode: booking.provider,
      checkoutUrl: booking.status === 'pending' ? booking.checkoutUrl : null,
      totalMinor: booking.totalMinor,
      currency: booking.currency,
      tourTitle: booking.tourTitle,
      date: booking.date,
      guests: booking.guests,
      notificationStatus: !email ? 'not_queued' : email.status === 'queued' && email.attempts > 0 ? 'retrying' : email.status === 'sending' ? 'queued' : email.status,
      ...(cfg.PAYMENT_PROVIDER === 'demo' && cfg.EMAIL_TRANSPORT === 'preview' && email?.status === 'preview'
        ? { demoEmail: { to: email.to, subject: email.subject, text: email.text } } : {})
    };
  }

  function authorized(req: Request, res: Response): Booking | undefined {
    const id = String(req.params.id ?? '');
    const booking = keyPattern.test(id) ? repo.booking(id) : undefined;
    const token = req.get('authorization')?.replace(/^Bearer /, '') ?? '';
    if (!booking || booking.provider !== cfg.PAYMENT_PROVIDER || !allowedToken(booking, token)) {
      res.status(404).json({ error: 'ჯავშანი ვერ მოიძებნა ან წვდომის გასაღები არასწორია.' });
      return;
    }
    return booking;
  }

  // The bank callback is outside browser-origin checking. Its body is only a hint to verify with the bank.
  app.post('/api/payments/tbc/callback', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }), (req, res) => {
    if (cfg.PAYMENT_PROVIDER !== 'tbc') return res.sendStatus(404);
    const parsed = z.object({ PaymentId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid callback.' });
    repo.enqueueCheck(parsed.data.PaymentId);
    // Acknowledge only after persisting the verification job. Worker also retries after restarts.
    res.status(200).json({ received: true });
    void service.tick().catch(() => console.error('Verification worker needs attention.'));
  });

  app.use('/api', (req, res, next) => {
    if (req.method !== 'POST') return next();
    const origin = req.get('origin');
    if (origin) {
      let localDemoOrigin = false;
      try { localDemoOrigin = cfg.PAYMENT_PROVIDER === 'demo' && cfg.NODE_ENV !== 'production' && new URL(origin).host === req.get('host'); } catch { /* invalid origin */ }
      if (origin !== cfg.APP_URL && !localDemoOrigin) return res.status(403).json({ error: 'მოთხოვნის წყარო დაუშვებელია.' });
    }
    next();
  });
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'ძალიან ბევრი მოთხოვნაა. სცადეთ ერთ წუთში.' } }));

  app.get('/api/config', (_req, res) => res.json({ mode: cfg.PAYMENT_PROVIDER, emailMode: cfg.EMAIL_TRANSPORT, tours, maxGuests: 10, ...dateBounds() }));
  app.get('/api/health', (_req, res) => res.json({ ok: true, mode: cfg.PAYMENT_PROVIDER }));

  app.post('/api/bookings', rateLimit({ windowMs: 60_000, limit: 12, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'დაჯავშნის მცდელობები ძალიან ხშირია. დაელოდეთ ერთ წუთს.' } }), async (req, res) => {
    const requestKey = req.get('idempotency-key') ?? '';
    const token = req.get('x-booking-token') ?? '';
    const parsed = inputSchema.safeParse(req.body);
    if (!parsed.success || !keyPattern.test(requestKey) || !tokenPattern.test(token)) return res.status(400).json({ error: 'შეავსეთ მონაცემები სწორად. რაოდენობა უნდა იყოს 1-დან 10-მდე.' });
    const input: BookingInput = parsed.data;
    const inputHash = hash(JSON.stringify(input));
    const existing = repo.byKey(requestKey);
    if (existing) {
      if (!allowedToken(existing, token) || existing.inputHash !== inputHash) return res.status(409).json({ error: 'ეს მოთხოვნის გასაღები სხვა მონაცემებით უკვე გამოყენებულია.' });
      return res.status(existing.status === 'creating' ? 202 : 200).json(view(existing));
    }
    const tour = tours.find(t => t.id === input.tourId);
    const { today, maxDate } = dateBounds();
    const date = new Date(`${input.date}T12:00:00Z`);
    if (!tour || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== input.date || input.date < today || input.date > maxDate) {
      return res.status(400).json({ error: 'აირჩიეთ არსებული ტური და დასაშვები მომავალი თარიღი.' });
    }
    const now = Date.now();
    const booking: Booking = {
      ...input, id: randomUUID(), requestKey, inputHash, tokenHash: hash(token),
      tourTitle: tour.title, totalMinor: tour.priceMinor * input.guests, currency: 'GEL', provider: cfg.PAYMENT_PROVIDER,
      status: 'creating', paymentId: null, checkoutUrl: null, providerStatus: null, createdAt: now, updatedAt: now, paidAt: null
    };
    repo.insert(booking);
    await service.initializePayment(booking);
    return res.status(201).json(view(repo.booking(booking.id)!));
  });

  app.get('/api/bookings/:id', (req, res) => {
    const booking = authorized(req, res);
    if (booking) res.json(view(booking));
  });
  app.post('/api/bookings/:id/refresh', (req, res) => {
    const booking = authorized(req, res);
    if (!booking) return;
    if (booking.paymentId && ['pending', 'creating', 'unknown'].includes(booking.status)) repo.enqueueCheck(booking.paymentId);
    res.json(view(booking));
    void service.tick().catch(() => console.error('Verification worker needs attention.'));
  });

  app.post('/api/demo/bookings/:id/complete', async (req, res) => {
    if (cfg.PAYMENT_PROVIDER !== 'demo') return res.sendStatus(404);
    const booking = authorized(req, res);
    if (!booking) return;
    const parsed = z.object({ outcome: z.enum(['success', 'failure']) }).strict().safeParse(req.body);
    if (!parsed.success || !booking.paymentId) return res.status(400).json({ error: 'საცდელი გადახდის მონაცემები არასწორია.' });
    repo.completeDemoPayment(booking.paymentId, parsed.data.outcome);
    repo.enqueueCheck(booking.paymentId);
    await service.tick();
    await service.tick();
    res.json(view(repo.booking(booking.id)!));
  });

  app.use(express.static(fileURLToPath(new URL('../public/', import.meta.url)), { dotfiles: 'deny', index: 'index.html' }));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'მისამართი ვერ მოიძებნა.' }));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : 500;
    if (status === 400 || status === 413) return res.status(status).json({ error: 'მოთხოვნის ფორმატი ან ზომა არასწორია.' });
    console.error('Request failed. Check the application/database configuration.');
    return res.status(500).json({ error: 'მოთხოვნა ვერ დასრულდა. სტატუსი გადაამოწმეთ გადახდის განმეორებამდე.' });
  });
  return { app, service };
}
