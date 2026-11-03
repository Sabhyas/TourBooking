import nodemailer from 'nodemailer';
import type { Config } from './config.js';
import type { Booking, MailMessage } from './types.js';

export type SendMail = (message: MailMessage) => Promise<'sent' | 'preview'>;

export function ownerMessage(booking: Booking, ownerEmail: string): MailMessage {
  const price = (booking.totalMinor / 100).toFixed(2);
  return {
    to: ownerEmail,
    subject: `${booking.provider === 'demo' ? '[DEMO] ' : ''}ახალი გადახდილი ჯავშანი · ${booking.tourTitle}`,
    messageId: `<tour-booking-${booking.id}@tour-booking.local>`,
    text: [
      booking.provider === 'demo' ? 'საცდელი შეტყობინება — რეალური თანხა არ ჩამოჭრილა.' : 'ტური დაჯავშნილია. გადახდა ბანკთან გადამოწმებულია.',
      '',
      `ჯავშნის ნომერი: ${booking.id}`,
      `ტური: ${booking.tourTitle}`,
      `ტურის თარიღი: ${booking.date} (საქართველოს დროით)`,
      `მოგზაურების რაოდენობა: ${booking.guests}`,
      `მომხმარებელი: ${booking.name}`,
      `ელფოსტა: ${booking.email}`,
      `ტელეფონი: ${booking.phone}`,
      `თანხა: ${price} GEL`,
      `გადახდის ნომერი: ${booking.paymentId ?? '—'}`,
      `შენიშვნა: ${booking.notes || '—'}`,
      '',
      'სტატუსი: გადახდილია'
    ].join('\n')
  };
}

export function createMailSender(cfg: Config): SendMail {
  if (cfg.EMAIL_TRANSPORT === 'preview') return async () => 'preview';
  const transport = nodemailer.createTransport({
    host: cfg.SMTP_HOST,
    port: cfg.SMTP_PORT,
    secure: cfg.SMTP_SECURE,
    requireTLS: !cfg.SMTP_SECURE,
    auth: { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    disableFileAccess: true,
    disableUrlAccess: true
  });
  return async message => {
    const info = await transport.sendMail({ from: cfg.MAIL_FROM, ...message });
    if (!info.accepted || info.accepted.length !== 1 || info.rejected.length) throw new Error('Mail not accepted.');
    return 'sent';
  };
}
