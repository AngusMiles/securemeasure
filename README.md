# SecureMeasure

SecureMeasure is a white-label, phone-first web app for security-door companies. Your customer points their phone at their front door and gets a door size, an instant price from your price list, and a form to send you their details, with no tape measure and no paper. It is a static site (plain HTML, CSS and JavaScript, with no build step, no dependencies and no server-side code) that you brand through one config file and host on your own website. Everything is measured on the customer's phone; nothing is sent anywhere until they submit the enquiry form.

There are three ways to measure, plus a way round measuring:

| Way in | Phones | What the customer gets |
|---|---|---|
| **Measure with AR** | Android phones with Chrome and ARCore | The phone's AR camera measures the opening: an "AR estimate" in millimetres, with the closest of your standard sizes to choose from |
| **Measure with my camera** | Every phone | One photo, matched to the closest of your standard sizes. No paper, and no millimetres read off the photo |
| **Measure exactly with a sheet of paper** | Every phone | A sheet of A4 taped to the door gives the photo a scale: width and height in mm with a plus-or-minus and a rating |
| **I already know my door size** | Every phone | They type it in |

The first two are estimates and the app says so: the customer is told the exact size is confirmed by a check measure before their door is made. The paper method is the exact option. Every way ends the same: choose a door and options, see the price, and send their contact details.

**Nothing has been tested on real phones or against tape-measured doors yet.** Every accuracy figure in this file comes from simulation, from benchmarks on photos whose sizes were assumed rather than measured, or from published studies. See [What still needs testing](#what-still-needs-testing) before you quote any of it to a customer.

The customer journeys:

- **AR** (offered only on a phone that can do it): stand 1 to 2 m back in good light, point at the floor and move slowly until a ring appears, then tap the two bottom corners where the frame meets the ground, the top of a raised step if there is one, and the two top corners. See the size as an "AR estimate" with the closest standard size, and choose "Use the standard size" or "Use my measurement".
- **Camera:** allow the camera, fit the whole door opening inside the on-screen frame and take one photo. The app looks for the door and puts four handles on its corners; the customer checks or drags each one to where the door meets the frame. They see the nearest standard size, can pick another from "Which is your door?" when the photo leaves it open, and can always switch to the paper method or type in a tape-measured size. Phones without a usable live camera (blocked, in-app browsers, older phones) use the phone's camera app or a photo from the library instead.
- **Paper:** tape a sheet of A4 flat on the closed door (tape across the corners only, never along an edge) and take one photo of the whole door. Tap the sheet; the app finds it and snaps its outline to the edges of the paper. Drag four handles onto the corners of the door opening (pinch-zoom, a magnifier and arrow nudges help). See the width and height in mm with a rating (good, fair or rough), a plus-or-minus figure and a flattened preview of the door. From here they can adjust the corners, retake the photo or type in a tape-measured size instead.

## Try it

```
npm start
```

Then open http://localhost:5173/. There is nothing to install: the dev server (`tools/serve.mjs`) has no dependencies. It listens on this computer only, and never serves files or folders whose names start with a dot (such as `.git`). Set the `PORT` environment variable to use another port, and `SM_HOST` to listen on another address: `SM_HOST=0.0.0.0` lets other devices on your network open it. (It reads `SM_HOST`, not the generic `HOST`, which some shells and toolchains set to something else.)

- **No door handy?** Tap "Try it with a demo photo" on the first screen. It loads a bundled synthetic photo of an 820 x 2040 mm door (a computer rendering, not a photograph) into the no-paper photo estimate. The paper method has its own demo button on its "Get set up" screen; there the photo is always measured with its own A4 sheet, whatever sheet is selected. An enquiry sent from either is marked as a demo on screen and in the data you receive.
- **A second brand:** http://localhost:5173/?skin=acme shows the same app as "Acme Security Doors".
- **On a phone:** the live camera and AR only work on a secure page: HTTPS, or `localhost` on the device itself. Upload the folder to any static host with HTTPS and open the address on the phone. On a network you trust you can instead start the dev server with `SM_HOST=0.0.0.0` and open `http://<this computer's network address>:5173/` on the phone, but over plain `http` the app falls back to the phone's camera app and photo library, and does not offer AR. To try AR from this computer, connect an Android phone by USB and use Chrome's port forwarding (`chrome://inspect` on the computer, forward port 5173), then open `http://localhost:5173/` on the phone.
- Out of the box the app is in demo mode: no enquiry is sent anywhere, and the confirmation screen shows the data that would have been sent.

## How accurate each way is

| Way in | Shown to the customer as | Accuracy, honestly |
|---|---|---|
| AR | "AR estimate" in mm, plus the closest standard size | About ±30 to ±90 mm (95% of measurements) in an error model, depending on how far the phone's AR scale is out. Published tests of ARCore phones show the scale error varies a lot from phone to phone. Never advertise ±20 mm |
| Camera (no paper) | The nearest of your standard sizes, marked "Estimate" | With the Australian size list, picks exactly the right standard size about 77% of the time in simulation (corners tapped to about 3 px) and has it in its top two about 98% of the time. It reads no millimetres at all |
| Paper | Width and height in mm, a rating and "Accurate to about ±N mm" | With A4 and auto-detected sheet corners: median error 3.6 mm wide and 6.5 mm high, 95th percentile 10.6 mm and 22.2 mm, in simulation |
| Typed in | "Entered by you" | As typed |

Treat every result as a sound basis for a quote and keep every price "subject to check measure". The shipped disclaimer and screen wording already say so, and the AR and camera results always say a check measure confirms the size.

## How the measurement works

### Measure with AR

This uses WebXR, the browser's augmented-reality interface, which only Chrome on Android phones with ARCore (Google Play Services for AR) provides. No iPhone browser has it.

- **Floor-anchored.** The customer taps the foot of each side of the frame where it meets the ground, found by hitting the floor the phone has tracked. The door is taken to stand in the vertical plane through those two points, and the two top corners are where the aiming line meets that plane. A raised step can be tapped once so the height is measured from its top. `js/xr-measure.js` does the sums, and `js/ar-flow.js` steps through the taps, taking the median of several frames for each one.
- **Self-checks catch blunders, not small errors.** If the two widths or the two heights disagree by more than 60 mm, or the corners are badly out of square, the customer is asked to try again in the same session. An unusual size (such as a wide double door), a base that is not level or a point off the door plane is shown as a warning with the result and sent with the enquiry.
- **How accurate.** The phone's AR tracking has a scale error of its own, which no second pass in the same session can detect, and it is the biggest unknown. In an error model (assumed noise, not measurements) of an 820 x 2040 mm opening measured from 1.8 m:

  | Phone's AR scale error | Width, 95% within | Height, 95% within |
  |---|---|---|
  | none | ±29 mm | ±36 mm |
  | 1% | ±34 mm | ±54 mm |
  | 2% | ±44 mm | ±90 mm |
  | 5% | ±87 mm | ±209 mm |

  Published tests of ARCore phones show why this matters: in one 2022 study, Samsung phones read a 100 cm reference anywhere from 86 to 125 cm at 1 to 2 m, and another study found ARCore points drifting several centimetres after small movements and much more in low light. Only a field trial on your customers' phones can say which row applies.
- **The result** is shown as an "AR estimate", with "Closest standard size: W x H mm" and a choice of "Use the standard size" or "Use my measurement" when one of your standard sizes is within 60 mm on the width and 90 mm on the height. Otherwise the customer is told their door may not be a standard size. A check measure confirms it either way.

### Measure with my camera (no paper)

A photo with nothing of known size in it has no scale: from the photo alone, a big door far away looks just like a small door close up. What a photo does fix is the opening's shape.

- **The shape from four corners.** `js/estimate.js` takes the four corners the customer confirmed and the camera's focal length and recovers the opening's height-to-width ratio, allowing for the camera looking at the door from an angle. In simulation, with corners tapped to about 3 px, the ratio is within about 0.6% (median) and 1.6% (90th percentile). On 16 real door photos, checked against assumed rather than tape-measured sizes, it was 1.4% and 2.8%.
- **Matched to your list.** The ratio is compared with the ratios of the standard sizes you sell (`measurement.standardSizes`) and the customer is shown the most likely one, with up to two others under "Which is your door?" when the photo cannot tell them apart. The app never shows millimetres read off the photo itself.
  - With the Australian list, the right size comes first about 77% of the time at 3 px tapping and 62% at 5 px, and is in the top two about 98% and 90% of the time.
  - Almost every miss involves the 2340 mm high sizes, whose shapes are very close to others'. A miss can be big: 100 mm on the width or 240 to 300 mm on the height, mostly a 2040 high door taken for a 2340 one. That is why the customer sees the other possible sizes and a check measure always follows.
  - Those misses are what the one-tap height question is for. When the sizes on offer differ in height by at least 150 mm, each is labelled with which of your heights it is, and when the estimate is unsure the banner asks the customer to pick: with the Australian list, "Is your door a standard height or tall?", where 2040 and 2100 count as one height ("Standard height") and 2340 is "Tall". Heights less than 150 mm apart look the same on a door, so they are never told apart this way, and a list whose heights all look alike gets no labels and no question.
  - The US and UK example lists score higher in simulation only because they are so short. Do not quote those figures: real stock has more sizes.
  - A door that matches none of your sizes is flagged "Your door may not be a standard size".
- **The focal length** comes from the photo's EXIF data (the 35 mm-equivalent focal length) when the phone writes it and the photo is the camera's whole frame (not cropped, and not 16:9 or square), and otherwise a typical phone main camera (26 mm) is assumed. A wrong guess barely matters when the photo is taken square-on, but can be badly out at an angle (about 10% for a 2x-zoom photo taken 30 degrees off to one side), so the app asks the customer to face the door straight on and flags steep angles.
- **Flags** the customer sees: corners that are not a rectangle (more than 2 degrees out of square), a steep angle, a door that may not be standard, a door near the edge of the photo, and a door that is small in the photo (under 30% of its height).

**Why there is no AI model.** Three single-photo depth models that can run in a browser (MoGe-2, Metric3D v2 and Depth Anything V2 metric) were benchmarked on 27 real and 6 synthetic door photos. Every real photo came out 4% to 58% too big. Even after a correction fitted on half the photos, they were typically about 8% out, and 15% to 20% out one time in ten: too loose to choose between standard sizes 50 mm apart, for a 27 to 40 MB download and several seconds per photo on a phone. The four-corner method above does better with no download.

### Finding the door in the photo

`js/door-detect.js` looks for the door outline in the photo (straight edges and door-shaped rectangles, no AI model) in a background worker, so the screen stays responsive.

- It puts the four starting handles a median 17 px from where a person would put them, against 229 to 508 px for a fixed starting rectangle, so the customer usually only fine-tunes.
- It says "We found your door" only above a confidence of 0.6. On 27 real photos, 8 were that confident and none of those was wrong, but that threshold was tuned on the same photos: across the other test runs, 0 to 7% of confident outlines were wrong.
- Its main mistake is picking a neighbouring rectangle: the architrave, the panel above the door, a glazed panel or the step below. That would make the door 50 to 120 mm too wide, so the customer always confirms the corners, and "Not this? Show the next outline" offers its other suggestions (the right outline is among the first three about 74% of the time).
- It never measures anything on its own. The paper method uses it too, for its starting handles.

### The paper method (exact)

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

#### Simulated accuracy of the paper method

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

#### Known limits of the paper method

**The simulation models corner-marking error only.** It assumes an ideal lens, a flat sheet lying exactly in the door plane, paper of exactly the stated size and a perfectly rectangular opening. Real photos add errors it leaves out:

- **Accuracy depends on careful corner placement.** The size is only as good as the eight marked corners, and the figures above assume door corners placed to about 2.5 px and snapped sheet corners good to 0.5 px. Corners marked twice as badly double the error. Moving a corner of a snapped outline by hand makes the whole sheet count as hand-placed until "Snap to edges" is pressed, and hand-placed sheet corners usually grade rough (always at the simulated 2.2 to 3.5 m; a close, straight-on photo with the door filling it can reach fair).
- **It measures the rectangle the customer marks.** If the handles go on the outer trim instead of the opening, the trim is what gets measured. An out-of-square opening is reported as the best-fitting rectangle. (This applies to the no-paper estimate too.)
- **Everything must be in the plane of the sheet.** If the door sits back inside a deep frame and the corners are marked on a face nearer to or further from the camera than the sheet, the result is out by roughly 0.3% for each 10 mm of depth at 3 m: about 7 mm on a 2040 mm height.
- **The sheet must be flat and the stated size.** A curled or loosely taped sheet, or paper cut 1 mm off, throws out the scale of the whole door by up to about 0.5%, or 10 mm on the height. Opaque tape run along an edge of the sheet hides where the paper ends and moves that edge by the width of the tape: 24 mm tape puts the height about 4% out with no warning, which is why the app asks for tape across the corners only.
- **Lens distortion is not corrected.** Phone cameras bend straight lines slightly, most of all near the edges of the photo. The app warns when a door corner is within 2% of the edge, and that is all.
- **Shadows and sheet colour can still mislead the sheet finder.** A hard shadow line across the sheet sends the customer to place the corners by hand rather than giving a confident wrong height, whatever colour the sheet is. On a white or pale door a dark sheet (navy, black) is found as normal. A mid-tone coloured, pastel or pale grey sheet is usually caught sitting on its own shadow: the outline is moved back onto the paper but only offered for checking, so it is measured as hand-placed and usually graded rough. Not caught: a dark printed band across the sheet; a shadow that cuts off less than about 5% of the sheet on a pale door; a shadow narrower than about 3 px, which can leave the outline of a coloured or dark sheet a pixel or two out; and a grey or pale sheet that is about as dark as its own shadow along some side (a silver or mid-grey sheet in soft light, or the faint side of a light grey sheet's shadow). That last kind can still be outlined on the far edge of its shadow and announced as auto-detected, making the door about 2 to 5% small in simulated photos. This is why the app suggests a dark sheet for a pale door.
- **Which way round the sheet is depends on an ordinary camera view.** The check assumes an uncropped photo from the phone's main camera. A wrong pick changes the size by the sheet's proportions (up to 41% for A4). In simulation nearly every doubtful case is flagged and shown as "Check your photo"; the ones that slipped through unflagged came from the ultra-wide (0.5x) lens, at up to a few dozen per 100,000 photos.
- **The demo photo is synthetic.** `assets/demo-door.png` is rendered by `tools/scene.mjs` with soft, even lighting, an ideal lens and a perfectly flat sheet. It shows how the app flows. It says nothing about how real photos behave, for any of the three ways in.

## What still needs testing

Nothing in this repo has been checked against tape-measured doors, and the screens have not been run on physical devices. Every figure above comes from simulation, from benchmarks against assumed sizes, from published studies and from automated tests under Node (including the handling of sideways photos on older iPhones, iOS 15.0 to 16.3, which was checked against simulated browser behaviour only). Before you quote any accuracy to customers:

- **AR, on several Android phones against a tape measure.** At least six phones (a Pixel, a Samsung S series, a budget Samsung A series, a Xiaomi, a Motorola and one older Android 8 to 10 phone) on at least ten real openings, tape-measured inside the frame. Three passes each from 1.2, 1.8 and 2.5 m, in daylight and in low light. Record the phone, the Chrome and ARCore versions, the warnings and the time taken, and work out the bias and the 95th-percentile error per phone for width and height. Only then state a tolerance, and only ±50 mm if most phones keep the height error within that 95% of the time. Some phones may be better sent to the photo or paper method.
- **The photo estimate, on about 20 tape-measured local doors.** Photograph them with iPhones and Android phones, through the live camera and through the camera app, and count how often the right standard size comes first and how often it is in the top two. This also shows whether iPhones on iOS 18.4 and later deliver the lens's focal length with a live-camera photo (expected, not confirmed).
- **The paper method, on the same doors**, to see how real customers' corner marking compares with the simulation.
- **On real devices generally:** the camera and AR permission prompts; Chrome's Google Play Services for AR install prompt; phones that report AR support but then fail to start it; whether a live camera still running blocks AR; the drawing lining up with the camera view in AR; hit-testing on real porch surfaces (tiles, dark mats, timber decks) and in porch light; in-app browsers (Facebook, Instagram); Samsung Internet; and the app inside an iframe on your site, with AR.

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
  methods: { ar: true, camera: true, paper: true },           // the ways in the welcome screen offers
  standardSizes: [{ widthMm: 820, heightMm: 2040 } /* the opening sizes you sell */],
  references: [{ id: 'a4', label: 'A4 paper', widthMm: 210, heightMm: 297, recommended: true } /* US Letter, bank card */],
  defaultReferenceId: 'a4', allowCustomReference: true,       // the customer may type in the size of their own sheet
  adjustments: { widthMm: -6, heightMm: -6 }, roundToMm: 1,   // added to a measured opening to get the size you quote
  plausible: { minWidthMm: 500, maxWidthMm: 1500, minHeightMm: 1500, maxHeightMm: 2800 },
  allowManualOverride: true,                                  // false makes measuring the only way to get a size
  demoPhotoUrl: 'assets/demo-door.png',                       // '' removes the demo buttons. The app knows this file's lens, so give your own demo photo a new file name
},
```

- **`methods`** turns each way in on or off: `ar` (Android phones with AR), `camera` (the no-paper photo, every phone) and `paper` (the exact method). The AR button only ever appears on a phone and browser that report they can do AR, so leaving `ar` on costs iPhone customers nothing. With `camera` and `ar` both off, the paper method is the main button, as in earlier versions. With `camera` and `paper` both off, the welcome screen leads with "Enter my door size" and customers on most phones (every iPhone) can only type in a size; the console warns about this setting. (If `allowManualOverride` is `false` as well, `paper` is kept on, so there is always a way to a size.)
- **`standardSizes`** lists the door opening sizes you sell, in mm. The photo estimate can only ever answer with one of these, and an AR measurement offers the nearest one, so list only sizes you make. The shipped list is common Australian sizes: 720, 770, 820, 870 and 920 wide x 2040 high; 820, 870 and 920 x 2100; 820 and 920 x 2340. US example: 762, 813 or 914 x 2032 (and 813 or 914 x 2134 for 7 ft doors). UK example: 762 or 838 x 1981. Keep 820 x 2040 in the list while you keep the demo photo, which is that size. A list that cannot be used falls back to the Australian one.
- `adjustments` and `roundToMm` apply to every measured size (paper, the standard size matched to a photo, and AR) to give the size you quote and make; a typed size is used as typed. A paper result outside `plausible` is graded poor, and the same range limits what a customer may type in. `maxWorkingSizePx` (photos are shrunk to 2560 px on the long side) and the three `sigma...Px` values (how closely corners are assumed to be marked in the paper method, which weights the fit and drives the rating) are best left alone. `npm run simulate` reads those three values, so re-run it if you do change them.

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
  quoteValidDays: 30, disclaimer: 'This price is an estimate based on the size you gave us. We confirm the exact size and final price with a free check measure.',
},
```

Price = base price + oversize surcharge + options + installation. The surcharge applies only when the width or the height exceeds `standardSize`, and is `oversizePerSqm` times the area beyond the standard area. Every amount is rounded to `roundTo`, and the price tags beside each door and option are rounded the same way, so a tag always equals the line it adds to the quote. A size outside `limits` gets no price: the customer is told it needs a custom quote and can still send their details. `pricing.standardSize` is only the surcharge threshold; it is not the same thing as `measurement.standardSizes`, so a door in your list can still carry a surcharge. **Every price in the shipped file is a made-up demo value.**

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
text: { 'welcome.title': 'Measure your front door in a minute', 'quote.action.go': 'Book my check measure' },
```

Field types are `text`, `tel`, `email` and `textarea`; a `tel` answer needs at least 8 digits and an `email` answer must look like an address. `text` replaces any wording by its id. The ids are in the `strings` export at the top of each `js/screens/*.js` file, with shared ones in `js/strings.js` (`common.*`), pricing messages in `js/quote.js` (`pricing.*`), form errors in `js/lead.js` (`lead.error.*`) and the wording of the pre-filled email used by `lead.mailto`, also in `js/lead.js` (`lead.mail.*`, the `LEAD_MAIL_STRINGS` export). Things to know about the confirmation screen:

- A `text` entry for `done.title` or `done.message` is shown instead of `lead.successTitle` or `lead.successMessage`.
- In email-link mode neither is shown. The screen says "One more step: send the email" (`done.mailtoTitle`, `done.mailtoNote`), because nothing is sent until the customer presses send.
- The "What happens next" list has two lines that change with the enquiry. The middle one is `done.next2` ("We confirm your final price.") for a paper or typed size and `done.next2Estimate` ("We measure your door exactly and confirm your final price.") for a photo estimate or an AR estimate. The last one is `done.next3` ("We make and fit your door.") when the enquiry includes installation and `done.next3Supply` ("We make your door.") when it does not. Reword both of a pair if you reword one.

### Skins

A skin runs a second brand from the same copy. Put only the differences in `skins/<name>.js` and open the page with `?skin=<name>`:

```js
export default {   // skins/acme.js
  brand: { name: 'Acme Security Doors', colors: { accent: '#f5a524', accentContrast: '#1c1917' }, radius: '6px' },
};
```

Groups in `{ }` are merged over `js/config.js`, so you can change one colour and keep the rest. Lists in `[ ]`, such as `products` and `standardSizes`, are replaced whole, so a skin for a US brand lists all its own sizes. Names may use lower-case letters, digits and dashes, 40 characters at most. A missing or broken skin logs a console warning and the app starts with the default config. A skin in another language sets `brand.lang` together with its `text`.

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

`measurement` is the size the quote was priced from, after your `adjustments`, and says how it was got. Its `source` is one of four values, and each carries its own extra fields:

```json
{ "widthMm": 820, "heightMm": 2043, "source": "photo", "quality": "good", "sigmaWidthMm": 4.5, "sigmaHeightMm": 7.9 }
{ "widthMm": 820, "heightMm": 2040, "source": "estimate", "standard": true, "standardSize": { "widthMm": 820, "heightMm": 2040 }, "alternatives": [{ "widthMm": 870, "heightMm": 2100 }], "aspectHW": 2.4878, "nonStandard": false, "confident": false, "appConfident": false, "issues": [] }
{ "widthMm": 820, "heightMm": 2040, "source": "ar", "standard": true, "standardOffered": true, "measured": { "widthMm": 826, "heightMm": 2051 }, "warnings": [] }
{ "widthMm": 900, "heightMm": 2100, "source": "manual" }
```

- `"photo"` is the paper method (the name is kept from earlier versions). `quality` (`"good"`, `"fair"` or `"poor"`) and the two sigmas (standard deviations in mm) are present for it only. `"poor"` covers both "Rough measurement" and "Check your photo", and most photos with hand-placed sheet corners grade poor, so do not discard enquiries on `quality` alone.
- `"estimate"` is the no-paper photo: the size is the standard size the customer accepted (`standard` is always `true`), and the measurement needs a check measure. `standardSize` is that standard size and `alternatives` lists the other standard sizes the customer was offered under "Which is your door?" (empty when there were none), both exactly as they appear in your `standardSizes`, before `adjustments`. `appBest` is there only when the customer picked a size under "Which is your door?" other than the one the app thought most likely, and names that most likely size (as listed, before `adjustments`). `aspectHW` is the opening's height-to-width ratio read from the photo. The last four say what the customer was warned about. `nonStandard: true` means the shape matched none of your sizes well, so the door may be a size you do not list (perhaps wider than you price) and the size sent could be some way out; the customer was told so. `confident` is about the size sent: `true` only when the app was sure of it. `confident: false` means the customer was told the app could not be sure which standard size it is, or, when `appBest` is present, that the customer picked a size the app did not put first. `appConfident` is about the app's own most likely size, whichever size the customer then picked: `false` means the result screen warned the customer that it could not be sure (or, with `nonStandard: true`, that the door may not be a standard size) and left the pick to them, so with `appBest` the customer was answering that; `true` with `appBest` means the customer overruled a size the app was sure of. Without `appBest` it is the same as `confident`. `issues` lists the photo checks that flagged something: `not_rectangular`, `steep_angle`, `non_standard`, `door_near_edge` or `door_small`. A priced estimate is still only a guess at a standard size, so read these before you treat it as one.
- `"ar"` is the AR camera. `standard` is `true` when the customer chose "Use the standard size". It is `false` either when they kept their own measurement or when none of your standard sizes was close enough to offer, and `standardOffered` tells these apart: `true` when the result screen offered a standard size (within 60 mm wide and 90 mm high), `false` when it told the customer their door may not be a standard size. `measured` is the AR reading of the opening, in whole mm, before `adjustments`. `warnings` lists the AR checks it failed: `base_not_level`, `off_plane`, `widths_disagree`, `heights_disagree`, `out_of_square` or `implausible_size`. It needs a check measure too.
- `"manual"` is a size the customer typed in. An enquiry with any other `source` value is recorded as `"photo"`.
- `demo` is always present. It is `true` only when the size was read off the bundled demo photo (by the paper method or the photo estimate), so your CRM can filter or tag those enquiries. A size the customer typed in, or measured with AR, is never a demo. In email-link mode the subject of a demo enquiry starts with `[DEMO] ` and the body says the size came from the built-in demo photo. The customer is told too, on the details and confirmation screens. This is not the same thing as demo mode, which is about where enquiries go.
- In email-link mode the "Measured:" line says which way was used, and for a photo estimate or AR that it needs a check measure. A photo estimate adds the other standard sizes it could be, the app's most likely size when the customer chose a different one (the "Measured:" line then says the customer chose the size rather than that it was matched, and the line naming the app's size says whether the app had asked the customer to pick or the customer overruled a size it was sure of), and anything the customer was warned about (a door that may not be a standard size, or an estimate the app was not sure of, whichever size the customer then picked, and the photo checks that flagged it). When `adjustments` make the door size differ from the standard size, the email also names the standard size (as the matched one, or as the one the customer chose), and it says that the standard sizes it lists come before your fitting allowance. AR adds its reading of the opening, whether the customer chose the nearest standard size, kept their reading instead or was offered none, and any checks it failed.
- `customer` has one key per `lead.fields` id, plus `consent`. `selections` lists every option, with the default filled in where the customer did not choose.
- For a size outside `pricing.limits`, `quote.status` is `"out_of_range"`, the amounts are `null` and `lineItems` is empty.
- `photo`, a JPEG data URL at most 1024 px on the long side, is added only when `lead.includePhoto` is `true`, and only when the size was measured from that photo (or typed in over a measurement of it). An AR enquiry never carries one, even if the customer had picked a photo before they backed out and used AR. The bundled demo image is only attached to an enquiry marked `demo: true`.
- `reference` is a short label shown to the customer. It is derived from the time and their details, so do not rely on it as a unique key across customers. If a send fails and the customer tries again, the retry carries the same `reference` and `createdAt` as the first attempt (until they tap "Start again"), so a receiver that did get the first attempt can drop or merge the repeat.

**CORS.** The POST comes from the customer's browser. Its only header is `Content-Type: text/plain;charset=UTF-8` and it carries no cookies or credentials, which makes it a CORS "simple" request: the browser sends it straight away, with no preflight `OPTIONS` request first. The body is still the JSON text above, so the receiver must parse it as JSON whatever the content type says. This is the form Zapier documents for posting to a Catch Hook from a browser, and Make webhooks accept it as well; neither has been tested end to end from this app, so send yourself a test enquiry before you go live. An endpoint on a different domain from the page must still send `Access-Control-Allow-Origin` (your site's origin, or `*`) on its reply to the POST. Without it the browser reports a failure even though the data arrived. Set `lead.contentType: 'application/json'` only for a server of your own that insists on that header: the browser then sends a preflight first, and the server must answer it with `Access-Control-Allow-Origin` and `Access-Control-Allow-Headers: Content-Type`. If your CRM can do neither, post to a small relay on your own domain instead. The page's Content-Security-Policy only allows requests to its own origin or to HTTPS addresses. No secret is sent and the address is visible in the page source, so the endpoint should expect and filter junk. If a send fails, the customer sees an error with your phone number and can try again; there is no automatic retry.

## Embedding on an existing site

```html
<iframe src="https://www.yourdoors.com.au/measure/?embed=1" title="Measure your door"
        allow="camera; xr-spatial-tracking; fullscreen" allowfullscreen
        style="width: 100%; max-width: 520px; height: 760px; border: 0"></iframe>
```

- `?embed=1` switches to a compact header and removes the frame drawn around the app on wide screens. It combines with a skin: `?embed=1&skin=acme`.
- **The `allow` attribute matters.** Browsers block the camera and AR inside an iframe from another site unless the page that holds it allows them. `camera` lets the live camera view start; without it the capture screen says the camera can't open inside this page, and the phone's camera app and photo library become the main buttons (with no "Allow camera" retry, since asking again would fail the same way). `xr-spatial-tracking` lets AR start, and `fullscreen` (with `allowfullscreen` for older browsers) is needed too, because Chrome shows the AR view through full-screen mode and refuses every AR session on a page that may not use it. Without either, the "Measure with AR" button is simply not offered, and customers use the photo instead (or the paper method, or typing a size they know, when the camera way in is switched off). Without `fullscreen`, the browser console also logs a `[SecureMeasure] AR measuring is off: this page may not use fullscreen…` hint; a `Permissions-Policy` header on your page must allow fullscreen for the same reason. AR inside an iframe has not been tried on a real phone, so on phones a link that opens the app full-screen is the safer choice, and it gives the corner-marking screens more room as well.
- The app fills the height of the iframe and scrolls inside it. It does not resize the iframe, so give it a fixed height.

To follow a customer's progress from your own page, set `embed.parentOrigin` to the exact origin of the page that holds the iframe. The app then posts `{ source: 'securemeasure', type, payload }` to that origin only. Outside an iframe, or with `parentOrigin` empty, nothing is posted.

| `type` | Sent when | `payload` |
|---|---|---|
| `measured` | a door has been measured (any way in), or the customer goes ahead with a typed size or a different standard size | `{ widthMm, heightMm, source, standard?, quality?, sigmaWidthMm?, sigmaHeightMm?, demo? }`. `source` is `photo`, `estimate`, `ar` or `manual`, as in the lead. `standard` is present for a photo estimate (always `true`) and AR. `demo: true` is present only for a size read off the bundled demo photo |
| `quote` | the customer taps "Go ahead" (or "Request a custom quote") on the price screen | `{ size, productId, selections, includeInstallation, total, status }`; `total` is `null` for a custom quote |
| `lead` | the enquiry has been handed over (in demo mode too, which makes testing easy) | the full lead JSON above, personal details and the `demo` flag included |

```js
window.addEventListener('message', (event) => {
  if (event.origin !== 'https://www.yourdoors.com.au') return;   // the origin the app is served from
  if (event.data?.source === 'securemeasure' && event.data.type === 'lead') { /* for example, record a conversion */ }
});
```

## Hosting

- Any static host with HTTPS will do: your existing web server, GitHub Pages, Netlify, a storage bucket behind a CDN. HTTPS is not optional: the live camera and AR do not work on a plain `http` page.
- **Use your own domain.** The phone's camera prompt names the site asking ("www.yourdoors.com.au wants to use your camera"), and Chrome remembers the camera and AR permissions per site. Served from `<user>.github.io`, the prompt would show that address instead of your name, so give GitHub Pages (or any host) a custom domain.
- There is no build step. The repo root is the site: upload it as it is, to the domain root or to any sub-folder (every path is relative). The empty `.nojekyll` file is there for GitHub Pages. The server must send `.js` files with a JavaScript MIME type, because the app uses native ES modules (and a module worker for finding the door).
- `tools/`, `tests/` and `package.json` are for development and need not be uploaded. If you copy the folder to a web server by hand, leave the `.git` folder out: it holds the whole history of the repo. Node.js 22 or newer (built and tested on version 24) is needed only for `npm start` and the commands below, never by the app itself.
- `index.html` carries a Content-Security-Policy that only runs scripts from the app's own origin. If you add analytics or a tag manager, widen it there. If your server sends a `Permissions-Policy` header, it must allow `camera`, `xr-spatial-tracking` and `fullscreen` for the app's own origin.

## Project layout

```
index.html                page shell; links the CSS and loads js/app.js
js/config.js              the one file you edit: brand, measurement, pricing, lead, embed, text
skins/acme.js             example skin, used with ?skin=acme
js/app.js                 screen router, shared state, toasts, busy overlay, embed events
js/theme.js               loads the config and skin, applies the brand as CSS custom properties, sets the page language
js/strings.js, ui.js      shared wording and the text-override lookup; UI kit (DOM helpers, buttons, fields, icons)
js/demo.js                loads the bundled demo photo for the photo estimate or the paper method
js/photo.js               photo decoding, orientation, EXIF focal length and downscaling
js/camera.js              the live camera view: starting and stopping it, taking the photo
js/estimate.js            the no-paper estimate: the opening's shape from four corners, matched to your standard sizes
js/door-detect.js         finds the door outline in a photo; door-find.js runs it in door-detect-worker.js
js/ar-support.js          whether this phone and browser can do AR
js/ar-flow.js, xr-measure.js   the AR taps, and the sums that turn them into a size
js/vision.js              sheet detection, sub-pixel edge snapping, flattened preview
js/geometry.js            homographies and measureDoor(), the paper method's joint fit
js/editor.js              corner editor: drag, pinch-zoom, pan, magnifier, keyboard
js/quote.js               pricing engine, measurement rules, money and length formatting
js/lead.js                form validation, lead JSON, webhook / email link / demo delivery
js/screens/               one module per screen: welcome, prepare, capture, ar, sheet, door, result, quote, details, done
                          (result-standard.js and result-preview.js are parts of the result screen)
css/                      base.css (layout, design tokens, UI kit) and screens/*.css (per-screen styles)
assets/                   favicon, demo-door.png and its ground-truth JSON
tests/                    unit tests per module, plus an end-to-end test on rendered door scenes
tools/                    serve.mjs (dev server), simulate.mjs (accuracy), scene.mjs + make-demo.mjs (demo photo), camera.mjs (camera model)
```

```
npm test            # every suite, on Node's built-in test runner
npm run simulate    # the paper method's accuracy report quoted above; flags go after "--": --trials 500 --seed 7 --json --sheet-band 0.3 --noise-scale 2
npm run make-demo   # re-render assets/demo-door.png and its truth file
```

The tests are written against the configuration as shipped. The groups named "as shipped" in `tests/config.test.mjs` pin the demo content (the brand name, the three demo doors, demo mode and so on) and are expected to fail once you edit `js/config.js`: adjust or delete them. The "is a valid config" groups in the same file check rules every config must obey, and are the ones to keep green. Every other test of the measuring, pricing, lead and theme code runs on a fixed copy of the shipped settings (`tests/helpers/shipped-config.mjs`), so editing `js/config.js` does not fail them. One end-to-end group, "js/config.js as it stands", puts your own settings through the demo photo, your price list and your form, and checks only what any working config must give. The example skin is pinned in the same way as the shipped config: if you change or delete `skins/acme.js`, adjust the acme groups in `tests/config.test.mjs` and `tests/e2e.test.mjs` and the skin tests in `tests/theme.test.mjs`.

## Browser support and privacy

- Written for iOS Safari 15+ and Android Chrome 100+. It uses native ES modules with no polyfills, and newer CSS (colour tints, dynamic viewport height) has plain fallbacks. The corner editor also takes mouse, wheel and keyboard input on desktop: Enter or Space on the photo stands in for the tap that places the sheet corners, then Tab and the arrow keys move them, and Enter or Space confirms the selected corner where it is.
- **AR** needs Chrome on an Android phone with ARCore (Google Play Services for AR, which Chrome may ask to install the first time). No iPhone browser supports WebXR, so iPhones use the photo estimate or the paper method; so do Firefox for Android, which has WebXR turned off, and most in-app browsers. Samsung Internet's AR support has been patchy. The AR button is only shown when the browser reports it can start AR, and if it then fails to start, the customer is told and offered the photo instead (or the paper method, or typing a size they know, when the camera way in is switched off); for the rest of that visit the welcome screen offers AR second, under the main way in, rather than first.
- **The live camera view** works in iOS Safari 16+ and current Android Chrome on an HTTPS page. Where it is unavailable or blocked (the customer said no, an older phone, an in-app browser such as Facebook's or Instagram's, a plain `http` page), "Use your camera app instead" and "Choose a photo" do the same job. A photo taken in the live view can carry the lens's 35 mm-equivalent focal length when the browser takes a full photo (the Image Capture API, in Chrome and in iOS 18.4 and later) and the phone writes that value, which not every Android phone does; otherwise, and for a frame taken from the video, a typical 26 mm phone lens is assumed. iOS removes that information from photos taken through its camera app (Android's camera app keeps it), so on iPhone the live view is the better route for the estimate.
- The automated tests cover the maths, image processing, door detection, the AR sums, photo decoding (against simulated browser behaviour), pricing and lead logic under Node. The screens have no automated browser tests, so run every way in on a few real phones before you launch (see [What still needs testing](#what-still-needs-testing)).
- The camera view, the photo and the AR tracking stay on the phone: the photo is decoded, shrunk, searched for the door and measured in the browser. The app has no analytics, cookies, local storage, web fonts or third-party requests, and a reload starts a fresh session. One exception: if the phone closes the page while its camera app is open, the app reopens on the photo step it was on (with the sheet size the customer had chosen, in the paper method) and tells them to take the photo with the camera app first. That is kept on the browser's history entry while the camera app is open, not in storage.
- The only data that leaves the phone is the enquiry, when the customer taps "Send my enquiry": their form answers, the size and how it was measured, their choices and the quote. A reduced copy of the photo goes with it only if you set `lead.includePhoto: true`, only by webhook, and only when the size was measured from that photo. When the app is embedded with `parentOrigin` set, the same enquiry data is also posted to your host page.

## Roadmap ideas (not built)

- A stated AR tolerance, per phone if need be, once the field trial above has been run.
- Recess-depth compensation for doors set back inside the frame.
- Lens-distortion correction.
- More than one language at a time. Today a config or skin can reword the app through `text` in one language and declare that language with `brand.lang`. The loading line and the "needs JavaScript" notice in `index.html`, and the message shown if the app cannot start (`common.bootFailed` in `js/strings.js`), are not covered by `text` and are translated in those files.

Copyright: all rights reserved. Not open source.
