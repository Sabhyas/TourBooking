import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Booking, BookingStatus, MailMessage, PaymentSnapshot } from './types.js';

export interface EmailJob extends MailMessage {
  bookingId: string;
  status: 'queued' | 'sending' | 'sent' | 'preview';
  attempts: number;
  nextRunAt: number;
  leaseUntil: number;
  lastError: string | null;
}
export interface VerificationJob { paymentId: string; attempts: number; nextRunAt: number; createdAt: number; }

export class Repository {
  readonly db: Database.Database;

  constructor(path: string, provider: 'demo' | 'tbc' = 'demo') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bookings (
        id TEXT PRIMARY KEY,
        requestKey TEXT NOT NULL UNIQUE,
        inputHash TEXT NOT NULL,
        tokenHash TEXT NOT NULL,
        tourId TEXT NOT NULL,
        tourTitle TEXT NOT NULL,
        date TEXT NOT NULL,
        guests INTEGER NOT NULL CHECK(guests BETWEEN 1 AND 10),
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        phone TEXT NOT NULL,
        notes TEXT NOT NULL,
        totalMinor INTEGER NOT NULL CHECK(totalMinor > 0),
        currency TEXT NOT NULL CHECK(currency = 'GEL'),
        provider TEXT NOT NULL,
        status TEXT NOT NULL,
        paymentId TEXT UNIQUE,
        checkoutUrl TEXT,
        providerStatus TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        paidAt INTEGER
      );
      CREATE TABLE IF NOT EXISTS email_jobs (
        bookingId TEXT PRIMARY KEY REFERENCES bookings(id),
        "to" TEXT NOT NULL,
        subject TEXT NOT NULL,
        text TEXT NOT NULL,
        messageId TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,
        nextRunAt INTEGER NOT NULL,
        leaseUntil INTEGER NOT NULL DEFAULT 0,
        lastError TEXT
      );
      CREATE TABLE IF NOT EXISTS verification_jobs (
        paymentId TEXT PRIMARY KEY,
        attempts INTEGER NOT NULL DEFAULT 0,
        nextRunAt INTEGER NOT NULL,
        createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS checks_due ON verification_jobs(nextRunAt);
      CREATE INDEX IF NOT EXISTS emails_due ON email_jobs(status, nextRunAt, leaseUntil);
      CREATE TABLE IF NOT EXISTS demo_payments (
        paymentId TEXT PRIMARY KEY,
        bookingId TEXT NOT NULL UNIQUE REFERENCES bookings(id),
        status TEXT NOT NULL DEFAULT 'Created'
      );
    `);
    const checkColumns = this.db.prepare('PRAGMA table_info(verification_jobs)').all() as { name: string }[];
    if (!checkColumns.some(column => column.name === 'createdAt')) {
      this.db.exec('ALTER TABLE verification_jobs ADD COLUMN createdAt INTEGER NOT NULL DEFAULT 0');
      this.db.prepare('UPDATE verification_jobs SET createdAt=? WHERE createdAt=0').run(Date.now());
    }
    this.db.prepare('INSERT OR IGNORE INTO settings VALUES (?, ?)').run('provider', provider);
    const stored = this.db.prepare('SELECT value FROM settings WHERE key = ?').get('provider') as { value: string };
    if (stored.value !== provider) {
      this.db.close();
      throw new Error('Use a different DB_PATH for demo and TBC payments.');
    }
  }

  close(): void { this.db.close(); }
  booking(id: string): Booking | undefined { return this.db.prepare('SELECT * FROM bookings WHERE id = ?').get(id) as Booking | undefined; }
  byKey(key: string): Booking | undefined { return this.db.prepare('SELECT * FROM bookings WHERE requestKey = ?').get(key) as Booking | undefined; }
  byPayment(paymentId: string): Booking | undefined { return this.db.prepare('SELECT * FROM bookings WHERE paymentId = ?').get(paymentId) as Booking | undefined; }

  insert(booking: Booking): void {
    this.db.prepare(`INSERT INTO bookings (
      id,requestKey,inputHash,tokenHash,tourId,tourTitle,date,guests,name,email,phone,notes,
      totalMinor,currency,provider,status,paymentId,checkoutUrl,providerStatus,createdAt,updatedAt,paidAt
    ) VALUES (
      @id,@requestKey,@inputHash,@tokenHash,@tourId,@tourTitle,@date,@guests,@name,@email,@phone,@notes,
      @totalMinor,@currency,@provider,@status,@paymentId,@checkoutUrl,@providerStatus,@createdAt,@updatedAt,@paidAt
    )`).run(booking);
  }

  bindPayment(id: string, paymentId: string, checkoutUrl: string | null): void {
    this.db.transaction(() => {
      const current = this.booking(id);
      if (!current || (current.paymentId && current.paymentId !== paymentId)) throw new Error('Payment mapping conflict.');
      this.db.prepare(`UPDATE bookings SET paymentId = ?, checkoutUrl = COALESCE(?, checkoutUrl),
        status = CASE WHEN status IN ('creating','unknown') THEN 'pending' ELSE status END,
        updatedAt = ? WHERE id = ?`).run(paymentId, checkoutUrl, Date.now(), id);
      this.enqueueCheck(paymentId);
    })();
  }

  creationUnknown(id: string): void {
    this.db.prepare(`UPDATE bookings SET status = 'unknown', providerStatus = 'CreationUncertain', updatedAt = ?
      WHERE id = ? AND status = 'creating'`).run(Date.now(), id);
  }

  recoverInterruptedCreation(): void {
    // A prior process may have stopped after POSTing to the bank. Never repeat that POST automatically.
    this.db.prepare(`UPDATE bookings SET status='unknown', providerStatus='CreationUncertain', updatedAt=?
      WHERE status='creating' AND createdAt < ?`).run(Date.now(), Date.now() - 60_000);
  }

  setState(id: string, status: BookingStatus, providerStatus: string): void {
    this.db.prepare(`UPDATE bookings SET status = ?, providerStatus = ?, updatedAt = ?
      WHERE id = ? AND (paidAt IS NULL OR ? = 'review')`).run(status, providerStatus, Date.now(), id, status);
  }

  confirmPaid(id: string, message: MailMessage): void {
    this.db.transaction(() => {
      const booking = this.booking(id);
      if (!booking || booking.paidAt !== null) return;
      const now = Date.now();
      this.db.prepare(`UPDATE bookings SET status='paid', providerStatus='Succeeded', paidAt=?, updatedAt=? WHERE id=?`).run(now, now, id);
      // Payment state and notification are committed together. One outbox job per booking.
      this.db.prepare(`INSERT INTO email_jobs (bookingId,"to",subject,text,messageId,nextRunAt)
        VALUES (@bookingId,@to,@subject,@text,@messageId,@nextRunAt)
        ON CONFLICT(bookingId) DO NOTHING`).run({ ...message, bookingId: id, nextRunAt: now });
    })();
  }

  email(id: string): EmailJob | undefined {
    return this.db.prepare('SELECT * FROM email_jobs WHERE bookingId = ?').get(id) as EmailJob | undefined;
  }

  claimEmail(): EmailJob | undefined {
    return this.db.transaction(() => {
      const now = Date.now();
      const row = this.db.prepare(`SELECT * FROM email_jobs WHERE
        (status='queued' AND nextRunAt<=?) OR (status='sending' AND leaseUntil<=?)
        ORDER BY nextRunAt LIMIT 1`).get(now, now) as EmailJob | undefined;
      if (!row) return;
      this.db.prepare(`UPDATE email_jobs SET status='sending', leaseUntil=?, attempts=attempts+1 WHERE bookingId=?`).run(now + 120_000, row.bookingId);
      return { ...row, status: 'sending' as const, attempts: row.attempts + 1 };
    }).immediate();
  }

  finishEmail(id: string, status: 'sent' | 'preview'): void {
    this.db.prepare('UPDATE email_jobs SET status=?, leaseUntil=0, lastError=NULL WHERE bookingId=?').run(status, id);
  }

  retryEmail(job: EmailJob): void {
    const delay = Math.min(3_600_000, 15_000 * 2 ** Math.min(job.attempts - 1, 8));
    this.db.prepare(`UPDATE email_jobs SET status='queued', leaseUntil=0, nextRunAt=?, lastError='Delivery failed; retry scheduled' WHERE bookingId=?`).run(Date.now() + delay, job.bookingId);
  }

  enqueueCheck(paymentId: string): void {
    const now = Date.now();
    this.db.prepare(`INSERT INTO verification_jobs(paymentId,nextRunAt,createdAt) VALUES (?,?,?)
      ON CONFLICT(paymentId) DO UPDATE SET nextRunAt=MIN(nextRunAt,excluded.nextRunAt)`).run(paymentId, now, now);
  }
  dueChecks(limit = 4): VerificationJob[] {
    return this.db.prepare('SELECT * FROM verification_jobs WHERE nextRunAt<=? ORDER BY nextRunAt LIMIT ?').all(Date.now(), limit) as VerificationJob[];
  }
  deferCheck(job: VerificationJob, seconds: number): void {
    this.db.prepare('UPDATE verification_jobs SET nextRunAt=?, attempts=attempts+1 WHERE paymentId=?').run(Date.now() + seconds * 1000, job.paymentId);
  }
  removeCheck(paymentId: string): void { this.db.prepare('DELETE FROM verification_jobs WHERE paymentId=?').run(paymentId); }

  createDemoPayment(booking: Booking): string {
    const paymentId = `demo_${booking.id}`;
    this.db.prepare('INSERT OR IGNORE INTO demo_payments(paymentId,bookingId) VALUES (?,?)').run(paymentId, booking.id);
    return paymentId;
  }
  completeDemoPayment(paymentId: string, outcome: 'success' | 'failure'): void {
    this.db.prepare("UPDATE demo_payments SET status=? WHERE paymentId=? AND status='Created'").run(outcome === 'success' ? 'Succeeded' : 'Failed', paymentId);
  }
  demoSnapshot(paymentId: string): PaymentSnapshot {
    const row = this.db.prepare(`SELECT p.status,p.paymentId,p.bookingId,b.totalMinor,b.currency
      FROM demo_payments p JOIN bookings b ON b.id=p.bookingId WHERE p.paymentId=?`).get(paymentId) as
      { status: string; paymentId: string; bookingId: string; totalMinor: number; currency: string } | undefined;
    if (!row) throw new Error('Demo payment not found.');
    return { paymentId: row.paymentId, status: row.status, reference: row.bookingId, totalMinor: row.totalMinor, currency: row.currency, preAuth: false };
  }
}
