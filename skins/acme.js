/**
 * Example skin: "Acme Security Doors".
 *
 * A skin holds ONLY the settings that differ from js/config.js. Open the app
 * with ?skin=acme on the end of the address and these values are laid over the
 * defaults; everything not mentioned here stays exactly as it is in js/config.js.
 *
 * Two rules to remember:
 *   - Groups in { curly brackets } are merged, so you can change one colour and
 *     keep the rest.
 *   - Lists in [ square brackets ] are replaced whole, so a list such as
 *     'products' must be written out in full.
 *
 * To make your own skin, copy this file to skins/<name>.js. The name may use
 * lower-case letters, numbers and dashes only (up to 40 characters).
 */

/**
 * Partial config deep-merged over js/config.js when the page is opened with ?skin=acme.
 * @type {object}
 */
export default {
  brand: {
    name: 'Acme Security Doors',
    tagline: 'Built tough. Fitted right.',
    phone: '(07) 5550 0142',
    email: 'quotes@acme.example',
    website: 'https://acme.example',

    // Charcoal with an amber call to action. Amber is a light colour, so the
    // text on top of it is dark. The status colours (success, warning, danger)
    // are not listed, so they stay as they are in js/config.js.
    colors: {
      primary: '#23272e',
      primaryContrast: '#ffffff',
      accent: '#f5a524',
      accentContrast: '#1c1917',
      background: '#f7f5f2',
      text: '#1c1917',
      muted: '#5f5a54',
      border: '#e3ded7',
    },

    radius: '6px',
  },

  pricing: {
    // Demo values only. A list replaces the default list whole, so every
    // product is written out in full.
    products: [
      {
        id: 'acme-classic',
        name: 'Acme Classic',
        description: 'Our everyday aluminium diamond-grille door. Honest security at a sharp price.',
        features: [
          '7 mm aluminium diamond grille',
          'Fibreglass insect mesh',
          'Single keyed lock',
        ],
        basePrice: 640,
        oversizePerSqm: 170,
      },
      {
        id: 'acme-viewguard',
        name: 'Acme ViewGuard',
        description: 'Perforated aluminium sheet that keeps the view and loses the bars.',
        features: [
          'Perforated aluminium security sheet',
          'No grille or bars to look through',
          'Keeps insects out without extra mesh',
        ],
        basePrice: 940,
        oversizePerSqm: 250,
        badge: 'Best seller',
      },
      {
        id: 'acme-fortress',
        name: 'Acme Fortress 316',
        description: 'Marine-grade stainless steel mesh for the strongest door we make.',
        features: [
          '316 marine-grade stainless steel mesh',
          'Clear view and full airflow',
          'Made for coastal conditions',
          'Heavy-duty powder-coated frame',
        ],
        basePrice: 1390,
        oversizePerSqm: 360,
      },
    ],
  },

  text: {
    'welcome.title': 'Measure your door with Acme',
    'quote.title': 'Your Acme price',
  },
};
