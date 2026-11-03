'use strict';

// The server owns prices and payment confirmation. Browser redirects are not proof of payment.
const $ = (id) => document.getElementById(id);
const form = $('bookingForm');
const dialog = $('bookingDialog');
const money = (minor) => {
  if (!Number.isSafeInteger(minor) || minor < 0) return '—';
  const whole = String(Math.floor(minor / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${whole}.${String(minor % 100).padStart(2, '0')} ₾`;
};
const georgianMonths = ['იანვარი', 'თებერვალი', 'მარტი', 'აპრილი', 'მაისი', 'ივნისი', 'ივლისი', 'აგვისტო', 'სექტემბერი', 'ოქტომბერი', 'ნოემბერი', 'დეკემბერი'];
const humanDate = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '—';
  const parsed = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return '—';
  const [year, month, day] = value.split('-').map(Number);
  return `${day} ${georgianMonths[month - 1]}, ${year}`;
};
const resolvedStatuses = new Set(['paid', 'failed', 'expired']);
let config;
let active = null;
let attempt = null;
let submitting = false;
let polling = false;
let pollTimer;
let pollCount = 0;
let storageAvailable = true;

function storageRead(key) {
  try { return sessionStorage.getItem(key); } catch { storageAvailable = false; return null; }
}
function storageWrite(key, value) {
  try { sessionStorage.setItem(key, value); } catch { storageAvailable = false; }
}
function storageRemove(key) {
  try { sessionStorage.removeItem(key); } catch { storageAvailable = false; }
}
try { sessionStorage.setItem('mta:storage-check', '1'); sessionStorage.removeItem('mta:storage-check'); } catch { storageAvailable = false; }
try { attempt = JSON.parse(storageRead('mta:attempt') || 'null'); } catch { attempt = null; }

class ApiError extends Error {
  constructor(message, status = 0) { super(message); this.status = status; }
}
async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, { ...options, headers: { Accept: 'application/json', ...options.headers }, signal: AbortSignal.timeout(45000), credentials: 'same-origin', cache: 'no-store' });
  } catch {
    throw new ApiError('სერვერთან კავშირი ვერ დასრულდა. მოთხოვნა შესაძლოა მიღებული იყოს — გამოიყენე ხელახალი შემოწმება.');
  }
  let data;
  try { data = await response.json(); } catch { throw new ApiError('სერვერმა მოულოდნელი პასუხი დააბრუნა. სცადე სტატუსის განახლება.', response.status); }
  if (!response.ok) throw new ApiError(typeof data.error === 'string' ? data.error : 'მოთხოვნა ვერ შესრულდა. შეამოწმე მონაცემები და სცადე ხელახლა.', response.status);
  return data;
}
function setError(target, message = '') {
  target.textContent = message;
  target.hidden = !message;
}
function inputValues() {
  return { tourId: $('tourId').value, date: $('date').value, guests: Number($('guests').value), name: $('name').value.trim(), email: $('email').value.trim(), phone: $('phone').value.trim(), notes: $('notes').value.trim() };
}
function restoreValues(values) {
  for (const [key, value] of Object.entries(values)) { const element = $(key); if (element && 'value' in element) element.value = String(value); }
  updateSummary();
}
function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (value) => value.toString(16).padStart(2, '0')).join('');
}
function randomRequestKey() {
  // getRandomValues is available on local HTTP previews too; randomness remains cryptographic.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function persistAttempt() { storageWrite('mta:attempt', JSON.stringify(attempt)); }
function rememberBooking(view, token) {
  active = { view, token };
  storageWrite(`booking:${view.bookingId}`, token);
  storageWrite('mta:active', view.bookingId);
  renderBooking();
}
function bookingHeaders() { return { Authorization: `Bearer ${active.token}` }; }
function updateSummary() {
  if (!config) return;
  const selected = config.tours.find((tour) => tour.id === $('tourId').value);
  const guests = Number($('guests').value);
  const validGuests = Number.isInteger(guests) && guests >= 1 && guests <= config.maxGuests;
  $('summaryTour').textContent = selected?.title || 'აირჩიე ტური';
  $('summaryDescription').textContent = selected?.description || 'ყველა მნიშვნელოვანი დეტალი ერთ ადგილას.';
  $('summaryDate').textContent = $('date').value ? humanDate($('date').value) : '—';
  $('summaryGuests').textContent = validGuests ? `${guests} ადამიანი` : 'აირჩიე რაოდენობა';
  $('summaryPrice').textContent = selected ? money(selected.priceMinor) : '—';
  $('summaryTotal').textContent = selected && validGuests ? money(selected.priceMinor * guests) : '—';
  document.querySelectorAll('.tour-card').forEach((card) => {
    const isSelected = card.dataset.tour === selected?.id;
    card.classList.toggle('selected', isSelected);
    const button = card.querySelector('.select-tour');
    button.setAttribute('aria-pressed', String(isSelected));
    button.firstChild.textContent = isSelected ? 'არჩეულია ' : 'არჩევა ';
    button.lastElementChild.textContent = isSelected ? '✓' : '↗';
  });
}
function renderTours() {
  $('tourCards').replaceChildren();
  $('tourId').replaceChildren();
  for (const tour of config.tours) {
    const option = new Option(tour.title, tour.id);
    $('tourId').append(option);
    const fragment = $('tourCardTemplate').content.cloneNode(true);
    const card = fragment.querySelector('.tour-card');
    card.dataset.tour = tour.id;
    card.querySelector('h3').textContent = tour.title;
    card.querySelector('.tour-tag').textContent = tour.tag;
    card.querySelector('.tour-duration').textContent = tour.duration;
    card.querySelector('.tour-description').textContent = tour.description;
    card.querySelector('.tour-card-price strong').textContent = money(tour.priceMinor);
    const button = card.querySelector('button');
    button.setAttribute('aria-label', `${tour.title} — ტურის არჩევა`);
    button.addEventListener('click', () => {
      $('tourId').value = tour.id;
      updateSummary();
      $('booking').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    });
    $('tourCards').append(fragment);
  }
}
function setBusy(value) {
  submitting = value;
  $('submitBooking').disabled = value || !config;
  $('bookingFields').disabled = value || !config;
  $('submitBooking').setAttribute('aria-busy', String(value));
  $('submitLabel').textContent = value ? 'მოთხოვნა მუშავდება…' : config?.mode === 'demo' ? 'საცდელი გადახდა' : 'გადახდაზე გადასვლა';
  $('submitArrow').textContent = value ? '· · ·' : '↗';
  $('retrySubmit').disabled = value;
}
async function submitBooking(values, isRetry = false) {
  if (submitting) return;
  setError($('formError'));
  if (active && !resolvedStatuses.has(active.view.status)) { openDialog(); return; }
  if (active) { openDialog(); return; }
  if (!storageAvailable && config.mode === 'tbc') { setError($('formError'), 'ბრაუზერში სესიის შენახვა გამორთულია. ჩართე საიტის მონაცემების შენახვა, რათა ბანკიდან დაბრუნებისას ჯავშნის სტატუსი ნახო.'); return; }
  const signature = JSON.stringify(values);
  if (attempt?.uncertain && attempt.signature !== signature && !isRetry) {
    setError($('formError'), 'წინა მოთხოვნის შედეგი ჯერ გაურკვეველია. გამოიყენე „წინა მოთხოვნის ხელახლა შემოწმება“, რათა შემთხვევით მეორე ჯავშანი არ შეიქმნას.');
    $('retrySubmit').hidden = false;
    return;
  }
  if (!attempt || attempt.signature !== signature) attempt = { key: randomRequestKey(), token: randomToken(), payload: values, signature, uncertain: false };
  attempt.uncertain = true;
  persistAttempt();
  setBusy(true);
  try {
    const view = await api('/api/bookings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': attempt.key, 'X-Booking-Token': attempt.token }, body: JSON.stringify(attempt.payload) });
    rememberBooking(view, attempt.token);
    attempt.uncertain = false;
    persistAttempt();
    $('retrySubmit').hidden = true;
    openDialog();
    if (view.mode === 'tbc' && view.checkoutUrl && view.status === 'pending') goToBank();
    else schedulePoll();
  } catch (error) {
    if (error.status >= 400 && error.status < 500 && error.status !== 409) {
      attempt = null;
      storageRemove('mta:attempt');
    }
    $('retrySubmit').hidden = !attempt?.uncertain;
    setError($('formError'), error.message);
  } finally { setBusy(false); }
}
function openDialog() { if (!dialog.open) dialog.showModal(); renderBooking(); }
function renderBooking() {
  if (!active) return;
  const view = active.view;
  const demo = view.mode === 'demo';
  const states = {
    creating: ['გადახდა მზადდება', 'ჯავშანი მიღებულია. ველოდებით გადახდის გვერდის შექმნას. გთხოვ, ახალი ჯავშანი ჯერ არ შექმნა.', '↗'],
    pending: [demo ? 'შეამოწმე საცდელი გადახდა' : 'გადახდის მოლოდინში', demo ? 'აირჩიე წარმატებული ან წარუმატებელი შედეგი და ნახე, როგორ შეიცვლება ჯავშანი.' : 'ჯავშანი ჯერ გადახდილი არ არის. გადახდა ბანკის გვერდზე დაასრულე; შედეგს სერვერი გადაამოწმებს.', '↗'],
    paid: [demo ? 'საცდელი ჯავშანი დადასტურდა' : 'ტური დაჯავშნილია', demo ? 'სიმულაცია წარმატებით დასრულდა. ქვემოთ ნახავ მფლობელისთვის მომზადებულ შეტყობინებას.' : 'ბანკმა გადახდა დაადასტურა და შენი ჯავშანი შენახულია.', '✓'],
    failed: ['გადახდა ვერ დასრულდა', 'ეს ჯავშანი დადასტურებული არ არის. საჭიროების შემთხვევაში შეგიძლია ახალი ჯავშანი დაიწყო.', '×'],
    expired: ['გადახდის დრო ამოიწურა', 'გადახდა არ დადასტურებულა. ახალი მცდელობისთვის დაიწყე ახალი ჯავშანი.', '◷'],
    unknown: ['გადახდის შედეგი მოწმდება', 'ბანკის პასუხი ჯერ არ არის დაზუსტებული. ხელახლა არ გადაიხადო და ახალი ჯავშანი არ შექმნა, სანამ ორგანიზატორი ამ გადახდას არ გადაამოწმებს.', '?'],
    review: ['საჭიროა გადახდის შემოწმება', 'გადახდის მონაცემები დამატებით შემოწმებას საჭიროებს. ხელახლა არ გადაიხადო; ორგანიზატორს მიაწოდე ქვემოთ მოცემული ჯავშნის ნომერი.', '?']
  };
  const [title, description, icon] = states[view.status] || states.unknown;
  $('dialogTitle').textContent = title;
  $('dialogDescription').textContent = description;
  $('dialogIcon').textContent = icon;
  $('dialogIcon').className = `dialog-icon${view.status === 'paid' ? ' success' : ['failed', 'expired', 'unknown', 'review'].includes(view.status) ? ' error' : ''}`;
  $('dialogEyebrow').textContent = demo ? 'საცდელი ჯავშანი · თანხა არ ჩამოგეჭრება' : 'შენი ჯავშანი';
  $('dialogTour').textContent = view.tourTitle;
  $('dialogDate').textContent = `${humanDate(view.date)} · ${view.guests} ადამიანი`;
  $('dialogAmount').textContent = money(view.totalMinor);
  $('dialogBookingId').textContent = view.bookingId;
  $('demoActions').hidden = !(demo && view.status === 'pending');
  $('bankActions').hidden = !(!demo && view.status === 'pending' && view.checkoutUrl);
  $('newBooking').hidden = !resolvedStatuses.has(view.status);
  $('refreshStatus').hidden = ['failed', 'expired'].includes(view.status);
  $('activeBanner').hidden = false;
  $('activeBannerText').textContent = `${view.tourTitle} · ${title}`;
  const notification = {
    not_queued: 'გადახდის დადასტურება შენახულია. შეტყობინების მომზადება მოწმდება.',
    queued: config.emailMode === 'preview' ? 'მფლობელის შეტყობინების საცდელი ვერსია მზადდება…' : 'მფლობელის ელფოსტის შეტყობინება გაგზავნის რიგშია.',
    sent: 'მფლობელის შეტყობინება ელფოსტის სერვისმა მიიღო.',
    preview: 'მფლობელის შეტყობინების საცდელი ვერსია მზადაა. რეალური ელფოსტა არ გაგზავნილა.',
    retrying: 'ჯავშანი დადასტურებულია. შეტყობინების გაგზავნა ავტომატურად განმეორდება; ჯავშანი შენახულია.'
  };
  $('notificationStatus').hidden = view.status !== 'paid';
  $('notificationStatus').textContent = notification[view.notificationStatus] || notification.queued;
  $('emailPreview').hidden = !(demo && view.demoEmail);
  if (demo && view.demoEmail) {
    $('emailTo').textContent = view.demoEmail.to;
    $('emailSubject').textContent = view.demoEmail.subject;
    $('emailBody').textContent = view.demoEmail.text;
  }
}
function goToBank() {
  if (!active || active.view.mode !== 'tbc' || active.view.status !== 'pending') return;
  try {
    const url = new URL(active.view.checkoutUrl);
    if (url.protocol !== 'https:') throw new Error('Unsupported payment URL');
    window.location.assign(url.href);
  } catch { setError($('dialogError'), 'ბანკის გადახდის ბმული ვერ გაიხსნა. გამოიყენე სტატუსის განახლება ან მიმართე ორგანიზატორს.'); }
}
async function fetchBooking(refresh = false) {
  if (!active || polling) return;
  polling = true;
  const currentId = active.view.bookingId;
  try {
    const view = await api(`/api/bookings/${encodeURIComponent(currentId)}${refresh ? '/refresh' : ''}`, { method: refresh ? 'POST' : 'GET', headers: bookingHeaders() });
    if (active?.view.bookingId === currentId) { active.view = view; renderBooking(); setError($('dialogError')); }
  } catch (error) { if (dialog.open) setError($('dialogError'), error.message); }
  finally { polling = false; }
}
function schedulePoll() {
  clearTimeout(pollTimer);
  if (!active || pollCount >= 40) return;
  const view = active.view;
  const finished = ['failed', 'expired', 'review', 'unknown'].includes(view.status) || (view.status === 'paid' && ['sent', 'preview'].includes(view.notificationStatus));
  if (finished) return;
  pollTimer = setTimeout(async () => {
    pollCount += 1;
    await fetchBooking(false);
    schedulePoll();
  }, pollCount < 8 ? 1500 : 5000);
}
async function completeDemo(outcome) {
  if (!active || active.view.mode !== 'demo' || active.view.status !== 'pending') return;
  $('demoSuccess').disabled = true;
  $('demoFailure').disabled = true;
  setError($('dialogError'));
  try {
    const view = await api(`/api/demo/bookings/${encodeURIComponent(active.view.bookingId)}/complete`, { method: 'POST', headers: { ...bookingHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ outcome }) });
    active.view = view;
    renderBooking();
    pollCount = 0;
    schedulePoll();
  } catch (error) { setError($('dialogError'), error.message); }
  finally { $('demoSuccess').disabled = false; $('demoFailure').disabled = false; }
}
async function restoreBooking() {
  const returnId = new URLSearchParams(location.search).get('booking');
  const id = returnId || storageRead('mta:active');
  if (!id) {
    if (attempt?.uncertain && attempt.payload) { restoreValues(attempt.payload); $('retrySubmit').hidden = false; setError($('formError'), 'წინა მოთხოვნის შედეგი ჯერ არ არის დადგენილი. მის შესამოწმებლად გამოიყენე ქვემოთ მოცემული ღილაკი.'); }
    return;
  }
  const token = storageRead(`booking:${id}`);
  if (!token) { if (returnId) setError($('formError'), 'ამ ბრაუზერში ჯავშნის წვდომის გასაღები ვერ მოიძებნა. გახსენი გვერდი იმავე ბრაუზერში, საიდანაც დაჯავშნე, ან მიაწოდე ორგანიზატორს შენი ჯავშნის ნომერი. URL-ის მიხედვით გადახდა ვერ დადასტურდება.'); return; }
  try {
    const view = await api(`/api/bookings/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` } });
    rememberBooking(view, token);
    if (attempt?.payload) restoreValues(attempt.payload);
    if (returnId || !resolvedStatuses.has(view.status)) openDialog();
    if (returnId) await fetchBooking(true);
    pollCount = 0;
    schedulePoll();
  } catch (error) { setError($('formError'), error.message); }
}
async function init() {
  $('loadError').hidden = true;
  try {
    config = await api('/api/config');
    renderTours();
    $('date').min = config.today;
    $('date').max = config.maxDate;
    $('date').value = config.today;
    $('guests').max = String(config.maxGuests);
    $('modeNotice').hidden = config.mode !== 'demo';
    if (config.mode === 'demo') {
      $('priceNote').textContent = 'საცდელი ფასი · რეალური თანხა არ ჩამოგეჭრება';
      $('paymentNote').textContent = 'ნახავ გადახდის სიმულაციასა და მფლობელის შეტყობინების მაგალითს.';
      $('howPayment').textContent = 'საცდელ ფანჯარაში შეამოწმე წარმატებული ან წარუმატებელი გადახდა — რეალური თანხის გარეშე.';
      $('howNotification').textContent = 'დადასტურებულ ჯავშანზე ნახავ მფლობელისთვის მომზადებული ელფოსტის საცდელ ვერსიას.';
      $('footerMode').textContent = 'ტურის დაჯავშნის საცდელი ვერსია';
    } else {
      $('priceNote').textContent = 'ჯამი: ერთი ადამიანის ფასი × მგზავრების რაოდენობა';
      $('paymentNote').textContent = 'გადახდას TBC-ის გვერდზე დაასრულებ. დადასტურება გამოჩნდება ბანკის პასუხის შემოწმების შემდეგ.';
      $('howPayment').textContent = 'გადადიხარ TBC-ის გადახდის გვერდზე. ბარათის მონაცემები მხოლოდ ბანკის გვერდზე შეგყავს.';
      $('footerMode').textContent = 'ტურის დაჯავშნა · გადახდა TBC-ის საშუალებით';
    }
    setBusy(false);
    updateSummary();
    await restoreBooking();
  } catch (error) {
    $('loadErrorText').textContent = `${error.message} პროექტი გაუშვი Node.js სერვერით, ინსტრუქციის მიხედვით.`;
    $('loadError').hidden = false;
  }
}

form.addEventListener('submit', (event) => { event.preventDefault(); if (config && form.reportValidity()) void submitBooking(inputValues()); });
form.addEventListener('input', updateSummary);
form.addEventListener('change', updateSummary);
$('retrySubmit').addEventListener('click', () => { if (attempt?.payload) { restoreValues(attempt.payload); void submitBooking(attempt.payload, true); } });
$('viewBooking').addEventListener('click', openDialog);
$('closeDialog').addEventListener('click', () => dialog.close());
$('demoSuccess').addEventListener('click', () => void completeDemo('success'));
$('demoFailure').addEventListener('click', () => void completeDemo('failure'));
$('continuePayment').addEventListener('click', goToBank);
$('refreshStatus').addEventListener('click', async () => { $('refreshStatus').disabled = true; await fetchBooking(true); pollCount = 0; schedulePoll(); $('refreshStatus').disabled = false; });
$('newBooking').addEventListener('click', () => {
  if (!active || !resolvedStatuses.has(active.view.status)) return;
  clearTimeout(pollTimer);
  active = null;
  attempt = null;
  pollCount = 0;
  storageRemove('mta:active');
  storageRemove('mta:attempt');
  history.replaceState(null, '', location.pathname);
  $('activeBanner').hidden = true;
  $('retrySubmit').hidden = true;
  setError($('formError'));
  setError($('dialogError'));
  dialog.close();
  $('booking').scrollIntoView({ behavior: 'smooth' });
  $('date').focus({ preventScroll: true });
});
$('reloadConfig').addEventListener('click', () => void init());
void init();
