export type BookingStatus = 'creating' | 'pending' | 'paid' | 'failed' | 'expired' | 'unknown' | 'review';

export interface BookingInput {
  tourId: string;
  date: string;
  guests: number;
  name: string;
  email: string;
  phone: string;
  notes: string;
}

export interface Booking extends BookingInput {
  id: string;
  requestKey: string;
  inputHash: string;
  tokenHash: string;
  tourTitle: string;
  totalMinor: number;
  currency: 'GEL';
  provider: 'demo' | 'tbc';
  status: BookingStatus;
  paymentId: string | null;
  checkoutUrl: string | null;
  providerStatus: string | null;
  createdAt: number;
  updatedAt: number;
  paidAt: number | null;
}

export interface CreatedPayment {
  paymentId: string;
  checkoutUrl: string | null;
}

export interface PaymentSnapshot {
  paymentId: string;
  status: string;
  totalMinor: number;
  currency: string;
  reference: string;
  preAuth: boolean;
}

export interface PaymentProvider {
  create(booking: Booking): Promise<CreatedPayment>;
  get(paymentId: string): Promise<PaymentSnapshot>;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  messageId: string;
}
