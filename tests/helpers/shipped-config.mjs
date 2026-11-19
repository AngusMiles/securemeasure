// A fixed copy of the settings this repo ships in js/config.js, for tests that need a known configuration.
//
// js/config.js is the file a door company edits: another sheet size, a fitting allowance, their own
// price list, a webhook address, their own wording. None of that should make a test of the measuring,
// pricing or lead code fail, so those tests (tests/e2e.test.mjs, and the applyTheme tests in
// tests/theme.test.mjs) run on this copy and not on js/config.js.
//
// It must stay equal to js/config.js as shipped. tests/config.test.mjs checks that in its "as shipped"
// group, which is the one group expected to fail once js/config.js has been edited: a company that has
// made the app its own leaves this file alone; a developer who changes the shipped defaults updates it.

/** Freeze a value and everything inside it, so a test that writes to the shared copy fails loudly. */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

/**
 * js/config.js as shipped, deeply frozen. Use deepMerge (js/theme.js) to get a changed copy.
 * @type {object}
 */
export const SHIPPED_CONFIG = deepFreeze({
  brand: {
    name: 'SecureMeasure',
    tagline: 'Measure your door from one photo',
    lang: 'en-AU',
    logoUrl: '',
    phone: '1300 975 707',
    email: 'hello@example.com',
    website: 'https://www.example.com',
    colors: {
      primary: '#14294b',
      primaryContrast: '#ffffff',
      accent: '#c2410c',
      accentContrast: '#ffffff',
      background: '#f4f6f9',
      surface: '#ffffff',
      text: '#0f1b2d',
      muted: '#566178',
      border: '#d8dee8',
      success: '#137a3a',
      warning: '#9a5b06',
      danger: '#b42318',
    },
    radius: '14px',
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  },

  measurement: {
    methods: { ar: true, camera: true, paper: true },
    standardSizes: [
      { widthMm: 720, heightMm: 2040 },
      { widthMm: 770, heightMm: 2040 },
      { widthMm: 820, heightMm: 2040 },
      { widthMm: 870, heightMm: 2040 },
      { widthMm: 920, heightMm: 2040 },
      { widthMm: 820, heightMm: 2100 },
      { widthMm: 870, heightMm: 2100 },
      { widthMm: 920, heightMm: 2100 },
      { widthMm: 820, heightMm: 2340 },
      { widthMm: 920, heightMm: 2340 },
    ],
    references: [
      { id: 'a4', label: 'A4 paper', widthMm: 210, heightMm: 297, recommended: true },
      { id: 'letter', label: 'US Letter', widthMm: 215.9, heightMm: 279.4 },
      { id: 'card', label: 'Bank card', widthMm: 85.6, heightMm: 53.98, lowAccuracy: true },
    ],
    defaultReferenceId: 'a4',
    allowCustomReference: true,
    maxWorkingSizePx: 2560,
    sigmaDoorPx: 2.5,
    sigmaSheetRefinedPx: 0.5,
    sigmaSheetManualPx: 2,
    plausible: { minWidthMm: 500, maxWidthMm: 1500, minHeightMm: 1500, maxHeightMm: 2800 },
    adjustments: { widthMm: 0, heightMm: 0 },
    roundToMm: 1,
    allowManualOverride: true,
    demoPhotoUrl: 'assets/demo-door.png',
  },

  pricing: {
    currency: 'AUD',
    locale: 'en-AU',
    taxLabel: 'GST',
    taxRate: 0.1,
    pricesIncludeTax: true,
    roundTo: 1,
    limits: { minWidthMm: 600, maxWidthMm: 1100, minHeightMm: 1900, maxHeightMm: 2400 },
    standardSize: { maxWidthMm: 870, maxHeightMm: 2100 },
    products: [
      {
        id: 'diamond-grille',
        name: 'Classic Diamond Grille',
        description: 'A sturdy, affordable aluminium door in the traditional diamond pattern.',
        features: [
          '7 mm aluminium diamond grille',
          'Fibreglass insect mesh',
          'Single keyed lock',
          'Powder-coated aluminium frame',
        ],
        basePrice: 590,
        oversizePerSqm: 160,
      },
      {
        id: 'perforated-aluminium',
        name: 'ClearView Perforated',
        description: 'Perforated aluminium sheet for a cleaner look, with no bars across your view.',
        features: [
          'Perforated aluminium security sheet',
          'No grille or bars to look through',
          'Keeps insects out without extra mesh',
          'Heavy-duty powder-coated frame',
        ],
        basePrice: 890,
        oversizePerSqm: 240,
      },
      {
        id: 'stainless-mesh',
        name: 'SteelGuard 316 Stainless',
        description: 'Marine-grade stainless steel mesh: our strongest door, with an open view and full airflow.',
        features: [
          '316 marine-grade stainless steel mesh',
          'Clear view and full airflow',
          'Made for coastal conditions',
          'Heavy-duty powder-coated frame',
        ],
        basePrice: 1290,
        oversizePerSqm: 340,
        badge: 'Most popular',
      },
    ],
    options: [
      {
        id: 'frame-colour',
        label: 'Frame colour',
        type: 'select',
        default: 'black',
        choices: [
          { id: 'black', label: 'Black', price: 0 },
          { id: 'white', label: 'White', price: 0 },
          { id: 'charcoal', label: 'Charcoal grey', price: 0 },
          { id: 'silver', label: 'Silver', price: 0 },
          { id: 'custom', label: 'Custom colour match', price: 120 },
          { id: 'timber-look', label: 'Timber-look finish', price: 220 },
        ],
      },
      {
        id: 'triple-lock',
        label: 'Triple lock upgrade',
        type: 'checkbox',
        price: 140,
        description: 'Locks the door at the top, middle and bottom with one turn of the key.',
        default: false,
      },
      {
        id: 'pet-door',
        label: 'Pet door',
        type: 'checkbox',
        price: 160,
        description: 'A lockable flap in the lower panel, sized for cats and small dogs.',
        default: false,
      },
      {
        id: 'door-closer',
        label: 'Door closer',
        type: 'checkbox',
        price: 90,
        description: 'Pulls the door gently shut behind you, so it never slams or gets left open.',
        default: false,
      },
    ],
    installation: { enabled: true, label: 'Professional installation', price: 180, default: true, optional: true },
    quoteValidDays: 30,
    disclaimer:
      'This price is an estimate based on the size you gave us. We confirm the exact size and final price with a free check measure at your home before anything is made.',
  },

  lead: {
    endpoint: '',
    contentType: '',
    mailto: '',
    includePhoto: false,
    fields: [
      { id: 'name', label: 'Full name', type: 'text', required: true, autocomplete: 'name' },
      { id: 'phone', label: 'Mobile number', type: 'tel', required: true, autocomplete: 'tel' },
      { id: 'email', label: 'Email', type: 'email', required: true, autocomplete: 'email' },
      { id: 'postcode', label: 'Postcode', type: 'text', required: true, autocomplete: 'postal-code', inputmode: 'numeric' },
      { id: 'notes', label: 'Anything we should know?', type: 'textarea', required: false },
    ],
    consentText: 'I agree to be contacted about my quote.',
    successTitle: 'Thanks, your request is in',
    successMessage: 'We will be in touch shortly to book your free check measure.',
  },

  embed: { parentOrigin: '' },

  text: {},
});
