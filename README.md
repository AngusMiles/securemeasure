# SecureMeasure

SecureMeasure is a white-label, phone-first web app for security-door companies. Your customer tapes a sheet of A4 paper to their front door, takes one photo, and gets the door opening's width and height in millimetres, an instant price from your price list, and a form to send you their details. It is a static site (plain HTML, CSS and JavaScript, with no build step, no dependencies and no server-side code) that you brand through one config file and host on your own website. The photo is processed on the customer's phone; nothing is sent anywhere until they submit the enquiry form.

The customer journey (a customer who already knows their door size can skip the photo and type it in):

1. Tape a sheet of A4 flat on the closed door (tape across the corners only, never along an edge) and take one photo of the whole door.
2. Tap the sheet in the photo. The app finds it and snaps its outline to the edges of the paper. If it is not sure of the outline it says so, and the customer checks or places the four corners.
3. Drag four handles onto the corners of the door opening, where the door meets the frame. Pinch-zoom, a magnifier and arrow nudges help with fine placement.
4. See the width and height in mm with a rating (good, fair or rough), a plus-or-minus figure and a flattened preview of the door. From here they can adjust the corners, retake the photo or type in a tape-measured size instead.
5. Choose a door and options, see the price, and send their contact details.

## Try it

```
npm start
```

Then open http://localhost:5173/. There is nothing to install: the dev server (`tools/serve.mjs`) has no dependencies. It listens on this computer only, and never serves files or folders whose names start with a dot (such as `.git`). Set the `PORT` environment variable to use another port, and `SM_HOST` to listen on another address: `SM_HOST=0.0.0.0` lets other devices on your network open it. (It reads `SM_HOST`, not the generic `HOST`, which some shells and toolchains set to something else.)

- **No door handy?** Tap "Try it with a demo photo" on the first screen. It loads a bundled synthetic photo of an 820 x 2040 mm door (a computer rendering, not a photograph). It is always measured with its own A4 sheet, whatever sheet is selected, and an enquiry sent from it is marked as a demo on screen and in the data you receive.
- **A second brand:** http://localhost:5173/?skin=acme shows the same app as "Acme Security Doors".
- **On a phone:** upload the folder to any static host with HTTPS and open the address on the phone. On a network you trust you can instead start the dev server with `SM_HOST=0.0.0.0` and open `http://<this computer's network address>:5173/` on the phone.
- Out of the box the app is in demo mode: no enquiry is sent anywhere, and the confirmation screen shows the data that would have been sent.

## How the measurement works

The sheet of paper and the door opening lie in the same plane, the face of the closed door.

- **The sheet gives scale.** Its size is known, but it is small, so on its own it is a poor ruler for something seven times its height.
- **The door fixes perspective.** The opening is assumed to be a rectangle. Its size is unknown, but its four corners are spread across the whole photo, which pins down the camera angle.
- **One joint fit.** `measureDoor()` in `js/geometry.js` fits a single plane-to-image mapping (a homography) to all eight corners at once by weighted least squares, with the door as a W x H rectangle and the sheet as a rectangle of known size. It returns W and H, a standard deviation for each, and a cross-check worked out from the sheet alone. It also works out which way round the sheet is, from how well each way fits the corners and from what a phone camera could have seen. When a photo leaves that open it does not guess quietly: half the gap between the two possible sizes is added to the plus-or-minus, which grades the result poor (unless the sheet is so nearly square that the two sizes are almost the same).
- **Sub-pixel sheet corners.** `js/vision.js` grows a region from the customer's tap, finds each side of the paper from the brightness step across it, fits a straight line per side and intersects the lines. This matters because every error on the sheet is magnified several times at door scale. The outline is then checked against colour: a hard shadow line across the sheet makes detection give up, and a side that would settle on the sheet's own shadow (a coloured, pastel or grey sheet on a pale door) is moved back onto the paper and the outline offered for checking. The sheet screen then shows one of three things:
  - **Found** (every side located to sub-pixel accuracy, confidence 0.7 or more): the green "Auto-detected" state. This, or a successful "Snap to edges", is what the measurement treats as snapped corners.
  - **Not sure** (edges not confirmed, or low confidence): the outline is kept as a starting position with a warning asking the customer to check each corner, and it is measured as hand-placed corners.
  - **Not found:** a starting rectangle to drag into place. At least one corner must be moved before the customer can continue.

  After any corner has been moved by hand the customer can press "Snap to edges", which fits the outline to the paper again.
- **A rating, not just a number.** Each result is graded good, fair or poor and can carry issue codes (sheet too small, steep angle, door near the edge of the photo, implausible size and so on), each shown as a plain-English tip. A poor result that cannot be trusted (corners that do not line up, an implausible size, the two checks disagreeing, or a photo where the app cannot tell whether the sheet is upright or on its side and the two possible sizes are far apart) is shown as "Check your photo" and puts "Retake photo" ahead of "Continue anyway". One that is poor only because its plus-or-minus is wide is shown as a "Rough measurement" and the customer can go straight on to the price. The "Accurate to about ±N mm" line is two standard deviations of the weaker dimension.

### Simulated accuracy

`npm run simulate` measures 5000 random photos per scenario: an 820 x 2040 mm door in a 1920 x 2560 px photo, camera 2.2 to 3.5 m away, up to 15 degrees to one side, 8 degrees of tilt and 3 degrees of roll, sheet anywhere on the door. It reads the three corner settings from `js/config.js` (`sigmaDoorPx`, `sigmaSheetRefinedPx`, `sigmaSheetManualPx`), so the fit is told exactly what the app tells it and the ratings below are the app's own. Each marked corner is given random error of that same size: 2.5 px on door corners, and on sheet corners either 0.5 px ("snapped") or 2 px ("by hand"). Absolute error in mm:

| Reference, sheet corners | Width: median / 95th percentile | Height: median / 95th percentile |
|---|---|---|
| A4, snapped | 3.6 / 10.6 | 6.5 / 22.2 |
| A4, by hand | 8.5 / 25.9 | 15.3 / 47.2 |
| Bank card, snapped | 5.8 / 17.5 | 20.7 / 62.8 |
| Bank card, by hand | 20.2 / 61.8 | 78.7 / 236.0 |

- With A4 and snapped corners, both dimensions land within 5 mm in 27% of trials and within 3 mm in 12%. Height is always the weaker dimension.
- The joint fit earns its keep: from the sheet alone, the same A4 photos give a 95th-percentile height error of 107 mm instead of 22 mm.
- The plus-or-minus figure matches these errors: they run at 0.95 of the reported standard deviation. That shows the sums are right when corners are marked as closely as the config assumes, and nothing more. How closely real customers mark them has not been measured. `npm run simulate -- --noise-scale 2` marks every corner twice as badly without telling the fit: the A4-snapped errors double (height: median 13 mm, 95th percentile 44 mm) and run at about 1.5 times the reported standard deviation, so the plus-or-minus shown would then be too tight.

**What the rating means.** The grades are tuned for quoting a door, not for making one, because a check measure follows. They are set by the larger of the two standard deviations (`QUALITY_THRESHOLDS` in `js/geometry.js`):

| The customer sees | `quality` in the enquiry | When |
|---|---|---|
| Good measurement | `good` | 8 mm or less, so the line reads "Accurate to about ±16 mm" or better, and nothing is flagged |
| Fair measurement | `fair` | up to 16 mm (±32 mm), or 8 mm or less with something minor flagged, such as a door that is small in the photo |
| Rough measurement | `poor` | above 16 mm, with nothing that makes the size untrustworthy. The customer can go straight on to the price |
| Check your photo | `poor` | the size cannot be trusted, whatever its plus-or-minus. "Retake photo" comes first |

How often each occurs in the simulation:

- **A4 with snapped corners:** 23% good, 66% fair, 12% rough. The reported standard deviation averages 5.7 mm on width and 11.2 mm on height, so the line shown is typically a little over ±20 mm.
- **A4 with snapped corners and the sheet's centre within the middle 30% of the door's height** (`--sheet-band 0.3`): 55% good, 45% fair, none rough. Height is measured best with the sheet near mid-height, which is why the app asks for it about halfway up.
- **A4 with hand-placed sheet corners, or a bank card either way:** every result grades poor, nearly all of them shown as rough, at about ±50 mm for A4 by hand. A bank card is offered for people with no paper; it is not a substitute for it.
- The scene behind the bundled demo photo, measured end to end with the door corners marked 2 px out, gives 820 x 2043 mm, graded good at ±16 mm. Its height standard deviation is 7.9 mm, just inside the 8 mm line.

### Known limits

**The simulation models corner-marking error only.** It assumes an ideal lens, a flat sheet lying exactly in the door plane, paper of exactly the stated size and a perfectly rectangular opening. Real photos add errors it leaves out:

- **Not yet tested on real phones or real doors.** Nothing in this repo has been checked against tape-measured doors, and the screens have not been run on physical devices. Every figure above comes from simulation and from automated tests under Node. That includes the handling of sideways photos on older iPhones (iOS 15.0 to 16.3), which was checked against simulated browser behaviour only.
- **The demo photo is synthetic.** `assets/demo-door.png` is rendered by `tools/scene.mjs` with soft, even lighting, an ideal lens and a perfectly flat sheet. It shows how the app flows. It says nothing about how real photos behave.
- **Accuracy depends on careful corner placement.** The size is only as good as the eight marked corners, and the figures above assume door corners placed to about 2.5 px and snapped sheet corners good to 0.5 px. Corners marked twice as badly double the error. Moving a corner of a snapped outline by hand makes the whole sheet count as hand-placed until "Snap to edges" is pressed, and hand-placed sheet corners usually grade rough (always at the simulated 2.2 to 3.5 m; a close, straight-on photo with the door filling it can reach fair).
- **It measures the rectangle the customer marks.** If the handles go on the outer trim instead of the opening, the trim is what gets measured. An out-of-square opening is reported as the best-fitting rectangle.
- **Everything must be in the plane of the sheet.** If the door sits back inside a deep frame and the corners are marked on a face nearer to or further from the camera than the sheet, the result is out by roughly 0.3% for each 10 mm of depth at 3 m: about 7 mm on a 2040 mm height.
- **The sheet must be flat and the stated size.** A curled or loosely taped sheet, or paper cut 1 mm off, throws out the scale of the whole door by up to about 0.5%, or 10 mm on the height. Opaque tape run along an edge of the sheet hides where the paper ends and moves that edge by the width of the tape: 24 mm tape puts the height about 4% out with no warning, which is why the app asks for tape across the corners only.
- **Lens distortion is not corrected.** Phone cameras bend straight lines slightly, most of all near the edges of the photo. The app warns when a door corner is within 2% of the edge, and that is all.
- **Shadows and sheet colour can still mislead the sheet finder.** A hard shadow line across the sheet sends the customer to place the corners by hand rather than giving a confident wrong height, whatever colour the sheet is. On a white or pale door a dark sheet (navy, black) is found as normal. A mid-tone coloured, pastel or pale grey sheet is usually caught sitting on its own shadow: the outline is moved back onto the paper but only offered for checking, so it is measured as hand-placed and usually graded rough. Not caught: a dark printed band across the sheet; a shadow that cuts off less than about 5% of the sheet on a pale door; a shadow narrower than about 3 px, which can leave the outline of a coloured or dark sheet a pixel or two out; and a grey or pale sheet that is about as dark as its own shadow along some side (a silver or mid-grey sheet in soft light, or the faint side of a light grey sheet's shadow). That last kind can still be outlined on the far edge of its shadow and announced as auto-detected, making the door about 2 to 5% small in simulated photos. This is why the app suggests a dark sheet for a pale door.
- **Which way round the sheet is depends on an ordinary camera view.** The check assumes an uncropped photo from the phone's main camera. A wrong pick changes the size by the sheet's proportions (up to 41% for A4). In simulation nearly every doubtful case is flagged and shown as "Check your photo"; the ones that slipped through unflagged came from the ultra-wide (0.5x) lens, at up to a few dozen per 100,000 photos.

Treat the result as a sound basis for a quote and keep every price "subject to check measure". The shipped disclaimer and screen wording already say so.

## Make it yours

Everything a door company changes is in `js/config.js`, which is heavily commented and written for non-developers. Edit, save, reload. Its sections, top to bottom:

### brand

```js
brand: {
  name: 'Northside Security Doors', tagline: 'Measured from one photo', radius: '14px',
  lang: 'en-AU',                // the language the wording is written in
  logoUrl: 'assets/logo.svg',   // '' shows the name as text instead
  phone: '1300 000 000',        // "Call us" on the confirmation screen, and when sending fails
  colors: { primary: '#14294b', primaryContrast: '#ffffff', accent: '#c2410c', accentContrast: '#ffffff' /* and 8 more */ },
},
```

The twelve colours, the corner radius and the font become CSS custom properties (`--sm-primary`, `--sm-accent` and so on) that every screen is built from. A mistyped colour is skipped with a console warning and the default kept. `primary` is also drawn as text on white (your name in the header, links, the outline buttons). If it is too light to read there, the app uses the text colour for those labels and logs a console warning, so put a light brand colour in `accent`, as `skins/acme.js` does. `lang` is a language tag such as `en-AU`, `en-US` or `de`. The app writes it to the page's `lang` attribute so that screen readers choose the right voice; change it when you translate the wording through `text`. `fontFamily` must name fonts already on the phone, because the app loads no web fonts. `email` and `website` are in the file but the current screens do not display them. The static page title, description and `assets/favicon.svg` are set in `index.html`.

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

A photo result outside `plausible` is graded poor, and the same range limits what a customer may type in. `adjustments` and `roundToMm` apply to photo measurements; a typed size is used as typed. `maxWorkingSizePx` (photos are shrunk to 2560 px on the long side) and the three `sigma...Px` values (how closely corners are assumed to be marked, which weights the fit and drives the rating) are best left alone. `npm run simulate` reads those three values, so re-run it if you do change them.

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

Price = base price + oversize surcharge + options + installation. The surcharge applies only when the width or the height exceeds `standardSize`, and is `oversizePerSqm` times the area beyond the standard area. Every amount is rounded to `roundTo`, and the price tags beside each door and option are rounded the same way, so a tag always equals the line it adds to the quote. A size outside `limits` gets no price: the customer is told it needs a custom quote and can still send their details. **Every price in the shipped file is a made-up demo value.**

### lead, embed and text

```js
lead: {
  endpoint: 'https://hooks.example.com/securemeasure',   // where enquiries go: see the next section
  contentType: '',                                       // '' sends plain text, which needs no preflight: see "CORS" below
  fields: [{ id: 'name', label: 'Full name', type: 'text', required: true, autocomplete: 'name' } /* phone, email, postcode, notes */],
  consentText: 'I agree to be contacted about my quote.',
  successTitle: 'Thanks, your request is in', successMessage: 'We will be in touch shortly to book your free check measure.',
},
embed: { parentOrigin: 'https://www.yourdoors.com.au' },   // see "Embedding on an existing site"
text: { 'welcome.title': 'Measure your front door in two minutes', 'quote.action.go': 'Book my check measure' },
```

Field types are `text`, `tel`, `email` and `textarea`; a `tel` answer needs at least 8 digits and an `email` answer must look like an address. `text` replaces any wording by its id. The ids are in the `strings` export at the top of each `js/screens/*.js` file, with shared ones in `js/strings.js` (`common.*`), pricing messages in `js/quote.js` (`pricing.*`), form errors in `js/lead.js` (`lead.error.*`) and the wording of the pre-filled email used by `lead.mailto`, also in `js/lead.js` (`lead.mail.*`, the `LEAD_MAIL_STRINGS` export). Three things to know about the confirmation screen:

- A `text` entry for `done.title` or `done.message` is shown instead of `lead.successTitle` or `lead.successMessage`.
- In email-link mode neither is shown. The screen says "One more step: send the email" (`done.mailtoTitle`, `done.mailtoNote`), because nothing is sent until the customer presses send.
- The last "What happens next" line is `done.next3` ("We make and fit your door.") when the enquiry includes installation and `done.next3Supply` ("We make your door.") when it does not. Reword both if you reword one.

### Skins

A skin runs a second brand from the same copy. Put only the differences in `skins/<name>.js` and open the page with `?skin=<name>`:

```js
export default {   // skins/acme.js
  brand: { name: 'Acme Security Doors', colors: { accent: '#f5a524', accentContrast: '#1c1917' }, radius: '6px' },
};
```

Groups in `{ }` are merged over `js/config.js`, so you can change one colour and keep the rest. Lists in `[ ]`, such as `products`, are replaced whole. Names may use lower-case letters, digits and dashes, 40 characters at most. A missing or broken skin logs a console warning and the app starts with the default config. A skin in another language sets `brand.lang` together with its `text`.

## Getting leads into your system

| Setting | What happens when the customer taps "Send my enquiry" |
|---|---|
| `lead.endpoint` set | **Webhook.** The browser POSTs the JSON below to that address. Any 2xx reply counts as delivered. It gives up after 15 seconds. |
| otherwise `lead.mailto` set | **Email link.** The customer's own email app opens with a readable, pre-filled message and they must press send. The app cannot tell whether they did, so the confirmation screen asks them to send the email instead of saying the enquiry is in. No photo. |
| both empty | **Demo mode.** Nothing is sent. The confirmation screen shows the JSON that would have been sent. |

The webhook body, as built by `buildLeadPayload()` in `js/lead.js`:

```json
{
  "reference": "SM-YKJM8L", "createdAt": "2026-01-15T03:20:00.000Z", "brand": "SecureMeasure", "demo": false,
  "customer": { "name": "Sam Taylor", "phone": "0400 000 000", "email": "sam@example.com", "postcode": "4000", "notes": "", "consent": true },
  "measurement": { "widthMm": 820, "heightMm": 2043, "source": "photo", "quality": "good", "sigmaWidthMm": 4.5, "sigmaHeightMm": 7.9 },
  "product": { "id": "diamond-grille", "name": "Classic Diamond Grille" },
  "selections": { "frame-colour": "black", "triple-lock": false, "pet-door": false, "door-closer": false },
  "includeInstallation": true,
  "quote": { "status": "ok", "total": 770, "subtotal": 700, "taxAmount": 70, "currency": "AUD", "lineItems": [
    { "id": "product", "label": "Classic Diamond Grille", "amount": 590 },
    { "id": "option:frame-colour", "label": "Frame colour: Black", "amount": 0 },
    { "id": "installation", "label": "Professional installation", "amount": 180 } ] }
}
```

- `demo` is always present. It is `true` only when the size was measured from the bundled demo photo, so your CRM can filter or tag those enquiries. A size the customer typed in is never a demo. In email-link mode the subject of a demo enquiry starts with `[DEMO] ` and the body says the size came from the built-in demo photo. The customer is told too, on the details and confirmation screens. This is not the same thing as demo mode, which is about where enquiries go.
- `customer` has one key per `lead.fields` id, plus `consent`. `selections` lists every option, with the default filled in where the customer did not choose.
- `measurement` is the size the quote was priced from. `source` is `"photo"` or `"manual"`. `quality` (`"good"`, `"fair"` or `"poor"`) and the two sigmas (standard deviations in mm) are present for photo measurements only. `"poor"` covers both "Rough measurement" and "Check your photo", and most photos with hand-placed sheet corners grade poor, so do not discard enquiries on `quality` alone.
- For a size outside `pricing.limits`, `quote.status` is `"out_of_range"`, the amounts are `null` and `lineItems` is empty.
- `photo`, a JPEG data URL at most 1024 px on the long side, is added only when `lead.includePhoto` is `true`. The bundled demo image is only attached to an enquiry marked `demo: true`.
- `reference` is a short label shown to the customer. It is derived from the time and their details, so do not rely on it as a unique key across customers. If a send fails and the customer tries again, the retry carries the same `reference` and `createdAt` as the first attempt (until they tap "Start again"), so a receiver that did get the first attempt can drop or merge the repeat.

**CORS.** The POST comes from the customer's browser. Its only header is `Content-Type: text/plain;charset=UTF-8` and it carries no cookies or credentials, which makes it a CORS "simple" request: the browser sends it straight away, with no preflight `OPTIONS` request first. The body is still the JSON text above, so the receiver must parse it as JSON whatever the content type says. This is the form Zapier documents for posting to a Catch Hook from a browser, and Make webhooks accept it as well; neither has been tested end to end from this app, so send yourself a test enquiry before you go live. An endpoint on a different domain from the page must still send `Access-Control-Allow-Origin` (your site's origin, or `*`) on its reply to the POST. Without it the browser reports a failure even though the data arrived. Set `lead.contentType: 'application/json'` only for a server of your own that insists on that header: the browser then sends a preflight first, and the server must answer it with `Access-Control-Allow-Origin` and `Access-Control-Allow-Headers: Content-Type`. If your CRM can do neither, post to a small relay on your own domain instead. The page's Content-Security-Policy only allows requests to its own origin or to HTTPS addresses. No secret is sent and the address is visible in the page source, so the endpoint should expect and filter junk. If a send fails, the customer sees an error with your phone number and can try again; there is no automatic retry.

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
| `measured` | a photo has been measured, or the customer goes ahead with a typed size | `{ widthMm, heightMm, source, quality?, sigmaWidthMm?, sigmaHeightMm?, demo? }`. `demo: true` is present only for a size measured from the bundled demo photo |
| `quote` | the customer taps "Go ahead" (or "Request a custom quote") on the price screen | `{ size, productId, selections, includeInstallation, total, status }`; `total` is `null` for a custom quote |
| `lead` | the enquiry has been handed over (in demo mode too, which makes testing easy) | the full lead JSON above, personal details and the `demo` flag included |

```js
window.addEventListener('message', (event) => {
  if (event.origin !== 'https://www.yourdoors.com.au') return;   // the origin the app is served from
  if (event.data?.source === 'securemeasure' && event.data.type === 'lead') { /* for example, record a conversion */ }
});
```

## Hosting

- Any static host with HTTPS will do: your existing web server, GitHub Pages, Netlify, a storage bucket behind a CDN.
- There is no build step. The repo root is the site: upload it as it is, to the domain root or to any sub-folder (every path is relative). The empty `.nojekyll` file is there for GitHub Pages. The server must send `.js` files with a JavaScript MIME type, because the app uses native ES modules.
- `tools/`, `tests/` and `package.json` are for development and need not be uploaded. If you copy the folder to a web server by hand, leave the `.git` folder out: it holds the whole history of the repo. Node.js 22 or newer (built and tested on version 24) is needed only for `npm start` and the commands below, never by the app itself.
- `index.html` carries a Content-Security-Policy that only runs scripts from the app's own origin. If you add analytics or a tag manager, widen it there.

## Project layout

```
index.html            page shell; links the CSS and loads js/app.js
js/config.js          the one file you edit: brand, measurement, pricing, lead, embed, text
skins/acme.js         example skin, used with ?skin=acme
js/app.js             screen router, shared state, toasts, busy overlay, embed events
js/theme.js           loads the config and skin, applies the brand as CSS custom properties, sets the page language
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
npm run simulate    # the accuracy report quoted above; flags go after "--": --trials 500 --seed 7 --json --sheet-band 0.3 --noise-scale 2
npm run make-demo   # re-render assets/demo-door.png and its truth file
```

The tests are written against the configuration as shipped. The groups named "as shipped" in `tests/config.test.mjs` pin the demo content (the brand name, the three demo doors, demo mode and so on) and are expected to fail once you edit `js/config.js`: adjust or delete them. The "is a valid config" groups in the same file check rules every config must obey, and are the ones to keep green. Every other test of the measuring, pricing, lead and theme code runs on a fixed copy of the shipped settings (`tests/helpers/shipped-config.mjs`), so editing `js/config.js` does not fail them. One end-to-end group, "js/config.js as it stands", puts your own settings through the demo photo, your price list and your form, and checks only what any working config must give. The example skin is pinned in the same way as the shipped config: if you change or delete `skins/acme.js`, adjust the acme groups in `tests/config.test.mjs` and `tests/e2e.test.mjs` and the skin tests in `tests/theme.test.mjs`.

## Browser support and privacy

- Written for iOS Safari 15+ and Android Chrome 100+. It uses native ES modules with no polyfills, and newer CSS (colour tints, dynamic viewport height) has plain fallbacks. The corner editor also takes mouse, wheel and keyboard input on desktop: Enter or Space on the photo stands in for the tap that places the sheet corners, then Tab and the arrow keys move them.
- The automated tests cover the maths, image processing, photo decoding (against simulated browser behaviour), pricing and lead logic under Node. The screens have no automated browser tests, so run the whole flow on a few real phones before you launch.
- The photo is decoded, shrunk and measured in the browser. The app has no analytics, cookies, local storage, web fonts or third-party requests, and a reload starts a fresh session. One exception: if the phone closes the page while its camera is open, the app reopens on the photo step with the sheet size the customer had chosen and tells them to take the photo with the camera app first. That choice is kept on the browser's history entry while the camera is open, not in storage.
- The only data that leaves the phone is the enquiry, when the customer taps "Send my enquiry": their form answers, the size, their choices and the quote. A reduced copy of the photo goes with it only if you set `lead.includePhoto: true`, and only by webhook. When the app is embedded with `parentOrigin` set, the same enquiry data is also posted to your host page.

## Roadmap ideas (not built)

- A live camera view with a guide overlay, in place of the photo picker.
- Recess-depth compensation for doors set back inside the frame.
- Automatic detection of the door edges, so the customer only confirms the corners.
- Lens-distortion correction.
- More than one language at a time. Today a config or skin can reword the app through `text` in one language and declare that language with `brand.lang`. The loading line and the "needs JavaScript" notice in `index.html`, and the message shown if the app cannot start (`common.bootFailed` in `js/strings.js`), are not covered by `text` and are translated in those files.

Copyright: all rights reserved. Not open source.
