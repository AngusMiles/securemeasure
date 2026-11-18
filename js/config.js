/**
 * SecureMeasure settings: the one file you edit to make the app yours.
 *
 * How to edit this file safely
 *   - Text goes inside 'single quotes'. Numbers and true/false have no quotes.
 *   - Keep the commas at the ends of lines and keep the brackets matched.
 *   - Every length is in millimetres (mm). Every price is in dollars (or your
 *     own currency), written as a plain number: 590 or 89.50, not '$590'.
 *   - Lines starting with // are notes for you. The app ignores them.
 *   - After a change, reload the page. If the app goes blank, the usual cause is
 *     a missing comma or quote on the line you just touched.
 *
 * The sections run top to bottom in the order your customer meets them:
 *   brand -> measurement -> pricing -> lead -> embed -> text
 *
 * Running more than one brand from the same copy? Leave this file as your base
 * and put only the differences in skins/<name>.js, then open the page with
 * ?skin=<name> on the end of the address. See skins/acme.js for an example.
 */

/**
 * The default SecureMeasure configuration.
 * @type {object}
 */
export default {
  // ---------------------------------------------------------------------------
  // BRAND: your name, contact details and colours.
  // ---------------------------------------------------------------------------
  brand: {
    // Your business name. Shown in the header (when there is no logo), in the
    // browser tab, and on every enquiry the app sends you.
    name: 'SecureMeasure',

    // One short line that goes with your name, for example in the browser tab.
    tagline: 'Measure your door from one photo',

    // Your logo image, for example 'assets/logo.svg' (a path inside this folder,
    // with no slash at the start) or a full https:// address.
    // Leave as '' to show your business name in text instead.
    logoUrl: '',

    // Your phone number is shown to customers as a tap-to-call link (leave as ''
    // to hide it). email and website are kept with your settings but are not
    // shown in the app yet.
    phone: '1300 975 707',
    email: 'hello@example.com',
    website: 'https://www.example.com',

    // Your colours, as 6-digit hex codes (# then six characters from 0-9 and a-f).
    // Each "...Contrast" colour is the text drawn ON TOP of its partner colour.
    // Keep text easy to read: aim for a contrast ratio of at least 4.5 to 1 between
    // every text colour and the colour behind it (search "contrast checker" to test a pair).
    colors: {
      primary: '#14294b', //         your main brand colour (also tints the phone's browser bar)
      primaryContrast: '#ffffff', // text and icons on top of the primary colour
      accent: '#c2410c', //          the main "continue" button on each screen, so it stands out
      accentContrast: '#ffffff', //  text on top of the accent colour
      background: '#f4f6f9', //      page background
      surface: '#ffffff', //         cards, panels and form fields
      text: '#0f1b2d', //            normal body text
      muted: '#566178', //           secondary text such as hints and small print
      border: '#d8dee8', //          hairlines around cards and fields
      success: '#137a3a', //         "good measurement" and confirmation messages
      warning: '#9a5b06', //         "check this" messages
      danger: '#b42318', //          errors
    },

    // How rounded the corners of buttons and cards are. '0px' is square,
    // '14px' is soft, '999px' makes buttons pill-shaped.
    radius: '14px',

    // The typeface. This list uses the font already built into each phone, which
    // loads instantly and needs no downloads. The app never fetches web fonts, so
    // only name fonts that are installed on your customers' devices.
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  },

  // ---------------------------------------------------------------------------
  // MEASUREMENT: how the photo is turned into a door size.
  // ---------------------------------------------------------------------------
  measurement: {
    // The flat objects a customer may tape to the door to give the photo a scale.
    //   id           short unique code (lower-case letters, numbers, dashes)
    //   label        the name the customer sees
    //   widthMm      the two side lengths in mm. Either order is fine: the app
    //   heightMm     works out which way up the sheet is in the photo.
    //   recommended  true marks this as the recommended choice
    //   lowAccuracy  true marks this as a less accurate choice. A smaller object
    //                gives a weaker scale, so the result is rougher.
    references: [
      { id: 'a4', label: 'A4 paper', widthMm: 210, heightMm: 297, recommended: true },
      { id: 'letter', label: 'US Letter', widthMm: 215.9, heightMm: 279.4 },
      { id: 'card', label: 'Bank card', widthMm: 85.6, heightMm: 53.98, lowAccuracy: true },
    ],

    // Which of the references above is selected to begin with. Must match one id.
    defaultReferenceId: 'a4',

    // true lets customers type in the size of their own sheet if they have none
    // of the above. false hides that choice.
    allowCustomReference: true,

    // Photos are shrunk on the phone so the longest side is at most this many
    // pixels before measuring. Larger is slightly more precise but slower and
    // can run out of memory on older phones. 2560 suits almost everyone;
    // do not go below about 1600.
    maxWorkingSizePx: 2560,

    // How closely, in photo pixels, we expect each corner to be marked. These
    // feed the confidence rating and the "plus or minus" figure, not the size
    // itself. Raise them to make the app more cautious. Best left alone.
    sigmaDoorPx: 2.5, //          door corners dragged into place by hand
    sigmaSheetRefinedPx: 0.5, //  sheet corners found automatically
    sigmaSheetManualPx: 2, //     sheet corners placed by hand

    // A sanity check, in mm. A result outside this range is almost certainly a
    // marking mistake, so the app rates the measurement "poor" and warns the
    // customer. Keep this wider than pricing.limits below.
    plausible: { minWidthMm: 500, maxWidthMm: 1500, minHeightMm: 1500, maxHeightMm: 2800 },

    // Millimetres ADDED to the measured opening to get the size you quote and
    // make. Use a minus sign to take away: widthMm: -6 makes every door 6 mm
    // narrower than the opening. 0 means quote the opening exactly as measured.
    adjustments: { widthMm: 0, heightMm: 0 },

    // Round the final size to the nearest this-many mm. 1 = nearest millimetre,
    // 5 = nearest 5 mm.
    roundToMm: 1,

    // true lets customers type in their own width and height instead of relying
    // on the photo. false makes the photo the only way to get a size.
    allowManualOverride: true,

    // The sample photo behind "try it with our example door", so people can see
    // how it works before going to their own door. A path inside this folder
    // (no slash at the start). Set to '' to remove the example.
    demoPhotoUrl: 'assets/demo-door.png',
  },

  // ---------------------------------------------------------------------------
  // PRICING: turns the door size into an instant price.
  // EVERY PRICE BELOW IS A MADE-UP DEMO VALUE. Replace them all with your own
  // before you go live.
  // ---------------------------------------------------------------------------
  pricing: {
    // Currency code (AUD, NZD, USD, GBP ...) and the language/region used to
    // format numbers, for example 'en-AU' shows $1,290.
    currency: 'AUD',
    locale: 'en-AU',

    // Your sales tax. taxRate is a fraction: 0.10 means 10%. Use 0 for no tax.
    taxLabel: 'GST',
    taxRate: 0.10,

    // true:  the prices in this file already include tax. The quote shows the
    //        total and notes how much of it is tax.
    // false: the prices in this file are before tax. Tax is added on top.
    pricesIncludeTax: true,

    // Round every amount to the nearest this-many dollars. 1 = whole dollars,
    // 5 = nearest $5, 0.05 = nearest five cents, 0.01 = exact cents.
    roundTo: 1,

    // The smallest and largest door (mm) you are happy to price automatically.
    // Anything outside gets no instant price: the customer is told the door
    // needs a custom quote instead.
    limits: { minWidthMm: 600, maxWidthMm: 1100, minHeightMm: 1900, maxHeightMm: 2400 },

    // The largest door (mm) sold at the plain base price. If EITHER the width or
    // the height is bigger than this, the door is "oversize" and a surcharge is
    // added for the extra area only:
    //   surcharge = the product's oversizePerSqm x (door area - standard area), in square metres
    // Example: a 900 x 2100 door is 1.89 m2. The standard area is
    // 870 x 2100 = 1.827 m2, so the surcharge is 0.063 m2 x oversizePerSqm.
    // This must sit inside the limits above.
    standardSize: { maxWidthMm: 870, maxHeightMm: 2100 },

    // Your door range. List as many or as few as you like, cheapest first.
    //   id              short unique code (lower-case letters, numbers, dashes).
    //                   It is sent with each enquiry, so do not change it once live.
    //   name            what the customer sees
    //   description     one sentence under the name
    //   features        three or four short selling points
    //   basePrice       price of a standard-size door, before options and installation
    //   oversizePerSqm  extra charge per square metre beyond the standard size (0 = no surcharge)
    //   badge           optional small tag such as 'Most popular'. Delete the line for no tag.
    // To remove a door, delete its whole { ... } block together with the comma after it.
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
        basePrice: 590, // demo value
        oversizePerSqm: 160, // demo value
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
        basePrice: 890, // demo value
        oversizePerSqm: 240, // demo value
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
        basePrice: 1290, // demo value
        oversizePerSqm: 340, // demo value
        badge: 'Most popular',
      },
    ],

    // Extras the customer can choose. There are two kinds.
    //
    // type: 'select' is a pick-one list:
    //   default   the id of the choice selected to begin with (must match a choice)
    //   choices   each has an id, a label and a price added to the door (0 = free)
    //
    // type: 'checkbox' is an on/off extra:
    //   price        added when switched on
    //   description  one sentence explaining it
    //   default      true to have it switched on to begin with
    //
    // Each option needs its own unique id. To remove an option, delete its whole
    // { ... } block together with the comma after it.
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
          { id: 'custom', label: 'Custom colour match', price: 120 }, // demo value
          { id: 'timber-look', label: 'Timber-look finish', price: 220 }, // demo value
        ],
      },
      {
        id: 'triple-lock',
        label: 'Triple lock upgrade',
        type: 'checkbox',
        price: 140, // demo value
        description: 'Locks the door at the top, middle and bottom with one turn of the key.',
        default: false,
      },
      {
        id: 'pet-door',
        label: 'Pet door',
        type: 'checkbox',
        price: 160, // demo value
        description: 'A lockable flap in the lower panel, sized for cats and small dogs.',
        default: false,
      },
      {
        id: 'door-closer',
        label: 'Door closer',
        type: 'checkbox',
        price: 90, // demo value
        description: 'Pulls the door gently shut behind you, so it never slams or gets left open.',
        default: false,
      },
    ],

    // The installation line on the quote.
    //   enabled   false removes installation from the quote altogether (supply only)
    //   label     the wording the customer sees
    //   price     flat fee per door
    //   default   true to have it switched on to begin with
    //   optional  true lets the customer switch it off. false means it is always
    //             included and cannot be removed.
    installation: {
      enabled: true,
      label: 'Professional installation',
      price: 180, // demo value
      default: true,
      optional: true,
    },

    // How many days the quoted price is held for. Shown on the quote.
    quoteValidDays: 30,

    // Small print under every price. Say plainly that the price depends on a
    // check measure, because a photo measurement is an estimate.
    disclaimer:
      'This price is an estimate based on the measurements from your photo. We confirm the exact size and final price with a free check measure at your home before anything is made.',
  },

  // ---------------------------------------------------------------------------
  // LEAD: what happens when a customer taps "go ahead" and sends their details.
  // ---------------------------------------------------------------------------
  lead: {
    // Where enquiries are sent. Fill in ONE of the next two settings.
    //
    // endpoint: a web address that accepts the enquiry as a JSON "POST", for
    // example a Zapier or Make webhook, or your CRM's inbound webhook. Any
    // "success" (2xx) reply counts as delivered. If it is on a different domain
    // to this page, it must allow cross-origin (CORS) requests.
    endpoint: '',

    // mailto: your email address. Used only when endpoint is ''. The customer's
    // own email app opens with the enquiry already written, and they press send.
    // Simple, but it relies on the customer finishing that last step.
    //
    // If BOTH are '' the app runs in DEMO MODE: nothing is sent anywhere and the
    // confirmation screen shows what would have been sent. Good for trying it out.
    mailto: '',

    // true attaches a reduced-size copy of the customer's door photo to the
    // enquiry. Works with endpoint only (an email link cannot carry a photo).
    // The customer's photo never leaves their phone unless this is true AND they submit.
    includePhoto: false,

    // The questions on the contact form, in order.
    //   id            short unique code. This is the name of the answer in the enquiry you receive.
    //   label         the wording above the box
    //   type          'text', 'tel' (phone number), 'email' or 'textarea' (large box)
    //   required      true means the form cannot be sent with this left empty
    //   autocomplete  lets the phone fill the box in for the customer (leave these as they are)
    //   inputmode     'numeric' shows the number keypad
    // Phone numbers need at least 8 digits and emails must look like an email address.
    fields: [
      { id: 'name', label: 'Full name', type: 'text', required: true, autocomplete: 'name' },
      { id: 'phone', label: 'Mobile number', type: 'tel', required: true, autocomplete: 'tel' },
      { id: 'email', label: 'Email', type: 'email', required: true, autocomplete: 'email' },
      { id: 'postcode', label: 'Postcode', type: 'text', required: true, autocomplete: 'postal-code', inputmode: 'numeric' },
      { id: 'notes', label: 'Anything we should know?', type: 'textarea', required: false },
    ],

    // The tick-box the customer must agree to before sending. Make sure it
    // matches your own privacy policy.
    consentText: 'I agree to be contacted about my quote.',

    // The heading and message shown after the enquiry is sent.
    successTitle: 'Thanks, your request is in',
    successMessage: 'We will be in touch shortly to book your free check measure.',
  },

  // ---------------------------------------------------------------------------
  // EMBED: only needed if you place the app inside another page with an <iframe>.
  // ---------------------------------------------------------------------------
  embed: {
    // The exact address of the page that contains the iframe, with no path or
    // slash on the end, for example 'https://www.yourdoors.com.au'. When set, the
    // app tells that page when a door is measured, a quote is shown and an
    // enquiry is sent (messages named 'measured', 'quote' and 'lead'), so your
    // site can track them. Leave as '' to send nothing.
    parentOrigin: '',
  },

  // ---------------------------------------------------------------------------
  // TEXT: change any wording in the app without touching the code.
  // ---------------------------------------------------------------------------
  // Each line is a string id, a colon, then your wording. Ids look like
  // 'welcome.title': the screen name, a dot, then the piece of text. Anything not
  // listed here keeps its built-in wording. For example:
  //
  //   text: {
  //     'welcome.title': 'Measure your front door in two minutes',
  //   },
  text: {},
};
