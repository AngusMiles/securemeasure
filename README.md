# SecureMeasure

SecureMeasure is a white-label, phone-first web app for security-door companies. Your customer tapes a sheet of A4 paper to their front door, takes one photo, and gets the door opening's width and height in millimetres, an instant price from your price list, and a form to send you their details. It is a static site (plain HTML, CSS and JavaScript, with no build step, no dependencies and no server-side code) that you brand through one config file and host on your own website. The photo is processed on the customer's phone; nothing is sent anywhere until they submit the enquiry form.

The customer journey (a customer who already knows their door size can skip the photo and type it in):

1. Tape a sheet of A4 flat on the closed door and take one photo of the whole door.
2. Tap the sheet in the photo. The app finds it and snaps its outline to the edges of the paper.
3. Drag four handles onto the corners of the door opening, where the door meets the frame. Pinch-zoom, a magnifier and arrow nudges help with fine placement.
4. See the width and height in mm with a good / fair / poor rating, a plus-or-minus figure and a flattened preview of the door. From here they can adjust the corners, retake the photo or type in a tape-measured size instead.
5. Choose a door and options, see the price, and send their contact details.

## Try it

```
npm start
```

Then open http://localhost:5173/. There is nothing to install: the dev server (`tools/serve.mjs`) has no dependencies. Set the `PORT` environment variable to use another port.

- **No door handy?** Tap "Try it with a demo photo" on the first screen. It loads a bundled synthetic photo of an 820 x 2040 mm door.
- **A second brand:** http://localhost:5173/?skin=acme shows the same app as "Acme Security Doors".
- **On a phone:** upload the folder to any static host with HTTPS and open the address on the phone.
- Out of the box the app is in demo mode: no enquiry is sent anywhere, and the confirmation screen shows the data that would have been sent.

## How the measurement works

The sheet of paper and the door opening lie in the same plane, the face of the closed door.

- **The sheet gives scale.** Its size is known, but it is small, so on its own it is a poor ruler for something seven times its height.
- **The door fixes perspective.** The opening is assumed to be a rectangle. Its size is unknown, but its four corners are spread across the whole photo, which pins down the camera angle.
- **One joint fit.** `measureDoor()` in `js/geometry.js` fits a single plane-to-image mapping (a homography) to all eight corners at once by weighted least squares, with the door as a W x H rectangle and the sheet as a rectangle of known size. It returns W and H, a standard deviation for each, and a cross-check worked out from the sheet alone. It also works out which way round the sheet is.
- **Sub-pixel sheet corners.** `js/vision.js` grows a region from the customer's tap, finds each side of the paper from the brightness step across it, fits a straight line per side and intersects the lines. This matters because every error on the sheet is magnified several times at door scale. If detection fails, the customer places the corners by hand and can press "Snap to edges".
- **A rating, not just a number.** Each result is graded good, fair or poor and can carry issue codes (sheet too small, steep angle, door near the edge of the photo, implausible size and so on), each shown as a plain-English tip. A poor result that points to a marking mistake (corners that do not line up, an implausible size, or the two checks disagreeing) puts "Retake photo" ahead of "Continue anyway". One that is poor only because its plus-or-minus is wide is shown as a "Rough measurement" and the customer can go straight on to the price. The "Accurate to about ±N mm" line is two standard deviations of the weaker dimension.

### Simulated accuracy

`npm run simulate` measures 5000 random photos per scenario: an 820 x 2040 mm door in a 1920 x 2560 px photo, camera 2.2 to 3.5 m away, up to 15 degrees to one side, 8 degrees of tilt and 3 degrees of roll, sheet anywhere on the door. Each marked corner is given random error: 2 px on door corners, and on sheet corners either 0.3 px ("snapped") or 2 px ("by hand"). Absolute error in mm:

| Reference, sheet corners | Width: median / 95th percentile | Height: median / 95th percentile |
|---|---|---|
| A4, snapped | 2.6 / 7.9 | 4.7 / 16.8 |
| A4, by hand | 8.3 / 25.4 | 15.0 / 45.8 |
| Bank card, snapped | 3.9 / 11.6 | 12.8 / 39.4 |
| Bank card, by hand | 20.1 / 61.8 | 78.6 / 235.5 |

- With A4 and snapped corners, both dimensions land within 5 mm in 43% of trials and within 3 mm in 20%. Height is always the weaker dimension.
- The joint fit earns its keep: from the sheet alone, the same A4 photos give a 95th-percentile height error of 64 mm instead of 17 mm.
- The app's own rating is strict. In the A4-snapped scenario 2% of results grade good, 70% fair and 28% poor. With hand-placed sheet corners, or a bank card, every result grades poor. The end-to-end test on the scene behind the bundled demo photo, with the door corners marked 2 px out, gives 820 x 2043 mm, graded fair.
- The plus-or-minus figure is neither flattering nor padded: actual errors run at 0.95 of the reported standard deviation.

**The simulation models corner-marking error only.** It assumes an ideal lens, a flat sheet lying exactly in the door plane, paper of exactly the stated size and a perfectly rectangular opening. Nothing in this repo has been checked against tape-measured real doors. Real photos add errors the simulation leaves out:

- **It measures the rectangle the customer marks.** If the handles go on the outer trim instead of the opening, the trim is what gets measured. An out-of-square opening is reported as the best-fitting rectangle.
- **Everything must be in the plane of the sheet.** If the door sits back inside a deep frame and the corners are marked on a face nearer to or further from the camera than the sheet, the result is out by roughly 0.3% for each 10 mm of depth at 3 m: about 7 mm on a 2040 mm height.
- **The sheet must be flat and the stated size.** A curled or loosely taped sheet, or paper cut 1 mm off, throws out the scale of the whole door by up to about 0.5%, or 10 mm on the height.
- **Lens distortion is not corrected.** Phone cameras bend straight lines slightly, most of all near the edges of the photo. The app warns when a door corner is within 2% of the edge, and that is all.

Treat the result as a sound basis for a quote and keep every price "subject to check measure". The shipped disclaimer and screen wording already say so.

## Make it yours

Everything a door company changes is in `js/config.js`, which is heavily commented and written for non-developers. Edit, save, reload. Its sections, top to bottom:

### brand

```js
brand: {
  name: 'Northside Security Doors', tagline: 'Measured from one photo', radius: '14px',
  logoUrl: 'assets/logo.svg',   // '' shows the name as text instead
  phone: '1300 000 000',        // "Call us" on the confirmation screen, and when sending fails
  colors: { primary: '#14294b', primaryContrast: '#ffffff', accent: '#c2410c', accentContrast: '#ffffff' /* and 8 more */ },
},
```

The twelve colours, the corner radius and the font become CSS custom properties (`--sm-primary`, `--sm-accent` and so on) that every screen is built from. A mistyped colour is skipped with a console warning and the default kept. `fontFamily` must name fonts already on the phone, because the app loads no web fonts. `email` and `website` are in the file but the current screens do not display them. The static page title, description and `assets/favicon.svg` are set in `index.html`.

### measurement

```js
measurement: {
  references: [{ id: 'a4', label: 'A4 paper', widthMm: 210, heightMm: 297, recommended: true } /* US Letter, bank card */],
  defaultReferenceId: 'a4', allowCustomReference: true,       // the customer may type in the size of their own sheet
  adjustments: { widthMm: -6, heightMm: -6 }, roundToMm: 1,   // added to the photo measurement to get the size you quote
  plausible: { minWidthMm: 500, maxWidthMm: 1500, minHeightMm: 1500, maxHeightMm: 2800 },
  allowManualOverride: true,                                  // false makes the photo the only way to get a size
  demoPhotoUrl: 'assets/demo-door.png',                       // '' removes the demo button
},
```

A photo result outside `plausible` is graded poor, and the same range limits what a customer may type in. `adjustments` and `roundToMm` apply to photo measurements; a typed size is used as typed. `maxWorkingSizePx` (photos are shrunk to 2560 px on the long side) and the three `sigma...Px` values (how closely corners are assumed to be marked, which drives the rating) are best left alone.

### pricing

```js
pricing: {
  currency: 'AUD', locale: 'en-AU', taxLabel: 'GST', taxRate: 0.10, pricesIncludeTax: true, roundTo: 1,
  limits: { minWidthMm: 600, maxWidthMm: 1100, minHeightMm: 1900, maxHeightMm: 2400 }, standardSize: { maxWidthMm: 870, maxHeightMm: 2100 },
  products: [{ id: 'stainless-mesh', name: 'SteelGuard 316 Stainless', description: '...', features: ['...'], basePrice: 1290, oversizePerSqm: 340, badge: 'Most popular' }],
  options: [
    { id: 'frame-colour', label: 'Frame colour', type: 'select', default: 'black',
      choices: [{ id: 'black', label: 'Black', price: 0 }, { id: 'custom', label: 'Custom colour match', price: 120 }] },
    { id: 'pet-door', label: 'Pet door', type: 'checkbox', price: 160, description: '...', default: false },
  ],
  installation: { enabled: true, label: 'Professional installation', price: 180, default: true, optional: true },
  quoteValidDays: 30, disclaimer: 'This price is an estimate. We confirm it with a free check measure.',
},
```

Price = base price + oversize surcharge + options + installation. The surcharge applies only when the width or the height exceeds `standardSize`, and is `oversizePerSqm` times the area beyond the standard area. A size outside `limits` gets no price: the customer is told it needs a custom quote and can still send their details. **Every price in the shipped file is a made-up demo value.**

### lead, embed and text

```js
lead: {
  endpoint: 'https://hooks.example.com/securemeasure',   // where enquiries go: see the next section
  fields: [{ id: 'name', label: 'Full name', type: 'text', required: true, autocomplete: 'name' } /* phone, email, postcode, notes */],
  consentText: 'I agree to be contacted about my quote.',
  successTitle: 'Thanks, your request is in', successMessage: 'We will be in touch shortly to book your free check measure.',
},
embed: { parentOrigin: 'https://www.yourdoors.com.au' },   // see "Embedding on an existing site"
text: { 'welcome.title': 'Measure your front door in two minutes', 'quote.action.go': 'Book my check measure' },
```

Field types are `text`, `tel`, `email` and `textarea`; a `tel` answer needs at least 8 digits and an `email` answer must look like an address. `text` replaces any wording by its id. The ids are in the `strings` export at the top of each `js/screens/*.js` file, with shared ones in `js/strings.js` (`common.*`), pricing messages in `js/quote.js` (`pricing.*`) and form errors in `js/lead.js` (`lead.error.*`).

### Skins

A skin runs a second brand from the same copy. Put only the differences in `skins/<name>.js` and open the page with `?skin=<name>`:

```js
export default {   // skins/acme.js
  brand: { name: 'Acme Security Doors', colors: { accent: '#f5a524', accentContrast: '#1c1917' }, radius: '6px' },
};
```

Groups in `{ }` are merged over `js/config.js`, so you can change one colour and keep the rest. Lists in `[ ]`, such as `products`, are replaced whole. Names may use lower-case letters, digits and dashes, 40 characters at most. A missing or broken skin logs a console warning and the app starts with the default config.

## Getting leads into your system

| Setting | What happens when the customer taps "Send my enquiry" |
|---|---|
| `lead.endpoint` set | **Webhook.** The browser POSTs the JSON below to that address. Any 2xx reply counts as delivered. It gives up after 15 seconds. |
| otherwise `lead.mailto` set | **Email link.** The customer's own email app opens with a readable, pre-filled message and they must press send. The app cannot tell whether they did. No photo. |
| both empty | **Demo mode.** Nothing is sent. The confirmation screen shows the JSON that would have been sent. |

The webhook body, as built by `buildLeadPayload()` in `js/lead.js`:

```json
{
  "reference": "SM-YKJM8L", "createdAt": "2026-01-15T03:20:00.000Z", "brand": "SecureMeasure",
  "customer": { "name": "Sam Taylor", "phone": "0400 000 000", "email": "sam@example.com", "postcode": "4000", "notes": "", "consent": true },
  "measurement": { "widthMm": 820, "heightMm": 2043, "source": "photo", "quality": "fair", "sigmaWidthMm": 4.5, "sigmaHeightMm": 7.9 },
  "product": { "id": "diamond-grille", "name": "Classic Diamond Grille" },
  "selections": { "frame-colour": "black", "triple-lock": false, "pet-door": false, "door-closer": false },
  "includeInstallation": true,
  "quote": { "status": "ok", "total": 770, "subtotal": 700, "taxAmount": 70, "currency": "AUD", "lineItems": [
    { "id": "product", "label": "Classic Diamond Grille", "amount": 590 },
    { "id": "option:frame-colour", "label": "Frame colour: Black", "amount": 0 },
    { "id": "installation", "label": "Professional installation", "amount": 180 } ] }
}
```

- `customer` has one key per `lead.fields` id, plus `consent`. `selections` lists every option, with the default filled in where the customer did not choose.
- `measurement` is the size the quote was priced from. `source` is `"photo"` or `"manual"`. `quality` and the two sigmas (standard deviations in mm) are present for photo measurements only.
- For a size outside `pricing.limits`, `quote.status` is `"out_of_range"`, the amounts are `null` and `lineItems` is empty.
- `photo`, a JPEG data URL at most 1024 px on the long side, is added only when `lead.includePhoto` is `true`.
- `reference` is a short label shown to the customer. It is derived from the time and their details, so do not rely on it as a unique key.

**CORS.** The POST comes from the customer's browser with `Content-Type: application/json`, so an endpoint on a different domain from the page is first sent a preflight `OPTIONS` request. It must answer that with `Access-Control-Allow-Origin` (your site's origin, or `*`) and `Access-Control-Allow-Headers: Content-Type`, and send `Access-Control-Allow-Origin` on the POST reply as well. If your CRM or automation tool cannot do that, post to a small relay on your own domain instead. The page's Content-Security-Policy only allows requests to its own origin or to HTTPS addresses. No secret is sent and the address is visible in the page source, so the endpoint should expect and filter junk. If a send fails, the customer sees an error with your phone number and can try again; there is no automatic retry.

## Embedding on an existing site

```html
<iframe src="https://www.yourdoors.com.au/measure/?embed=1" title="Measure your door"
        style="width: 100%; max-width: 520px; height: 760px; border: 0"></iframe>
```

- `?embed=1` switches to a compact header and removes the frame drawn around the app on wide screens. It combines with a skin: `?embed=1&skin=acme`.
- The app fills the height of the iframe and scrolls inside it. It does not resize the iframe, so give it a fixed height. On phones, a link that opens the app full-screen gives the corner-marking screens more room.
- Photos come through a file input (camera or photo library), not live camera access, so the iframe needs no `allow="camera"`.

To follow a customer's progress from your own page, set `embed.parentOrigin` to the exact origin of the page that holds the iframe. The app then posts `{ source: 'securemeasure', type, payload }` to that origin only. Outside an iframe, or with `parentOrigin` empty, nothing is posted.

| `type` | Sent when | `payload` |
|---|---|---|
| `measured` | a photo has been measured, or the customer goes ahead with a typed size | `{ widthMm, heightMm, source, quality?, sigmaWidthMm?, sigmaHeightMm? }` |
| `quote` | the customer taps "Go ahead" (or "Request a custom quote") on the price screen | `{ size, productId, selections, includeInstallation, total, status }`; `total` is `null` for a custom quote |
| `lead` | the enquiry has been handed over (in demo mode too, which makes testing easy) | the full lead JSON above, personal details included |

```js
window.addEventListener('message', (event) => {
  if (event.origin !== 'https://www.yourdoors.com.au') return;   // the origin the app is served from
  if (event.data?.source === 'securemeasure' && event.data.type === 'lead') { /* for example, record a conversion */ }
});
```

## Hosting

- Any static host with HTTPS will do: your existing web server, GitHub Pages, Netlify, a storage bucket behind a CDN.
- There is no build step. The repo root is the site: upload it as it is, to the domain root or to any sub-folder (every path is relative). The empty `.nojekyll` file is there for GitHub Pages. The server must send `.js` files with a JavaScript MIME type, because the app uses native ES modules.
- `tools/`, `tests/` and `package.json` are for development and need not be uploaded. Node.js (built and tested on version 24) is needed only for `npm start` and the commands below, never by the app itself.
- `index.html` carries a Content-Security-Policy that only runs scripts from the app's own origin. If you add analytics or a tag manager, widen it there.

## Project layout

```
index.html            page shell; links the CSS and loads js/app.js
js/config.js          the one file you edit: brand, measurement, pricing, lead, embed, text
skins/acme.js         example skin, used with ?skin=acme
js/app.js             screen router, shared state, toasts, busy overlay, embed events
js/theme.js           loads the config and skin, applies the brand as CSS custom properties
js/strings.js, ui.js  shared wording and the text-override lookup; UI kit (DOM helpers, buttons, fields, icons)
js/photo.js           photo decoding, orientation and downscaling
js/vision.js          sheet detection, sub-pixel edge snapping, flattened preview
js/geometry.js        homographies and measureDoor(), the joint fit
js/editor.js          corner editor: drag, pinch-zoom, pan, magnifier, keyboard
js/quote.js           pricing engine, money and length formatting
js/lead.js            form validation, lead JSON, webhook / email link / demo delivery
js/screens/           one module per screen: welcome, prepare, sheet, door, result, quote, details, done
css/                  base.css (layout, design tokens, UI kit) and screens/*.css (per-screen styles)
assets/               favicon, demo-door.png and its ground-truth JSON
tests/                unit tests per module, plus an end-to-end test on rendered door scenes
tools/                serve.mjs (dev server), simulate.mjs (accuracy), scene.mjs + make-demo.mjs (demo photo), camera.mjs (camera model)
```

```
npm test            # every suite, on Node's built-in test runner
npm run simulate    # the accuracy report quoted above; flags go after "--": --trials 500 --seed 7 --json --sheet-band 0.3
npm run make-demo   # re-render assets/demo-door.png and its truth file
```

## Browser support and privacy

- Written for iOS Safari 15+ and Android Chrome 100+. It uses native ES modules with no polyfills, and newer CSS (colour tints, dynamic viewport height) has plain fallbacks. The corner editor also takes mouse, wheel and keyboard input on desktop.
- The automated tests cover the maths, image processing, pricing and lead logic under Node. The screens have no automated browser tests, so run the whole flow on a few real phones before you launch.
- The photo is decoded, shrunk and measured in the browser. The app has no analytics, cookies, local storage, web fonts or third-party requests, and a reload starts a fresh session.
- The only data that leaves the phone is the enquiry, when the customer taps "Send my enquiry": their form answers, the size, their choices and the quote. A reduced copy of the photo goes with it only if you set `lead.includePhoto: true`, and only by webhook. When the app is embedded with `parentOrigin` set, the same enquiry data is also posted to your host page.

## Roadmap ideas (not built)

- A live camera view with a guide overlay, in place of the photo picker.
- Recess-depth compensation for doors set back inside the frame.
- Automatic detection of the door edges, so the customer only confirms the corners.
- Lens-distortion correction.
- More than one language at a time. Today a config or skin can reword every string through `text`, in one language.

Copyright: all rights reserved. Not open source.
