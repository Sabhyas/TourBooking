import { Repository } from './db.js';
import { ownerMessage, type SendMail } from './mail.js';
import type { Booking, PaymentProvider } from './types.js';

export class DemoPaymentProvider implements PaymentProvider {
  constructor(private readonly repo: Repository) {}
  async create(booking: Booking) { return { paymentId: this.repo.createDemoPayment(booking), checkoutUrl: null }; }
  async get(paymentId: string) { return this.repo.demoSnapshot(paymentId); }
}

export class BookingService {
  private running = false;
  constructor(
    readonly repo: Repository,
    readonly provider: PaymentProvider,
    private readonly ownerEmail: string,
    private readonly sendMail: SendMail
  ) {}

  async initializePayment(booking: Booking): Promise<void> {
    try {
      const payment = await this.provider.create(booking);
      this.repo.bindPayment(booking.id, payment.paymentId, payment.checkoutUrl);
    } catch {
      // Even a timeout may mean that the bank accepted the POST. Never auto-retry it.
      this.repo.creationUnknown(booking.id);
      console.warn('Payment creation needs review for booking', booking.id);
    }
  }

  private async verify(paymentId: string): Promise<boolean> {
    const result = await this.provider.get(paymentId);
    let booking = this.repo.byPayment(paymentId);
    // Recover the POST-response crash window using the bank-authenticated extra2 reference.
    if (!booking) {
      const candidate = this.repo.booking(result.reference);
      if (!candidate || candidate.paymentId || !['creating', 'unknown'].includes(candidate.status)) return true;
      booking = candidate;
    }
    if (result.paymentId !== paymentId || result.reference !== booking.id || result.totalMinor !== booking.totalMinor || result.currency !== booking.currency || result.preAuth) {
      this.repo.setState(booking.id, 'review', 'VerificationMismatch');
      return true;
    }
    if (!booking.paymentId) {
      this.repo.bindPayment(booking.id, paymentId, null);
      booking = this.repo.booking(booking.id)!;
    }
    if (result.status === 'Succeeded') {
      this.repo.confirmPaid(booking.id, ownerMessage(booking, this.ownerEmail));
      return true;
    }
    if (['Failed', 'Expired'].includes(result.status)) {
      this.repo.setState(booking.id, result.status === 'Expired' ? 'expired' : 'failed', result.status);
      return true;
    }
    if (['WaitingConfirm', 'Returned', 'PartialReturned'].includes(result.status)) {
      this.repo.setState(booking.id, 'review', result.status);
      return true;
    }
    this.repo.setState(booking.id, 'pending', result.status);
    return false;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.repo.recoverInterruptedCreation();
      // Email is independent of browser redirects and survives a server restart.
      for (let i = 0; i < 4; i++) {
        const job = this.repo.claimEmail();
        if (!job) break;
        try { this.repo.finishEmail(job.bookingId, await this.sendMail(job)); }
        catch { this.repo.retryEmail(job); console.warn('Owner email will be retried for booking', job.bookingId); }
      }
      for (const job of this.repo.dueChecks()) {
        try {
          if (await this.verify(job.paymentId)) this.repo.removeCheck(job.paymentId);
          else this.repo.deferCheck(job, 30);
        } catch {
          // An unlinked callback can be legitimate after an interrupted create request.
          // Keep it for at least 24 hours during bank outages. Known payments keep retrying.
          if (!this.repo.byPayment(job.paymentId) && Date.now() - job.createdAt > 86_400_000) this.repo.removeCheck(job.paymentId);
          else this.repo.deferCheck(job, Math.min(300, 5 * 2 ** Math.min(job.attempts, 6)));
        }
      }
    } finally { this.running = false; }
  }
}
