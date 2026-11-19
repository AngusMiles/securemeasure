/**
 * Quote screen (step 4): the customer picks a door and extras and sees an instant price.
 *
 * Every change re-runs calculateQuote() against the company's pricing config, mirrors the
 * choices into state.quoteInput / state.quote and updates the price panel in place.
 */
// roundPrice is the engine's per-line rounding: the price tags on the choosers are shown through it,
// so a switch tagged "+$90" adds exactly the "$90" line calculateQuote() charges for it.
import { calculateQuote, formatLength, formatMoney, roundPrice } from '../quote.js';

/** Screen id used by the router. */
export const id = 'quote';

/** Progress step this screen belongs to. */
export const step = 4;

/** Default copy for this screen. Any key can be overridden through config.text. */
export const strings = {
  'quote.title': 'Your price',
  'quote.subtitle': 'Choose your door and any extras. Your price updates as you go.',
  'quote.size.label': 'Your door size',
  'quote.size.summary': '{width} wide × {height} high',
  'quote.size.edit': 'Edit',
  'quote.size.editAria': 'Edit door size',
  'quote.size.manual': 'Entered by you',
  'quote.products.title': 'Choose your door',
  'quote.product.from': 'from {price}',
  'quote.options.title': 'Options',
  'quote.option.withPrice': '{label} {price}',
  'quote.price.extra': '+{price}',
  'quote.install.label': 'Installation',
  'quote.install.fixed': 'Included with every door',
  'quote.panel.title': 'Your estimate',
  'quote.line.included': 'Included',
  'quote.subtotal': 'Subtotal',
  'quote.tax.added': '{taxLabel}',
  'quote.tax.included': 'Includes {taxLabel} of {amount}',
  'quote.total.label': 'Estimated total',
  'quote.oversize': 'Your door is bigger than a standard size, so a custom-size surcharge applies.',
  'quote.valid': 'Price valid for {days} days',
  'quote.valid.one': 'Price valid for 1 day',
  'quote.custom.title': 'This size needs a custom quote',
  'quote.custom.body':
    "Your door is outside the sizes we can price on the spot. Leave your details and we'll call you with a price.",
  'quote.invalid.fallback': "We couldn't work out a price for this door. Please check the size and try again.",
  'quote.action.go': 'Go ahead',
  'quote.action.custom': 'Request a custom quote',
  'quote.action.note': "No payment now. We'll confirm with a free check measure.",
};

/**
 * Route guard: the quote needs a final, rule-adjusted size to price.
 * @param {object} state shared app state
 * @returns {boolean}
 */
export function canEnter(state) {
  return Boolean(state && state.size);
}

const NBSP = ' ';

/** @returns {any[]} the value when it is an array, otherwise an empty array */
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * A config list without its gaps. Deleting a { ... } block but not the comma after it leaves a
 * hole in the list; the pricing engine skips those, so the screen must skip them too.
 * @returns {object[]}
 */
function asRecords(value) {
  return asArray(value).filter((entry) => entry !== null && typeof entry === 'object');
}

/** Config ids end up in element ids and radio group names, so reduce them to safe characters. */
function domId(prefix, rawId) {
  return `${prefix}-${String(rawId).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

/** Writes text only when it differs, so unchanged nodes are not re-announced by the live region. */
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

/** The remembered product if it still exists, else the first badged product, else the first one. */
function pickProductId(products, rememberedId) {
  if (rememberedId != null && products.some((product) => product.id === rememberedId)) return rememberedId;
  const featured = products.find((product) => product.badge);
  return (featured ?? products[0])?.id ?? null;
}

/**
 * calculateQuote() promises not to throw, but a stale price left on screen after a failed
 * recalculation would be the worst possible failure here, so any surprise becomes 'invalid'.
 */
function safeQuote(config, input) {
  try {
    const quote = calculateQuote(config, input);
    if (quote && typeof quote === 'object') return quote;
  } catch (error) {
    console.warn('[securemeasure] quote calculation failed', error);
  }
  return { ok: false, status: 'invalid', lineItems: [], messages: [] };
}

/**
 * A list of price rows that is synced by key rather than rebuilt. The price panel is a polite
 * live region: touching only the rows that changed means a screen reader announces "Installation
 * $180" and the new total after a tap, instead of reading the whole breakdown again.
 * @returns {{ el: HTMLElement, sync: (items: { key: string, label: string, detail?: string, amount: string }[]) => void }}
 */
function createLineList(h, extraClass = '') {
  const el = h('ul', { class: `sm-quote-lines ${extraClass}`.trim(), attrs: { role: 'list' } });
  const rows = new Map();

  function createRow() {
    const label = h('span', { class: 'sm-quote-line-label' });
    const detail = h('span', { class: 'sm-quote-line-detail sm-small sm-muted' });
    const amount = h('span', { class: 'sm-quote-line-amount sm-num' });
    const rowEl = h('li', { class: 'sm-quote-line' }, h('span', { class: 'sm-quote-line-text' }, label, detail), amount);
    return { el: rowEl, label, detail, amount };
  }

  function sync(items) {
    const wanted = new Set(items.map((item) => item.key));
    for (const [key, row] of rows) {
      if (!wanted.has(key)) {
        row.el.remove();
        rows.delete(key);
      }
    }
    let cursor = el.firstElementChild;
    for (const item of items) {
      let row = rows.get(item.key);
      if (!row) {
        row = createRow();
        rows.set(item.key, row);
      }
      setText(row.label, item.label ?? '');
      setText(row.detail, item.detail ?? '');
      row.detail.hidden = !item.detail;
      setText(row.amount, item.amount);
      if (row.el === cursor) cursor = cursor.nextElementSibling;
      else el.insertBefore(row.el, cursor);
    }
    el.hidden = items.length === 0;
  }

  return { el, sync };
}

/**
 * Builds the quote screen inside `root`.
 * @param {HTMLElement} root the empty <section> for this screen
 * @param {object} ctx app context (config, state, t, go, emit, ui, ...)
 * @returns {undefined} nothing to clean up: every listener lives on nodes inside root
 */
export function mount(root, ctx) {
  const { config, state, ui } = ctx;
  const { h } = ui;
  const t = (key, vars) => ctx.t(key, vars);
  const money = (amount) => formatMoney(amount, config);

  const pricing = config.pricing ?? {};
  const products = asRecords(pricing.products);
  const options = asRecords(pricing.options);
  const installation = pricing.installation ?? {};
  const remembered = state.quoteInput ?? {};
  const size = state.size;

  /**
   * '+$60' for a surcharge, '-$20' for a discount, '' when there is nothing extra to pay. Rounded
   * first, so the tag always equals the line it adds to the estimate.
   */
  const extra = (price) => {
    const amount = roundPrice(price, config) || 0;
    if (amount > 0) return t('quote.price.extra', { price: money(amount) });
    return amount < 0 ? money(amount) : '';
  };

  // ----- current choices ---------------------------------------------------------------
  let productId = pickProductId(products, remembered.productId);
  const selections = {};
  const installEnabled = Boolean(installation.enabled);
  const installOptional = installEnabled && installation.optional !== false;
  let includeInstallation = false;
  if (installEnabled) {
    includeInstallation = installOptional
      ? Boolean(remembered.includeInstallation ?? installation.default)
      : true;
  }

  // ----- size summary ------------------------------------------------------------------
  const editButton = ui.button(t('quote.size.edit'), {
    variant: 'ghost',
    size: 'sm',
    full: false,
    icon: 'edit',
    ariaLabel: t('quote.size.editAria'),
    onClick: () => ctx.go('result'),
  });
  editButton.classList.add('sm-quote-edit');

  // Non-breaking spaces, here and in the default copy, keep each "820 mm wide" together, so a
  // narrow phone wraps at the "×".
  const sizeText = t('quote.size.summary', {
    width: formatLength(size.widthMm).replace(/ /g, NBSP),
    height: formatLength(size.heightMm).replace(/ /g, NBSP),
  });
  const summary = h(
    'div',
    { class: 'sm-quote-size' },
    h(
      'div',
      { class: 'sm-quote-size-text' },
      h('span', { class: 'sm-quote-size-label sm-small sm-muted', text: t('quote.size.label') }),
      h('span', { class: 'sm-quote-size-value sm-num', text: sizeText }),
      size.source === 'manual'
        ? h('span', { class: 'sm-quote-size-chip' }, ui.chip(t('quote.size.manual'), { tone: 'neutral' }))
        : null,
    ),
    editButton,
  );

  // ----- product chooser ---------------------------------------------------------------
  let productSection = null;
  if (products.length) {
    const productCards = ui.radioCards({
      name: 'sm-quote-product',
      ariaLabel: t('quote.products.title'),
      options: products.map((product) => ({
        value: product.id,
        title: product.name,
        description: product.description,
        features: asArray(product.features),
        badge: product.badge,
        price: t('quote.product.from', { price: money(roundPrice(product.basePrice, config)) }),
      })),
      value: productId,
      onChange: (value) => {
        productId = value;
        update();
      },
    });
    productSection = h(
      'section',
      { class: 'sm-quote-section' },
      h('h2', { class: 'sm-quote-heading', text: t('quote.products.title') }),
      productCards.el,
    );
  }

  // ----- options and installation ------------------------------------------------------
  const optionRows = [];
  for (const option of options) {
    const stored = remembered.selections?.[option.id] ?? option.default;

    if (option.type === 'select') {
      const choices = asRecords(option.choices);
      if (!choices.length) continue;
      const exists = (choiceId) => choices.some((choice) => choice.id === choiceId);
      selections[option.id] = exists(stored) ? stored : exists(option.default) ? option.default : choices[0].id;

      const control = ui.segmented({
        name: domId('sm-quote-opt', option.id),
        ariaLabel: option.label,
        options: choices.map((choice) => {
          const surcharge = extra(choice.price);
          return {
            value: choice.id,
            label: surcharge ? t('quote.option.withPrice', { label: choice.label, price: surcharge }) : choice.label,
          };
        }),
        value: selections[option.id],
        onChange: (value) => {
          selections[option.id] = value;
          update();
        },
      });
      optionRows.push(
        h(
          'div',
          { class: 'sm-quote-option' },
          // The radio group already carries this label for assistive tech; hide the visual copy
          // so it is not read twice.
          h('p', { class: 'sm-quote-option-label', text: option.label, attrs: { 'aria-hidden': 'true' } }),
          control.el,
        ),
      );
    } else if (option.type === 'checkbox') {
      selections[option.id] = stored === true;
      const row = ui.toggleRow({
        id: domId('sm-quote-opt', option.id),
        label: option.label,
        description: option.description,
        trailing: extra(option.price) || undefined,
        checked: selections[option.id],
        onChange: (checked) => {
          selections[option.id] = Boolean(checked);
          update();
        },
      });
      optionRows.push(row.el);
    }
  }

  const installLabel = installation.label || t('quote.install.label');
  if (installOptional) {
    const row = ui.toggleRow({
      id: 'sm-quote-installation',
      label: installLabel,
      trailing: extra(installation.price) || undefined,
      checked: includeInstallation,
      onChange: (checked) => {
        includeInstallation = Boolean(checked);
        update();
      },
    });
    optionRows.push(row.el);
  } else if (installEnabled) {
    optionRows.push(
      h(
        'div',
        { class: 'sm-quote-fixed' },
        h('span', { class: 'sm-quote-fixed-icon' }, ui.icon('check', 20)),
        h(
          'span',
          { class: 'sm-quote-fixed-text' },
          h('span', { class: 'sm-quote-fixed-label', text: installLabel }),
          h('span', { class: 'sm-small sm-muted', text: t('quote.install.fixed') }),
        ),
      ),
    );
  }

  const optionsSection = optionRows.length
    ? h(
        'section',
        { class: 'sm-quote-section' },
        h('h2', { class: 'sm-quote-heading', text: t('quote.options.title') }),
        optionRows,
      )
    : null;

  // ----- price panel -------------------------------------------------------------------
  const lines = createLineList(h);
  const sums = createLineList(h, 'sm-quote-lines--sums');
  const totalAmount = h('span', { class: 'sm-quote-total-amount sm-num' });
  const taxNote = h('span', { class: 'sm-quote-total-tax sm-small sm-muted', hidden: true });
  const oversizeNote = h(
    'p',
    { class: 'sm-quote-oversize sm-small', hidden: true },
    ui.icon('info', 16),
    h('span', { text: t('quote.oversize') }),
  );
  const validDays = Number(pricing.quoteValidDays);
  const breakdown = h(
    'div',
    { class: 'sm-quote-breakdown' },
    h('h2', { class: 'sm-quote-heading', text: t('quote.panel.title') }),
    lines.el,
    h('hr', { class: 'sm-quote-divider' }),
    sums.el,
    h(
      'div',
      { class: 'sm-quote-total' },
      h('span', { class: 'sm-quote-total-label', text: t('quote.total.label') }),
      totalAmount,
      taxNote,
    ),
    oversizeNote,
    pricing.disclaimer
      ? h('p', { class: 'sm-quote-fineprint sm-small sm-muted', text: String(pricing.disclaimer) })
      : null,
    validDays > 0
      ? h('p', {
          class: 'sm-quote-fineprint sm-small sm-muted',
          text: validDays === 1 ? t('quote.valid.one') : t('quote.valid', { days: validDays }),
        })
      : null,
  );

  const customBlock = h(
    'div',
    { class: 'sm-quote-custom' },
    h('span', { class: 'sm-quote-custom-icon' }, ui.icon('ruler', 24)),
    h('h2', { class: 'sm-quote-heading', text: t('quote.custom.title') }),
    h('p', { class: 'sm-quote-custom-body sm-muted', text: t('quote.custom.body') }),
  );

  const invalidBanner = ui.banner('', { tone: 'warning', icon: 'alert' });

  // One permanent live region whose content is swapped by insertion, which screen readers
  // announce far more reliably than a live region that is itself shown and hidden.
  const panel = ui.card({ attrs: { 'aria-live': 'polite' } });
  panel.classList.add('sm-quote-panel');

  // ----- actions -----------------------------------------------------------------------
  const primary = ui.button(t('quote.action.go'), {
    variant: 'primary',
    size: 'lg',
    iconEnd: 'arrow-right',
    onClick: goAhead,
  });
  let primaryLabelKey = 'quote.action.go';

  function goAhead() {
    const quote = state.quote;
    if (!quote || (quote.status !== 'ok' && quote.status !== 'out_of_range')) return;
    ctx.emit('quote', {
      size: { ...state.size },
      productId,
      selections: { ...selections },
      includeInstallation,
      // An unpriced (custom quote) result still carries total 0; the parent page must not log a $0 quote.
      total: quote.status === 'ok' ? (quote.total ?? null) : null,
      status: quote.status,
    });
    ctx.go('details');
  }

  // ----- rendering ---------------------------------------------------------------------
  let mode = null;

  function showMode(next, block) {
    if (mode === next) return;
    mode = next;
    panel.replaceChildren(block);
    panel.classList.toggle('sm-quote-panel--custom', next === 'custom');
    panel.classList.toggle('sm-quote-panel--bare', next === 'invalid');
  }

  function renderBreakdown(quote) {
    const seen = new Map();
    lines.sync(
      asArray(quote.lineItems).map((item) => {
        // Line item ids should be unique, but a duplicate must not collapse two rows into one.
        const count = seen.get(item.id) ?? 0;
        seen.set(item.id, count + 1);
        return {
          key: count ? `${item.id}#${count}` : String(item.id),
          label: item.label,
          detail: item.detail,
          amount: Number(item.amount) === 0 ? t('quote.line.included') : money(item.amount),
        };
      }),
    );

    const taxLabel = quote.taxLabel ?? pricing.taxLabel ?? '';
    const hasTax = Number(quote.taxAmount) > 0;
    const taxOnTop = hasTax && !quote.pricesIncludeTax;
    sums.sync(
      taxOnTop
        ? [
            { key: 'subtotal', label: t('quote.subtotal'), amount: money(quote.subtotal) },
            { key: 'tax', label: t('quote.tax.added', { taxLabel }), amount: money(quote.taxAmount) },
          ]
        : [],
    );
    const taxIncluded = hasTax && Boolean(quote.pricesIncludeTax);
    setText(taxNote, taxIncluded ? t('quote.tax.included', { taxLabel, amount: money(quote.taxAmount) }) : '');
    taxNote.hidden = !taxIncluded;

    setText(totalAmount, money(quote.total));
    // 'oversize' alone does not mean a charge: a door over in one dimension but smaller in area
    // (or a product with no oversize rate) is priced without a surcharge line.
    const surcharged = asArray(quote.lineItems).some((item) => item.id === 'oversize');
    oversizeNote.hidden = quote.sizeCategory !== 'oversize' || !surcharged;
  }

  function render(quote) {
    if (quote.status === 'ok') {
      renderBreakdown(quote);
      showMode('price', breakdown);
    } else if (quote.status === 'out_of_range') {
      showMode('custom', customBlock);
    } else {
      invalidBanner.update(asArray(quote.messages)[0] || t('quote.invalid.fallback'), 'warning');
      showMode('invalid', invalidBanner);
    }

    const labelKey = quote.status === 'out_of_range' ? 'quote.action.custom' : 'quote.action.go';
    if (labelKey !== primaryLabelKey) {
      primaryLabelKey = labelKey;
      primary.setLabel(t(labelKey));
    }
    primary.disabled = quote.status !== 'ok' && quote.status !== 'out_of_range';
  }

  /** Recalculates from the current choices and keeps the shared state in step with the screen. */
  function update() {
    const input = { productId, selections: { ...selections }, includeInstallation };
    state.quoteInput = input;
    state.quote = safeQuote(config, { widthMm: size.widthMm, heightMm: size.heightMm, ...input });
    render(state.quote);
  }

  root.append(
    ...[
      ui.screenHeader({ title: t('quote.title'), subtitle: t('quote.subtitle') }),
      summary,
      productSection,
      optionsSection,
      panel,
      ui.actionBar(
        primary,
        h('p', { class: 'sm-quote-note sm-small sm-muted sm-center', text: t('quote.action.note') }),
      ),
    ].filter(Boolean),
  );

  update();
  return undefined;
}
