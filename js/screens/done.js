/**
 * Done screen: confirmation after the enquiry has been handed over.
 * Everything shown here is read from the submitted payload, so it is exactly what the
 * company received (or, in demo mode, what it would have received).
 */

import { submitLead } from '../lead.js';
import { formatMoney, formatLength } from '../quote.js';

/** Screen id, used for routing and the `sm-screen--done` class. */
export const id = 'done';

/** Progress step this screen belongs to. */
export const step = 4;

/** Default copy for this screen; any key can be overridden through `config.text`. */
export const strings = {
  'done.title': "Thanks, we've got your details",
  'done.message': "We'll be in touch shortly to book your free check measure.",
  'done.referenceLabel': 'Your reference',
  'done.summaryHeading': 'Your enquiry',
  'done.summarySize': 'Size',
  'done.sizeValue': '{width} wide × {height} high',
  'done.summaryProduct': 'Door',
  'done.optionAdded': 'Added',
  'done.installation': 'Installation',
  'done.included': 'Included',
  'done.notIncluded': 'Not included',
  'done.summaryTotal': 'Estimated total',
  'done.summaryPrice': 'Price',
  'done.taxNote': 'inc. {tax}',
  'done.customQuote': 'Custom quote',
  'done.customQuoteNote': "We'll confirm your price when we call.",
  'done.nextHeading': 'What happens next',
  'done.next1': 'We call you to book a free check measure.',
  'done.next2': 'We confirm your final price.',
  'done.next3': 'We make and fit your door.',
  // Used instead of done.next3 when the enquiry does not include installation.
  'done.next3Supply': 'We make your door.',
  'done.call': 'Call us on {phone}',
  // Email-link (lead.mailto) mode: these two replace the title and message until the customer has pressed send.
  'done.mailtoTitle': 'One more step: send the email',
  'done.mailtoNote': "Your email app should have opened with your enquiry filled in. Press send there and we'll be in touch.",
  'done.mailtoRetry': 'Open the email again',
  // Shown when the size came from the bundled demo photo (not the same thing as demo mode below).
  'done.demoDoor': 'You measured our demo door, not your own, so this enquiry is marked as a demo.',
  'done.demoSummary': 'Demo mode: this is what would be sent to your system',
  'done.demoHint': 'Nothing was sent. Set lead.endpoint or lead.mailto in js/config.js to start receiving enquiries.',
  'done.payloadLabel': 'Enquiry data',
  'done.photoPlaceholder': '[{type} data URL, {size} kB]',
  'done.startAgain': 'Start again',
};

/**
 * Route guard: only reachable once an enquiry has been submitted.
 * @param {object} state shared app state
 * @returns {boolean}
 */
export function canEnter(state) {
  return Boolean(state && state.submission);
}

/**
 * Build the screen inside `root`.
 * @param {HTMLElement} root the empty <section> for this screen
 * @param {object} ctx app context (config, t, state, reset, ui, ...)
 * @returns {undefined}
 */
export function mount(root, ctx) {
  const { config, ui } = ctx;
  const t = (key, vars) => ctx.t(key, vars);
  const { payload, result } = ctx.state.submission;
  const mode = result?.mode;
  const phone = String(config.brand?.phone ?? '').trim();
  // Nothing has reached the company until the customer presses send in their email app, so in
  // email-link mode the screen asks for that last step instead of saying the enquiry is in.
  const awaitingEmail = mode === 'mailto';

  // Wording set through config.text wins, as it does for every other id; then the lead setting.
  const worded = (key, leadSetting) => (hasText(config, key) ? t(key) : leadSetting || t(key));

  const parts = [];
  if (awaitingEmail) {
    parts.push(
      ui.screenHeader({ title: t('done.mailtoTitle'), subtitle: t('done.mailtoNote') }),
      ui.button(t('done.mailtoRetry'), {
        variant: 'secondary',
        size: 'md',
        onClick: () => {
          submitLead(config, payload).catch(() => {});
        },
      }),
    );
  } else {
    parts.push(
      ui.h('div', { class: 'sm-done-mark', attrs: { 'aria-hidden': 'true' } }, ui.icon('check', 44)),
      ui.screenHeader({
        title: worded('done.title', config.lead?.successTitle),
        subtitle: worded('done.message', config.lead?.successMessage),
      }),
    );
  }

  if (payload.demo === true) parts.push(ui.banner(t('done.demoDoor'), { tone: 'info' }));

  if (payload.reference) {
    const refChip = ui.chip(String(payload.reference), { tone: 'neutral' });
    refChip.classList.add('sm-num', 'sm-done-ref__chip');
    parts.push(
      ui.h(
        'div',
        { class: 'sm-done-ref' },
        ui.h('p', { class: 'sm-done-ref__label' }, t('done.referenceLabel')),
        refChip,
      ),
    );
  }

  parts.push(buildSummary(), buildNextSteps());

  if (phone) {
    parts.push(
      ui.h(
        'a',
        { class: 'sm-btn sm-btn--secondary sm-btn--md sm-done-call', href: telHref(phone) },
        ui.icon('call', 20),
        ui.h('span', null, t('done.call', { phone })),
      ),
    );
  }

  if (mode === 'demo') {
    const pre = ui.h('pre', {
      class: 'sm-done-payload',
      // Focusable so keyboard users can scroll the block sideways.
      attrs: { tabindex: '0', role: 'group', 'aria-label': t('done.payloadLabel') },
    });
    pre.textContent = formatPayload(payload, t);
    parts.push(
      ui.disclosure(
        { summary: t('done.demoSummary') },
        ui.h('p', { class: 'sm-done-demo-hint' }, t('done.demoHint')),
        pre,
      ),
    );
  }

  parts.push(
    ui.actionBar(
      ui.button(t('done.startAgain'), { variant: 'ghost', icon: 'refresh', onClick: () => ctx.reset() }),
    ),
  );

  root.append(...parts);

  function buildSummary() {
    const rows = [];
    const size = payload.measurement;
    if (size) {
      rows.push(
        summaryRow(
          t('done.summarySize'),
          t('done.sizeValue', { width: noBreak(formatLength(size.widthMm)), height: noBreak(formatLength(size.heightMm)) }),
        ),
      );
    }
    if (payload.product?.name) rows.push(summaryRow(t('done.summaryProduct'), payload.product.name));
    for (const [label, value] of selectedOptions(config, payload, t)) rows.push(summaryRow(label, value));

    const quote = payload.quote;
    if (quote && quote.status === 'ok') {
      const taxLabel = config.pricing?.taxLabel;
      const note = taxLabel && quote.taxAmount > 0 ? t('done.taxNote', { tax: taxLabel }) : null;
      rows.push(summaryRow(t('done.summaryTotal'), formatMoney(quote.total, config), { total: true, note }));
    } else {
      rows.push(
        summaryRow(t('done.summaryPrice'), t('done.customQuote'), { total: true, note: t('done.customQuoteNote') }),
      );
    }

    return ui.card(
      { class: 'sm-done-summary' },
      ui.h('h2', { class: 'sm-done-heading' }, t('done.summaryHeading')),
      ui.h('dl', { class: 'sm-done-summary__list' }, rows),
    );
  }

  function summaryRow(label, value, { total = false, note = null } = {}) {
    return ui.h(
      'div',
      { class: `sm-done-summary__row${total ? ' sm-done-summary__row--total' : ''}` },
      ui.h('dt', null, label),
      ui.h('dd', { class: 'sm-num' }, value, note ? ui.h('span', { class: 'sm-done-summary__note' }, note) : null),
    );
  }

  function buildNextSteps() {
    // Fitting is only promised when the enquiry includes installation, as the summary above says.
    const lastStep = installationIncluded(config, payload) ? 'done.next3' : 'done.next3Supply';
    return ui.card(
      { class: 'sm-done-next' },
      ui.h('h2', { class: 'sm-done-heading' }, t('done.nextHeading')),
      ui.h(
        'ol',
        // Safari drops list semantics once list-style is none; the role restores them.
        { class: 'sm-done-next__list', attrs: { role: 'list' } },
        ['done.next1', 'done.next2', lastStep].map((key) => ui.h('li', null, ui.h('span', null, t(key)))),
      ),
    );
  }
}

/** True when the company set this wording through config.text. */
function hasText(config, key) {
  const text = config.text;
  return (
    text != null && Object.prototype.hasOwnProperty.call(text, key) && typeof text[key] === 'string' && text[key] !== ''
  );
}

/**
 * Whether this enquiry includes installation, resolved the way calculateQuote resolves it
 * (always when it is not optional; otherwise the customer's choice, or the config default).
 */
function installationIncluded(config, payload) {
  const installation = config.pricing?.installation;
  if (!installation?.enabled) return false;
  if (installation.optional === false) return true;
  return typeof payload.includeInstallation === 'boolean' ? payload.includeInstallation : Boolean(installation.default);
}

/**
 * [label, value] pairs for what the customer chose, resolved the way calculateQuote
 * resolves them (a missing selection means the option's default).
 */
function selectedOptions(config, payload, t) {
  const pricing = config.pricing ?? {};
  const selections = payload.selections ?? {};
  const rows = [];

  for (const option of Array.isArray(pricing.options) ? pricing.options : []) {
    // A block deleted from the config with its comma left behind leaves a hole in the list.
    if (!option || typeof option !== 'object') continue;
    const chosen = selections[option.id] ?? option.default;
    if (option.type === 'select') {
      const choices = Array.isArray(option.choices) ? option.choices : [];
      const choice = choices.find((c) => c && c.id === chosen);
      if (choice) rows.push([option.label, choice.label]);
    } else if (chosen === true) {
      rows.push([option.label, t('done.optionAdded')]);
    }
  }

  const installation = pricing.installation;
  if (installation?.enabled) {
    const included = installationIncluded(config, payload);
    rows.push([installation.label || t('done.installation'), t(included ? 'done.included' : 'done.notIncluded')]);
  }
  return rows;
}

/** Pretty-print the payload for display, swapping any embedded photo for a short placeholder. */
function formatPayload(payload, t) {
  return JSON.stringify(
    payload,
    (key, value) =>
      typeof value === 'string' && value.startsWith('data:') ? t('done.photoPlaceholder', describeDataUrl(value)) : value,
    2,
  );
}

function describeDataUrl(url) {
  const subtype = /^data:image\/([a-z0-9.+-]+)/i.exec(url)?.[1] ?? 'image';
  const encodedLength = url.length - url.indexOf(',') - 1;
  // Base64 carries 3 bytes in every 4 characters.
  return { type: subtype.toUpperCase(), size: Math.max(1, Math.round((encodedLength * 0.75) / 1024)) };
}

function telHref(phone) {
  return `tel:${phone.replace(/[^\d+]/g, '')}`;
}

/** Non-breaking spaces, so a narrow summary only ever wraps the size at the "×". */
function noBreak(text) {
  return String(text).replace(/ /g, ' ');
}
