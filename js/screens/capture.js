/**
 * Capture screen (step 1 of the no-paper path, "Measure with my camera"): a live viewfinder with a
 * door-shaped guide and a shutter. One photo, then on to the door screen to check the corners.
 *
 * Why a live camera rather than the phone's camera app (research, scratchpad hybrid\results\camera.json):
 * on iPhone the camera app route hands the page a re-encoded JPEG with no EXIF, while takePhoto() here can
 * keep the focal length; and the on-screen guide tells the door detector where to look. The camera app and
 * the photo library stay on the screen as fallbacks, and become the main buttons whenever the live camera
 * cannot be used (blocked, missing, busy, an in-app browser).
 *
 * The camera is never left running behind the customer's back: it stops when they leave this screen, when
 * the page is hidden, before the camera app or the photo picker opens, and as soon as a photo is taken or
 * picked. It restarts when the page is shown again while this screen is still up. (The AR screen cannot
 * start its session while this one holds the camera.)
 */
import { loadPhoto, setPhoto } from '../photo.js';
import { findDoor } from '../door-find.js';
import { isKnownInAppBrowser } from '../ar-support.js';
import {
  cameraErrorKind,
  capturePhoto,
  embedBlocksCamera,
  guideRect,
  priorFromGuide,
  startCamera,
  stopCamera,
} from '../camera.js';

/** Screen id used for routing and for the `sm-screen--capture` class. */
export const id = 'capture';

/** Progress step this screen belongs to. */
export const step = 1;

/** Default copy for this screen; any key can be overridden through `config.text`. */
export const strings = {
  'capture.title': 'Take a photo of your door',
  'capture.hint': 'Fit the whole door opening inside the frame',
  'capture.upright': 'Turn your phone upright to fit the whole door in',
  'capture.hint.paused': 'The camera is paused',
  'capture.capturing': 'Hold still…',
  'capture.tips': 'Stand 2-3 big steps back, face the door straight on, phone upright',
  'capture.shutter': 'Take photo',
  'capture.allow': 'Allow camera',
  'capture.starting.title': 'Allow the camera',
  'capture.starting.text':
    'When your phone asks, tap Allow so you can see your door here. Your photo stays on your phone unless you send us an enquiry.',
  'capture.starting.inapp':
    "If the camera doesn't appear, use your camera app below, or open this page in Safari or Chrome.",
  'capture.starting.slow': "If your phone hasn't asked, tap Allow camera to ask again, or use your camera app below.",
  'capture.ready': 'Camera ready. Fit the whole door opening inside the frame, then tap Take photo.',
  'capture.paused.title': 'Camera paused',
  'capture.paused.text': 'Tap Allow camera to see your door here.',
  'capture.ended.text': 'The camera stopped. Tap Allow camera to start it again.',
  'capture.blocked.title': 'The camera is turned off for this page',
  'capture.blocked.text': 'You can still take the photo with your camera app, using the button below.',
  'capture.blocked.help.ios':
    'To turn it back on, tap the aA or page menu button in the address bar, choose Website Settings and set Camera to Allow. Then tap Allow camera.',
  // Chrome, Firefox, Edge or Opera on an iPhone or iPad ({browser} is its name): no aA button or Website
  // Settings there. The app itself needs the camera (iOS Settings), and the refusal is remembered until the
  // page is loaded again.
  'capture.blocked.help.iosbrowser':
    'To turn it back on, check Camera is on for {browser} in your Settings app, then reload this page and tap Allow when you are asked.',
  'capture.blocked.help.android':
    'To turn it back on, tap the icon to the left of the web address, choose Permissions and turn on Camera. Then tap Allow camera.',
  'capture.blocked.help.other':
    "To turn it back on, allow the camera for this page in your browser's settings. Then tap Allow camera.",
  'capture.busy.title': 'The camera is busy',
  'capture.busy.text':
    'Another app may be using it, such as a call or the Camera app. Close that app, then tap Allow camera.',
  'capture.failed.title': "The camera didn't start",
  'capture.failed.text': 'Tap Allow camera to try again, or use your camera app below.',
  'capture.unavailable.title': "We can't use the camera here",
  'capture.unavailable.inapp':
    "This app's built-in browser may not let us use the camera. Use your camera app below, or open this page in Safari or Chrome.",
  'capture.unavailable.insecure': 'The camera only works on a secure (https) page. Use your camera app below instead.',
  'capture.unavailable.nocamera': "We couldn't find a camera. Choose a photo below, or open this page on your phone.",
  'capture.unavailable.unsupported': "This browser can't show the camera here. Use your camera app below instead.",
  'capture.unavailable.embedded': "The camera can't open inside this page. Use your camera app below.",
  'capture.fallback.camera': 'Use your camera app instead',
  'capture.fallback.choose': 'Choose a photo',
  'capture.finding': 'Finding your door…',
  'capture.error.capture': "We couldn't take the photo. Please try again, or use your camera app.",
  'capture.error.decode': "We couldn't open that photo. Please use a JPEG or PNG photo.",
  'capture.error.other': 'Sorry, something went wrong with that photo. Please try again.',
};

/**
 * After the page comes back into view (or a picker closes without a photo), wait this long before opening
 * the camera again. When the customer returns from the camera app WITH a photo, the picker's 'change'
 * follows the page's 'visibilitychange' once the browser has copied the file in, which can take a moment
 * for a large photo; waiting saves opening the camera (and on iPhone perhaps asking again) only to close
 * it straight away.
 */
const RESUME_DELAY_MS = 1000;
/**
 * How long 'starting' waits on the browser before Allow camera works again. Until then a tap must not ask
 * twice, as the prompt is most likely up. But a prompt the page can be used around (Firefox for Android's,
 * on the address bar) can be left unanswered, and an app's built-in browser may never answer at all; the
 * request then never settles, and without this the button would spin for ever.
 */
const START_PATIENCE_MS = 8000;
const ERROR_TOAST_MS = 6000;
/** The kit's button variants and sizes (js/ui.js), for restyling a button in place. */
const BUTTON_VARIANTS = ['primary', 'secondary', 'ghost', 'danger'];
const BUTTON_SIZES = ['sm', 'md', 'lg'];
/** getUserMedia failures that mean "no camera at all" rather than "no camera API". */
const NO_CAMERA_ERRORS = new Set(['NotFoundError', 'DevicesNotFoundError', 'OverconstrainedError', 'ConstraintNotSatisfiedError']);
/**
 * 'unavailable' reasons where Allow camera cannot help, so it is not offered: the browser has no camera
 * API at all (and asking again fails the same way at once, with nothing to see or hear), the page is not
 * https, or the site that embeds this page does not let it have the camera. 'inapp-unsupported' is an
 * app's built-in browser with no camera API (an iOS WKWebView or Android WebView that exposes no
 * getUserMedia): it gets the in-app words, as Safari or Chrome is the way on there.
 */
const NO_RETRY_REASONS = new Set(['insecure', 'unsupported', 'embedded', 'inapp-unsupported']);
/**
 * The other iPhone and iPad browsers, by the token each puts in its user agent, with the name the
 * re-enable steps call it by. All are WebKit underneath, but none has Safari's aA menu or Website
 * Settings, so Safari's steps would send their customers looking for buttons that are not there.
 */
const IOS_BROWSERS = [
  [/\bCriOS\//, 'Chrome'],
  [/\bFxiOS\//, 'Firefox'],
  [/\bEdgiOS\//, 'Edge'],
  [/\b(?:OPiOS|OPT)\//, 'Opera'],
];

/**
 * The capture screen can always be entered.
 * @returns {boolean}
 */
export function canEnter() {
  return true;
}

/**
 * Build the capture screen.
 *
 * Phases:
 *  - 'starting'     getUserMedia is out (the permission prompt may be up); after START_PATIENCE_MS
 *                   without an answer, Allow camera asks again
 *  - 'paused'       no live picture: the page was hidden, the stream ended, or iOS wants a tap to play
 *  - 'live'         the viewfinder is running (the shutter waits for the video to have a size)
 *  - 'capturing'    taking the still
 *  - 'blocked'      permission refused
 *  - 'busy'         the camera would not start (another app has it)
 *  - 'unavailable'  no camera / no camera API / not https / an in-app browser that would not give it
 *  - 'failed'       anything else
 * The last four make the camera-app and library buttons the main way on.
 *
 * @param {HTMLElement} root  the empty <section> for this screen
 * @param {object} ctx        app context (config, state, t, go, busy, toast, ui)
 * @returns {() => void} cleanup
 */
export function mount(root, ctx) {
  const { ui, config } = ctx;
  const { h } = ui;
  const t = (key, vars) => ctx.t(key, vars);
  const nav = globalThis.navigator;
  const inApp = isKnownInAppBrowser();
  const { platform, browser } = platformOf(nav);

  let alive = true;
  /** A photo is being taken or loaded: no second photo, and the camera stays closed. */
  let processing = false;
  /** { stream, track } while this screen holds the camera. */
  let camera = null;
  /**
   * A getUserMedia of the current epoch is out: no second one beside it. One that is out of date no
   * longer counts (releaseCamera drops it), as it may never settle; startCamera's signal keeps its stream,
   * should one still come, off the video.
   */
  let startPending = false;
  /** Aborts the getUserMedia that is out, for startCamera (see releaseCamera). */
  let startAbort = null;
  /** The getUserMedia that is out has had START_PATIENCE_MS: Allow camera may ask again. */
  let startOverdue = false;
  let patienceTimer = 0;
  /** Bumped whenever the camera is released; a start that began before then is out of date. */
  let epoch = 0;
  /** Whether the camera should be running while the page is visible (false after a failure). */
  let wantCamera = true;
  let phase = 'starting';
  /** Detail for the 'paused' and 'unavailable' messages. */
  let reason = null;
  /** iOS mutes the track during interruptions (a call, Control Centre): no new frames until it unmutes. */
  let muted = false;
  /** The guide as last laid out, in view (stage) px. */
  let guide = null;
  let resumeTimer = 0;
  let unwatchTrack = () => {};
  const cleanups = [];

  root.classList.add('sm-screen--flush', 'sm-capture');

  // ---- Viewfinder ------------------------------------------------------------------------------

  const heading = h('h1', { class: 'sm-visually-hidden', text: t('capture.title'), attrs: { tabindex: '-1' } });

  // muted + playsinline in the markup as well as the properties: iOS refuses to play, or goes full screen,
  // without them. The picture is for sighted customers; everything it says is also in text.
  const video = h('video', {
    class: 'sm-capture__video',
    muted: true,
    playsInline: true,
    autoplay: true,
    attrs: { muted: '', playsinline: '', autoplay: '', disablepictureinpicture: '', 'aria-hidden': 'true' },
  });
  const guideEl = h('div', { class: 'sm-capture__guide', hidden: true, attrs: { 'aria-hidden': 'true' } });
  // Focusable from script only: focus lands here when the card is put away and the shutter cannot take it yet.
  const hint = h('p', { class: 'sm-capture__hint', hidden: true, attrs: { 'aria-live': 'polite', tabindex: '-1' } });
  // Says so when the camera is ready to take the photo. The hint cannot: it is hidden until then, and a
  // live region that is shown already holding its text is not reliably read out. This one is never hidden,
  // only emptied while the camera is not live, so each time the camera comes back it is a change.
  const readyStatus = h('p', {
    class: 'sm-capture__status sm-visually-hidden',
    attrs: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
  });

  const panelIcon = h('span', { class: 'sm-capture__panel-icon' });
  const panelTitle = h('h2', { class: 'sm-capture__panel-title' });
  const panelText = h('p', { class: 'sm-capture__panel-text' });
  const panelHelp = h('p', { class: 'sm-capture__panel-help' });
  const allowButton = ui.button(t('capture.allow'), { variant: 'primary', size: 'lg', icon: 'camera', onClick: onAllow });
  const panel = h(
    'div',
    { class: 'sm-capture__panel' },
    h(
      'div',
      { class: 'sm-capture__card' },
      panelIcon,
      h('div', { class: 'sm-capture__message', attrs: { 'aria-live': 'polite' } }, panelTitle, panelText, panelHelp),
      allowButton,
    ),
  );

  const stage = h('div', { class: 'sm-capture__stage' }, video, guideEl, hint, readyStatus, panel);

  // ---- Shutter and fallbacks -------------------------------------------------------------------

  const tips = h('p', { class: 'sm-capture__tips', text: t('capture.tips') });
  const shutter = h(
    'button',
    {
      class: 'sm-capture__shutter',
      type: 'button',
      disabled: true,
      attrs: { 'aria-label': t('capture.shutter'), title: t('capture.shutter') },
      on: { click: onShutter },
    },
    h('span', { class: 'sm-capture__shutter-face' }, ui.icon('camera', 28)),
  );
  const shutterRow = h('div', { class: 'sm-capture__shutter-row' }, shutter);

  const cameraAppButton = ui.fileButton(t('capture.fallback.camera'), {
    variant: 'secondary',
    size: 'sm',
    icon: 'camera',
    accept: 'image/*',
    capture: 'environment',
    onFile,
  });
  const chooseButton = ui.fileButton(t('capture.fallback.choose'), {
    variant: 'ghost',
    size: 'sm',
    icon: 'image',
    accept: 'image/*',
    onFile,
  });
  const fallbacks = h('div', { class: 'sm-capture__fallbacks' }, cameraAppButton, chooseButton);

  const bar = ui.actionBar(tips, shutterRow, fallbacks);
  bar.classList.add('sm-capture__bar');
  root.append(heading, stage, bar);

  // ---- Rendering -------------------------------------------------------------------------------

  const hasFrame = () => video.videoWidth > 0 && video.videoHeight > 0;

  function setPhase(next, detail = null) {
    phase = next;
    reason = detail;
    render();
  }

  function render() {
    const focusInPanel = holdsFocus(panel);
    const live = phase === 'live' || phase === 'capturing';
    const unusable = phase === 'blocked' || phase === 'busy' || phase === 'unavailable' || phase === 'failed';

    stage.classList.toggle('sm-capture__stage--live', live);
    guideEl.hidden = !live;
    hint.hidden = !live;
    panel.hidden = live;
    shutterRow.hidden = unusable;

    let hintText = t('capture.hint');
    if (phase === 'capturing') hintText = t('capture.capturing');
    else if (muted) hintText = t('capture.hint.paused');
    else if (isPhoneOnItsSide()) hintText = t('capture.upright');
    setText(hint, hintText);

    shutter.disabled = phase !== 'live' || processing || muted || !hasFrame();
    if (phase === 'capturing') shutter.setAttribute('aria-busy', 'true');
    else shutter.removeAttribute('aria-busy');
    // Set once the shutter works, and kept through a mute or a photo being taken (the hint speaks then).
    if (!live) setText(readyStatus, '');
    else if (!shutter.disabled) setText(readyStatus, t('capture.ready'));

    // The fallbacks take over whenever the live camera is no use.
    restyle(cameraAppButton, unusable ? 'primary' : 'secondary', unusable ? 'lg' : 'sm');
    restyle(chooseButton, unusable ? 'secondary' : 'ghost', unusable ? 'md' : 'sm');
    fallbacks.classList.toggle('sm-capture__fallbacks--main', unusable);

    if (!live) renderPanel(unusable);
    if (focusInPanel) keepFocus();
  }

  /** Whether keyboard or screen-reader focus is on something inside `el`. */
  function holdsFocus(el) {
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    return Boolean(active) && active !== el && el.contains(active);
  }

  /**
   * Focus was in the message card and render() may just have hidden what held it: the whole card once
   * the camera is live, or the Allow camera button where trying again cannot help. Move it on to what
   * comes next rather than let it drop to the top of the page (VoiceOver would start over from there).
   */
  function keepFocus() {
    let target = null;
    if (panel.hidden) target = shutter.disabled ? hint : shutter;
    else if (allowButton.hidden) target = cameraAppButton.input;
    if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
  }

  function renderPanel(unusable) {
    let iconName = 'alert';
    let title = '';
    let text = '';
    let help = '';
    let allow = true;
    switch (phase) {
      case 'starting':
        iconName = 'camera';
        title = t('capture.starting.title');
        text = t('capture.starting.text');
        if (inApp) help = t('capture.starting.inapp');
        else if (startOverdue) help = t('capture.starting.slow');
        break;
      case 'paused':
        iconName = 'camera';
        title = t('capture.paused.title');
        text = t(reason === 'ended' ? 'capture.ended.text' : 'capture.paused.text');
        break;
      case 'blocked':
        iconName = 'lock';
        title = t('capture.blocked.title');
        text = t('capture.blocked.text');
        help = t(`capture.blocked.help.${platform}`, { browser });
        break;
      case 'busy':
        title = t('capture.busy.title');
        text = t('capture.busy.text');
        break;
      case 'unavailable':
        title = t('capture.unavailable.title');
        text = t(`capture.unavailable.${reason === 'inapp-unsupported' ? 'inapp' : reason || 'unsupported'}`);
        allow = !NO_RETRY_REASONS.has(reason);
        break;
      default:
        title = t('capture.failed.title');
        text = t('capture.failed.text');
    }
    panelIcon.replaceChildren(ui.icon(iconName, 26));
    panelIcon.classList.toggle('sm-capture__panel-icon--alert', unusable);
    // render() runs on every resize and video event: rewriting the same words would have them read out again.
    setText(panelTitle, title);
    setText(panelText, text);
    setText(panelHelp, help);
    panelHelp.hidden = help === '';

    allowButton.hidden = !allow;
    // After a failure, "Allow camera" is the second choice: the camera app is the sure way on.
    restyle(allowButton, unusable ? 'secondary' : 'primary', unusable ? 'md' : 'lg');
    const waiting = phase === 'starting' && !startOverdue;
    allowButton.setLoading(waiting);
    allowButton.setAttribute('aria-disabled', waiting ? 'true' : 'false');
  }

  /** A phone held sideways shows the door small; desktops with a wide webcam view are left alone. */
  function isPhoneOnItsSide() {
    if (typeof matchMedia !== 'function') return false;
    try {
      return matchMedia('(orientation: landscape) and (pointer: coarse)').matches;
    } catch {
      return false;
    }
  }

  function layout() {
    if (!alive) return;
    guide = guideRect(stage.clientWidth, stage.clientHeight);
    if (guide) {
      guideEl.style.left = `${guide.x}px`;
      guideEl.style.top = `${guide.y}px`;
      guideEl.style.width = `${guide.width}px`;
      guideEl.style.height = `${guide.height}px`;
    }
    render();
  }

  // ---- Camera lifecycle ------------------------------------------------------------------------

  function start() {
    if (!alive || processing || camera || startPending) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    clearTimeout(resumeTimer);
    resumeTimer = 0;
    wantCamera = true;
    startPending = true;
    startOverdue = false;
    const startedIn = epoch;
    const request = typeof AbortController === 'function' ? new AbortController() : null;
    startAbort = request;
    clearTimeout(patienceTimer);
    patienceTimer = setTimeout(() => {
      patienceTimer = 0;
      if (!alive || startedIn !== epoch || !startPending) return;
      startOverdue = true;
      render();
    }, START_PATIENCE_MS);
    setPhase('starting');
    // startCamera calls getUserMedia before it awaits anything, so a tap that got us here still counts
    // as the gesture behind the permission prompt.
    startCamera(video, request ? { signal: request.signal } : undefined).then(
      (result) => {
        // Only the request of the current epoch is the one start() waits on; a newer one may be out.
        if (startedIn === epoch) endStartWait();
        if (startedIn !== epoch || !alive || processing) {
          discard(result);
          resumeLater();
          return;
        }
        camera = result;
        watchTrack(result.track);
        if (result.playing) evaluate();
        else setPhase('paused', 'tap');
      },
      (error) => {
        if (startedIn === epoch) endStartWait();
        if (startedIn !== epoch || !alive || processing) {
          resumeLater();
          return;
        }
        fail(error);
      },
    );
  }

  /** Stop a stream that arrived after the screen stopped wanting it. */
  function discard(result) {
    if (!result) return;
    stopCamera(result.stream);
    if (video.srcObject === result.stream) video.srcObject = null;
  }

  /** The getUserMedia start() waits on has settled, or is out of date: it no longer holds up the next. */
  function endStartWait() {
    startPending = false;
    startOverdue = false;
    startAbort = null;
    clearTimeout(patienceTimer);
    patienceTimer = 0;
  }

  /**
   * Let go of the camera now: stop every track and empty the viewfinder. A getUserMedia still out is out
   * of date from here and is dropped: it must not hold up the next start, since a prompt left unanswered
   * may keep it out for ever, and should it still bring a stream, startCamera stops that at once.
   */
  function releaseCamera() {
    epoch += 1;
    if (startAbort) startAbort.abort();
    endStartWait();
    const held = camera;
    camera = null;
    muted = false;
    unwatchTrack();
    unwatchTrack = () => {};
    if (held) stopCamera(held.stream);
    try {
      video.pause();
    } catch {
      // Nothing was playing.
    }
    video.srcObject = null;
  }

  /** Pause the camera for something that needs it (the camera app, a photo picker) or a hidden page; resume later. */
  function pauseCamera() {
    if (!camera && !startPending) return;
    releaseCamera();
    if (!processing) setPhase('paused', 'tap');
  }

  function fail(error) {
    wantCamera = false;
    // Every way this ends (unavailable, blocked, busy, failed) means the camera here did not work this time:
    // the result screen then tells a customer with a picked photo how to retake it with the camera app.
    // ('starting' and 'paused' say nothing about it either way, so they leave it alone.)
    ctx.state.liveCamera = false;
    const kind = cameraErrorKind(error);
    const name = error && typeof error.name === 'string' ? error.name : '';
    // No camera API here (startCamera's NotSupportedError when there is no getUserMedia, or the like),
    // rather than no camera: asking again fails the same way at once.
    const noApi = kind === 'unavailable' && !NO_CAMERA_ERRORS.has(name);
    if (kind === 'insecure') setPhase('unavailable', 'insecure');
    // An iframe without allow="camera": neither site settings nor another browser can change that.
    else if (kind === 'blocked' && embedBlocksCamera()) setPhase('unavailable', 'embedded');
    // Site-settings help means nothing inside another app's browser: there the way on is Safari or Chrome.
    // Where that browser has no camera API at all, Allow camera goes as well (see NO_RETRY_REASONS).
    else if (inApp && kind !== 'busy') setPhase('unavailable', noApi ? 'inapp-unsupported' : 'inapp');
    else if (kind === 'blocked') setPhase('blocked');
    else if (kind === 'unavailable') setPhase('unavailable', noApi ? 'unsupported' : 'nocamera');
    else if (kind === 'busy') setPhase('busy');
    else setPhase('failed');
  }

  /** Live once the stream is playing; the shutter also waits for the video to have a size. */
  function evaluate() {
    if (!alive || processing || !camera) return;
    if (video.paused) {
      if (phase !== 'paused') setPhase('paused', 'tap');
      return;
    }
    // The live camera works on this phone: the result screen may send the customer back here to retake a
    // picked photo (estimateIssueKeys in js/screens/result-standard.js).
    ctx.state.liveCamera = true;
    setPhase('live');
  }

  function watchTrack(track) {
    if (!track || typeof track.addEventListener !== 'function') return;
    const onEnded = () => {
      // Another app or a call took the camera.
      if (!camera || camera.track !== track || processing) return;
      releaseCamera();
      setPhase('paused', 'ended');
    };
    const onMute = () => {
      muted = true;
      render();
    };
    const onUnmute = () => {
      muted = false;
      render();
    };
    track.addEventListener('ended', onEnded);
    track.addEventListener('mute', onMute);
    track.addEventListener('unmute', onUnmute);
    unwatchTrack = () => {
      track.removeEventListener('ended', onEnded);
      track.removeEventListener('mute', onMute);
      track.removeEventListener('unmute', onUnmute);
    };
  }

  /** Open the camera again shortly, if this screen still wants it and the page is in view. */
  function resumeLater() {
    clearTimeout(resumeTimer);
    resumeTimer = 0;
    if (!alive) return;
    resumeTimer = setTimeout(() => {
      resumeTimer = 0;
      if (wantCamera && !camera && !startPending && !processing) start();
    }, RESUME_DELAY_MS);
  }

  function onAllow() {
    if (processing) return;
    if (startPending) {
      // Still waiting on the browser: most likely its prompt is up, so a tap must not ask twice. Once it
      // has had START_PATIENCE_MS, drop that request and ask again.
      if (!startOverdue) return;
      releaseCamera();
    }
    if (camera) {
      // The stream is open and only playback is waiting for a tap (iOS): play() inside this tap.
      let attempt;
      try {
        attempt = video.play();
      } catch (error) {
        attempt = Promise.reject(error);
      }
      Promise.resolve(attempt).then(
        () => evaluate(),
        () => {
          if (alive && camera) setPhase('paused', 'tap');
        },
      );
      return;
    }
    start();
  }

  // ---- Taking or picking the photo -------------------------------------------------------------

  /** What was on screen at the shutter press, for mapping the guide into the photo afterwards. */
  function viewSnapshot() {
    const viewW = stage.clientWidth;
    const viewH = stage.clientHeight;
    return { guide: guide || guideRect(viewW, viewH), viewW, viewH, videoW: video.videoWidth, videoH: video.videoHeight };
  }

  async function onShutter() {
    if (phase !== 'live' || processing || !camera || muted || !hasFrame()) return;
    const view = viewSnapshot();
    processing = true;
    setPhase('capturing');
    let shot = null;
    try {
      shot = await capturePhoto({ track: camera.track, video });
    } catch {
      shot = null;
    }
    if (!alive) return;
    if (!shot) {
      processing = false;
      ctx.toast(t('capture.error.capture'), { type: 'error', duration: ERROR_TOAST_MS });
      if (camera) evaluate();
      else start();
      return;
    }
    await usePhoto(shot.blob, shot.capture, view);
  }

  /** @param {File} file */
  function onFile(file) {
    if (!file || processing || !alive) return;
    usePhoto(file, 'file', null);
  }

  /**
   * Stop the camera, then in one busy overlay: decode the photo, make it the session's photo, and look
   * for the door in it (with the guide as a prior for a photo taken here). Then on to the door screen.
   *
   * @param {Blob} source
   * @param {'live' | 'frame' | 'file'} capture
   * @param {ReturnType<typeof viewSnapshot> | null} view  null for a picked file: it was never framed by the guide
   */
  async function usePhoto(source, capture, view) {
    processing = true;
    clearTimeout(resumeTimer);
    resumeTimer = 0;
    releaseCamera();
    render();

    const state = ctx.state;
    let outcome;
    try {
      outcome = await ctx.busy(async () => {
        let photo;
        try {
          photo = await loadPhoto(source, config, { capture });
        } catch {
          return 'decode';
        }
        if (!alive) {
          releasePhoto(photo);
          return 'gone';
        }
        setPhoto(state, photo);
        state.method = 'estimate';
        const prior = view ? priorFromGuide({ ...view, photoW: photo.width, photoH: photo.height }) : null;
        // Kept with the photo (setPhoto has just cleared the last one's): if this search runs out of time,
        // the door screen looks again in the background near the same guide.
        if (prior) state.door.prior = prior.map((p) => ({ x: p.x, y: p.y }));
        const detection = await detectDoor(photo, prior);
        // The customer may have left while detection ran and started on another photo.
        if (state.photo === photo) state.door.detection = detection;
        return 'ok';
      }, t('capture.finding'));
    } catch {
      outcome = 'error';
    }

    processing = false;
    if (!alive || outcome === 'gone') return;
    if (outcome === 'ok') {
      ctx.go('door');
      return;
    }
    ctx.toast(t(outcome === 'decode' ? 'capture.error.decode' : 'capture.error.other'), {
      type: 'error',
      duration: ERROR_TOAST_MS,
    });
    // Back to the viewfinder for another go (unless it had already failed: then the fallbacks stay up).
    if (wantCamera) start();
    else render();
  }

  // ---- Page visibility and pickers -------------------------------------------------------------

  const onVisibility = () => {
    if (document.visibilityState === 'hidden') pauseCamera();
    else if (wantCamera) resumeLater();
  };
  const onPageHide = () => pauseCamera();
  const onPageShow = () => {
    if (wantCamera) resumeLater();
  };
  // The camera app needs the camera itself (Android will not share it), and the page may never be
  // hidden while it is up (iOS shows it over the page), so let go of ours first. The same goes for
  // "Choose a photo": iOS offers Take Photo beside the library, and Chrome on Android its camera, and
  // while the customer browses their photos the camera light would stay on for nothing.
  const onPickerTap = (event) => {
    if (processing) {
      event.preventDefault();
      return;
    }
    pauseCamera();
  };
  // A picker closed without a photo (or the page got focus back): carry on with the live camera.
  const onPickerDone = () => {
    if (wantCamera && !processing) resumeLater();
  };

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
    cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility));
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('focus', onPickerDone);
    window.addEventListener('resize', layout);
    cleanups.push(() => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('focus', onPickerDone);
      window.removeEventListener('resize', layout);
    });
  }
  for (const button of [cameraAppButton, chooseButton]) {
    button.addEventListener('click', onPickerTap, true);
    button.input.addEventListener('cancel', onPickerDone);
  }

  // The video reports its size (and a new one when the phone turns) only after it has started.
  const onVideoEvent = () => (camera ? evaluate() : undefined);
  const onVideoResize = () => render();
  for (const type of ['playing', 'pause']) video.addEventListener(type, onVideoEvent);
  for (const type of ['loadedmetadata', 'resize']) video.addEventListener(type, onVideoResize);

  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(() => layout());
    observer.observe(stage);
    cleanups.push(() => observer.disconnect());
  }

  layout();
  // Straight away, inside the tap that brought the customer here, so the permission prompt follows it.
  start();

  return () => {
    alive = false;
    clearTimeout(resumeTimer);
    releaseCamera(); // also clears the patience timer
    for (const cleanup of cleanups) cleanup();
    root.classList.remove('sm-screen--flush', 'sm-capture');
  };
}

/**
 * Look for the door, guided by the prior when there is one. The guide is only a hint: when a customer
 * framed the door loosely and no outline lies near it, findDoor searches the whole photo by itself.
 *
 * @param {object} photo
 * @param {Array<{ x: number, y: number }> | null} prior
 * @returns {Promise<object | null>} findDoor's result, or null if it misbehaved (the door screen then runs it)
 */
async function detectDoor(photo, prior) {
  try {
    return (await findDoor(photo, { prior })) || null;
  } catch {
    // findDoor promises never to reject; this only guards against a broken build of it.
    return null;
  }
}

/**
 * Hand back a decoded photo's working canvas when the photo is not going to be used (iOS counts every
 * live canvas against a hard memory budget).
 * @param {{ canvas?: HTMLCanvasElement }} photo
 */
function releasePhoto(photo) {
  if (photo && photo.canvas) {
    photo.canvas.width = 0;
    photo.canvas.height = 0;
  }
}

/**
 * Restyle a kit button (js/ui.js button / fileButton) in place, without rebuilding it: a file picker that is
 * open while the screen changes state must keep its input.
 * @param {HTMLElement} el
 * @param {string} variant
 * @param {string} size
 */
function restyle(el, variant, size) {
  for (const name of BUTTON_VARIANTS) el.classList.toggle(`sm-btn--${name}`, name === variant);
  for (const name of BUTTON_SIZES) el.classList.toggle(`sm-btn--${name}`, name === size);
}

/** Writes text only when it differs, so unchanged nodes are not re-announced by a live region. */
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

/**
 * Which re-enable steps to show: they differ between Safari, the other iPhone and iPad browsers, and
 * Android.
 * @param {Navigator | undefined} nav
 * @returns {{ platform: 'ios' | 'iosbrowser' | 'android' | 'other', browser: string }}
 *   browser: the name of an 'iosbrowser' (see IOS_BROWSERS), for its steps; '' otherwise
 */
function platformOf(nav) {
  const ua = nav && typeof nav.userAgent === 'string' ? nav.userAgent : '';
  // iPadOS reports itself as a Mac; a Mac with a touch screen is an iPad.
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && nav.maxTouchPoints > 1)) {
    const other = IOS_BROWSERS.find(([marker]) => marker.test(ua));
    return other ? { platform: 'iosbrowser', browser: other[1] } : { platform: 'ios', browser: '' };
  }
  if (/Android/.test(ua)) return { platform: 'android', browser: '' };
  return { platform: 'other', browser: '' };
}
