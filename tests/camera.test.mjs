// The live camera helpers in js/camera.js: the geometry that ties the on-screen guide to the captured
// photo (object-fit: cover, the guide's shape, frame-to-frame mapping), how camera errors are classified,
// the getUserMedia request, and taking the still (takePhoto first, a video frame when that fails or hangs).
// At the end, js/screens/capture.js on a just-enough fake DOM: what a refusal inside an iframe says, and
// where focus goes when the message card is put away.
// Browser globals (navigator, ImageCapture, document, isSecureContext) are stubbed per test and restored
// after each one, so nothing leaks from one test into the next.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  cameraConstraints,
  cameraErrorKind,
  capturePhoto,
  coverMapping,
  embedBlocksCamera,
  guideRect,
  mapRectToFrame,
  priorFromGuide,
  rectToQuad,
  startCamera,
  stopCamera,
  viewRectToSource,
} from '../js/camera.js';
import { mount as mountCaptureScreen, strings as captureStrings } from '../js/screens/capture.js';

// ---- Global stubs ------------------------------------------------------------------------------

const STUBBED = ['navigator', 'ImageCapture', 'document', 'isSecureContext', 'window', 'createImageBitmap'];
const ORIGINAL = new Map(STUBBED.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const saved = [];

/** Replace a global for the current test only (afterEach puts the original back). */
function setGlobal(name, value) {
  saved.push([name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true, enumerable: true });
}

/** Remove a global for the current test only. */
function removeGlobal(name) {
  saved.push([name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  delete globalThis[name];
}

afterEach(() => {
  while (saved.length) {
    const [name, descriptor] = saved.pop();
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
});

const close = (actual, expected, message, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} is not ${expected}`);

function assertRect(actual, expected, message, tolerance = 1e-9) {
  assert.ok(actual, `${message}: no rect`);
  for (const key of ['x', 'y', 'width', 'height']) close(actual[key], expected[key], `${message} ${key}`, tolerance);
}

// ---- coverMapping / viewRectToSource ------------------------------------------------------------

describe('coverMapping', () => {
  test('a portrait 4:3 video in a narrower viewfinder is scaled to the height and cropped at the sides', () => {
    const m = coverMapping(1440, 1920, 390, 600);
    close(m.scale, 600 / 1920, 'scale');
    close(m.offsetX, (390 - 1440 * (600 / 1920)) / 2, 'offsetX');
    assert.ok(m.offsetX < 0, 'the sides overhang the view');
    close(m.offsetY, 0, 'offsetY');
  });

  test('a landscape video in a square view is scaled to the height', () => {
    const m = coverMapping(1920, 1080, 400, 400);
    close(m.scale, 400 / 1080, 'scale');
    close(m.offsetY, 0, 'offsetY');
    close(m.offsetX, (400 - 1920 * (400 / 1080)) / 2, 'offsetX');
  });

  test('a video in a taller view is scaled to the height; a wider view to the width', () => {
    const tall = coverMapping(1920, 1440, 300, 600);
    close(tall.scale, 600 / 1440, 'tall scale');
    const wide = coverMapping(1440, 1920, 800, 300);
    close(wide.scale, 800 / 1440, 'wide scale');
    assert.ok(wide.offsetY < 0 && wide.offsetX === 0);
  });

  test('always fills the view, never more than needed, and keeps the centres together', () => {
    const cases = [
      [1440, 1920, 390, 600],
      [1920, 1080, 375, 520],
      [640, 480, 1200, 300],
      [1080, 1920, 320, 240],
      [1000, 1000, 1000, 1000],
    ];
    for (const [srcW, srcH, viewW, viewH] of cases) {
      const m = coverMapping(srcW, srcH, viewW, viewH);
      const drawnW = srcW * m.scale;
      const drawnH = srcH * m.scale;
      assert.ok(drawnW >= viewW - 1e-9 && drawnH >= viewH - 1e-9, `${srcW}x${srcH} in ${viewW}x${viewH} covers the view`);
      assert.ok(Math.abs(drawnW - viewW) < 1e-9 || Math.abs(drawnH - viewH) < 1e-9, 'one axis fits exactly');
      close(srcW / 2 * m.scale + m.offsetX, viewW / 2, 'centre x');
      close(srcH / 2 * m.scale + m.offsetY, viewH / 2, 'centre y');
    }
  });

  test('same shape: no crop at all', () => {
    const m = coverMapping(1920, 1440, 480, 360);
    close(m.scale, 0.25, 'scale');
    close(m.offsetX, 0, 'offsetX');
    close(m.offsetY, 0, 'offsetY');
  });

  test('a size that is missing, zero, negative or not a number gives null', () => {
    assert.equal(coverMapping(0, 1920, 390, 600), null);
    assert.equal(coverMapping(1440, 1920, 390, 0), null);
    assert.equal(coverMapping(-1440, 1920, 390, 600), null);
    assert.equal(coverMapping(NaN, 1920, 390, 600), null);
    assert.equal(coverMapping(1440, Infinity, 390, 600), null);
    assert.equal(coverMapping(), null);
    assert.equal(coverMapping('1440', 1920, 390, 600), null);
  });
});

describe('viewRectToSource', () => {
  test('the whole view maps to the part of the video that is visible', () => {
    const m = coverMapping(1440, 1920, 390, 600);
    const visible = viewRectToSource({ x: 0, y: 0, width: 390, height: 600 }, m);
    const cropX = (1440 - 390 / m.scale) / 2;
    assertRect(visible, { x: cropX, y: 0, width: 1440 - 2 * cropX, height: 1920 }, 'visible part');
  });

  test('undoes the drawing: a source rect drawn into the view comes back unchanged', () => {
    const m = coverMapping(1920, 1080, 375, 520);
    const source = { x: 700, y: 120, width: 300, height: 800 };
    const inView = {
      x: source.x * m.scale + m.offsetX,
      y: source.y * m.scale + m.offsetY,
      width: source.width * m.scale,
      height: source.height * m.scale,
    };
    assertRect(viewRectToSource(inView, m), source, 'round trip', 1e-6);
  });

  test('null for an unusable rect or mapping', () => {
    const m = coverMapping(1440, 1920, 390, 600);
    assert.equal(viewRectToSource(null, m), null);
    assert.equal(viewRectToSource({ x: 0, y: 0, width: 10 }, m), null);
    assert.equal(viewRectToSource({ x: 0, y: NaN, width: 10, height: 10 }, m), null);
    assert.equal(viewRectToSource({ x: 0, y: 0, width: -1, height: 10 }, m), null);
    assert.equal(viewRectToSource({ x: 0, y: 0, width: 10, height: 10 }, null), null);
    assert.equal(viewRectToSource({ x: 0, y: 0, width: 10, height: 10 }, { scale: 0, offsetX: 0, offsetY: 0 }), null);
  });
});

// ---- guideRect ---------------------------------------------------------------------------------

describe('guideRect', () => {
  const VIEWS = [
    [390, 600],
    [320, 300],
    [375, 520],
    [430, 760],
    [800, 300],
    [100, 1000],
    [600, 600],
  ];

  test('a door shape inside the view, centred across, on every viewfinder size', () => {
    for (const [w, h] of VIEWS) {
      const g = guideRect(w, h);
      const label = `${w}x${h}`;
      assert.ok(g.x >= 0 && g.y >= 0 && g.x + g.width <= w + 1e-9 && g.y + g.height <= h + 1e-9, `${label} inside the view`);
      close(g.height / g.width, 2.4, `${label} door shape`, 1e-9);
      close(g.x + g.width / 2, w / 2, `${label} centred across`);
      assert.ok(g.width <= w * 0.8 + 1e-9, `${label} not wider than 80 % of the view`);
    }
  });

  test('a phone viewfinder: about three quarters of the height, centred down', () => {
    const g = guideRect(390, 600);
    close(g.height, 0.76 * 600, 'height');
    close(g.y + g.height / 2, 300, 'centred down');
  });

  test('a short view keeps the top clear for the hint', () => {
    const g = guideRect(390, 330);
    assert.ok(g.y >= 64 - 1e-9, `top ${g.y} below the hint`);
    assert.ok(g.y + g.height <= 330, 'still inside the view');
    assert.ok(g.height >= 0.7 * 330, 'still most of the height');
  });

  test('a narrow view is limited by its width', () => {
    const g = guideRect(100, 1000);
    close(g.width, 80, 'width');
    close(g.height, 192, 'height');
  });

  test('null before the view has a size', () => {
    assert.equal(guideRect(0, 600), null);
    assert.equal(guideRect(390, 0), null);
    assert.equal(guideRect(NaN, 600), null);
    assert.equal(guideRect(), null);
  });
});

// ---- mapRectToFrame / priorFromGuide ------------------------------------------------------------

describe('mapRectToFrame', () => {
  test('pictures of the same shape simply scale', () => {
    const r = mapRectToFrame({ x: 144, y: 192, width: 720, height: 960 }, 1440, 1920, 3024, 4032);
    assertRect(r, { x: 302.4, y: 403.2, width: 1512, height: 2016 }, 'scaled', 1e-6);
  });

  test('a 16:9 video is the middle band of a 4:3 photo (landscape)', () => {
    const r = mapRectToFrame({ x: 0, y: 0, width: 1920, height: 1080 }, 1920, 1080, 4032, 3024);
    assertRect(r, { x: 0, y: (3024 - 2268) / 2, width: 4032, height: 2268 }, 'band', 1e-6);
  });

  test('a 9:16 video is the middle column of a 3:4 photo (portrait)', () => {
    const r = mapRectToFrame({ x: 0, y: 0, width: 1080, height: 1920 }, 1080, 1920, 3024, 4032);
    assertRect(r, { x: (3024 - 2268) / 2, y: 0, width: 2268, height: 4032 }, 'column', 1e-6);
  });

  test('a 4:3 video overhangs a 16:9 photo, which is the cropped one', () => {
    const r = mapRectToFrame({ x: 0, y: 0, width: 1920, height: 1440 }, 1920, 1440, 1920, 1080);
    assertRect(r, { x: 0, y: (1080 - 1440) / 2, width: 1920, height: 1440 }, 'overhang', 1e-6);
  });

  test('a portrait video and a landscape photo do not line up: null', () => {
    assert.equal(mapRectToFrame({ x: 0, y: 0, width: 10, height: 10 }, 1440, 1920, 4032, 3024), null);
    assert.equal(mapRectToFrame({ x: 0, y: 0, width: 10, height: 10 }, 1920, 1440, 3024, 4032), null);
  });

  test('a square picture lines up with either orientation', () => {
    assert.ok(mapRectToFrame({ x: 0, y: 0, width: 10, height: 10 }, 1000, 1000, 3024, 4032));
    assert.ok(mapRectToFrame({ x: 0, y: 0, width: 10, height: 10 }, 1440, 1920, 1000, 1000));
  });

  test('null for unusable input', () => {
    assert.equal(mapRectToFrame(null, 1440, 1920, 3024, 4032), null);
    assert.equal(mapRectToFrame({ x: 0, y: 0, width: 10, height: 10 }, 0, 1920, 3024, 4032), null);
    assert.equal(mapRectToFrame({ x: 0, y: 0, width: 10, height: 10 }, 1440, 1920, 3024, NaN), null);
  });
});

describe('rectToQuad', () => {
  test('corners in the order TL, TR, BR, BL', () => {
    assert.deepEqual(rectToQuad({ x: 10, y: 20, width: 30, height: 40 }), [
      { x: 10, y: 20 },
      { x: 40, y: 20 },
      { x: 40, y: 60 },
      { x: 10, y: 60 },
    ]);
  });
});

describe('priorFromGuide', () => {
  const VIEW = { viewW: 390, viewH: 600, videoW: 1440, videoH: 1920 };

  test('the guide lands where the viewfinder showed it, in the working photo\'s pixels', () => {
    const guide = guideRect(390, 600);
    const prior = priorFromGuide({ ...VIEW, guide, photoW: 1920, photoH: 2560 });
    // By hand: cover scale 600 / 1920 crops (1440 * 0.3125 - 390) / 2 = 30 view px off each side;
    // then video px to the 1920 x 2560 working photo is a factor of 4 / 3.
    const scale = 600 / 1920;
    const x = ((guide.x + 30) / scale) * (4 / 3);
    const y = (guide.y / scale) * (4 / 3);
    const w = (guide.width / scale) * (4 / 3);
    const h = (guide.height / scale) * (4 / 3);
    const expected = rectToQuad({ x, y, width: w, height: h });
    assert.equal(prior.length, 4);
    prior.forEach((p, i) => {
      close(p.x, expected[i].x, `corner ${i} x`, 1e-6);
      close(p.y, expected[i].y, `corner ${i} y`, 1e-6);
    });
  });

  test('a grabbed frame is the video itself: guide in video px', () => {
    const guide = guideRect(390, 600);
    const prior = priorFromGuide({ ...VIEW, guide, photoW: 1440, photoH: 1920 });
    const inVideo = viewRectToSource(guide, coverMapping(1440, 1920, 390, 600));
    assert.deepEqual(prior, rectToQuad(inVideo));
  });

  test('a guide reaching past the visible picture is clipped to the photo', () => {
    const prior = priorFromGuide({ ...VIEW, guide: { x: -100, y: -100, width: 590, height: 900 }, photoW: 1440, photoH: 1920 });
    for (const p of prior) assert.ok(p.x >= 0 && p.x <= 1440 && p.y >= 0 && p.y <= 1920, `(${p.x}, ${p.y}) inside`);
  });

  test('a still the camera left on its side gives no prior', () => {
    assert.equal(priorFromGuide({ ...VIEW, guide: guideRect(390, 600), photoW: 2560, photoH: 1920 }), null);
  });

  test('no prior without the numbers, or from a sliver of a guide', () => {
    assert.equal(priorFromGuide({ ...VIEW, guide: null, photoW: 1920, photoH: 2560 }), null);
    assert.equal(priorFromGuide({ ...VIEW, guide: guideRect(390, 600), videoW: 0, photoW: 1920, photoH: 2560 }), null);
    assert.equal(priorFromGuide({ ...VIEW, guide: guideRect(390, 600), photoW: 1920 }), null);
    assert.equal(priorFromGuide({ ...VIEW, guide: { x: 100, y: 100, width: 50, height: 20 }, photoW: 1920, photoH: 2560 }), null);
    assert.equal(priorFromGuide(), null);
  });
});

// ---- cameraErrorKind / cameraConstraints --------------------------------------------------------

describe('cameraErrorKind', () => {
  test('each getUserMedia failure gets the kind the screen explains', () => {
    const cases = [
      ['NotAllowedError', 'blocked'],
      ['PermissionDeniedError', 'blocked'],
      ['SecurityError', 'blocked'],
      ['NotFoundError', 'unavailable'],
      ['DevicesNotFoundError', 'unavailable'],
      ['OverconstrainedError', 'unavailable'],
      ['NotSupportedError', 'unavailable'],
      ['NotReadableError', 'busy'],
      ['TrackStartError', 'busy'],
      ['AbortError', 'busy'],
      ['InsecureContextError', 'insecure'],
    ];
    for (const [name, kind] of cases) {
      assert.equal(cameraErrorKind(new DOMException('camera', name)), kind, `DOMException ${name}`);
      assert.equal(cameraErrorKind({ name }), kind, `plain object ${name}`);
    }
    assert.equal(cameraErrorKind(new TypeError('bad constraints')), 'unavailable');
  });

  test('anything else is unknown', () => {
    for (const error of [null, undefined, '', 'NotAllowedError', 42, {}, new Error('x'), new DOMException('x', 'InvalidStateError')]) {
      assert.equal(cameraErrorKind(error), 'unknown', String(error));
    }
  });
});

describe('cameraConstraints', () => {
  test('the rear camera, 4:3 at 1920 x 1440 in landscape terms, all ideal, no sound', () => {
    assert.deepEqual(cameraConstraints(), {
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1440 },
        aspectRatio: { ideal: 4 / 3 },
      },
      audio: false,
    });
  });

  test('a fresh object every call', () => {
    const a = cameraConstraints();
    a.video.width.ideal = 1;
    assert.equal(cameraConstraints().video.width.ideal, 1920);
    assert.notEqual(cameraConstraints(), cameraConstraints());
  });
});

// ---- Fakes for the browser helpers --------------------------------------------------------------

function fakeTrack({ readyState = 'live', settings = { width: 1440, height: 1920 } } = {}) {
  return {
    kind: 'video',
    readyState,
    stopped: 0,
    getSettings: () => settings,
    stop() {
      this.stopped += 1;
      this.readyState = 'ended';
    },
  };
}

function fakeStream(tracks) {
  return { getTracks: () => tracks, getVideoTracks: () => tracks.filter((track) => track.kind === 'video') };
}

function fakeVideo({ width = 1440, height = 1920, play = () => Promise.resolve() } = {}) {
  return {
    videoWidth: width,
    videoHeight: height,
    srcObject: null,
    attributes: {},
    plays: 0,
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    play() {
      this.plays += 1;
      return play();
    },
  };
}

/** A document whose canvases record what is drawn and encoded. */
function installCanvas() {
  const seen = { canvases: [], draws: [], encodes: [], shown: [] };
  setGlobal('document', {
    createElement(tag) {
      assert.equal(tag, 'canvas');
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage(source, x, y, w, h) {
            seen.draws.push({ source, x, y, w, h, canvasW: canvas.width, canvasH: canvas.height });
            // What the video was showing at the moment it was drawn (see turnAway).
            seen.shown.push(source && source.showing);
          },
        }),
        toBlob(callback, type, quality) {
          seen.encodes.push({ type, quality });
          setTimeout(() => callback(new Blob(['frame'], { type })), 0);
        },
      };
      seen.canvases.push(canvas);
      return canvas;
    },
  });
  return seen;
}

/** An ImageCapture whose takePhoto does `takePhoto(options)`; records what it was asked. */
function installImageCapture({ capabilities, takePhoto }) {
  const seen = { constructed: 0, tracks: [], options: [] };
  setGlobal(
    'ImageCapture',
    class {
      constructor(track) {
        seen.constructed += 1;
        seen.tracks.push(track);
      }
      getPhotoCapabilities() {
        return typeof capabilities === 'function' ? capabilities() : Promise.resolve(capabilities);
      }
      takePhoto(options) {
        seen.options.push(options);
        return takePhoto(options);
      }
    },
  );
  return seen;
}

const PHOTO_CAPABILITIES = {
  // Portrait order on purpose: capturePhoto must still ask in landscape order (larger number first).
  imageWidth: { min: 640, max: 3024, step: 1 },
  imageHeight: { min: 480, max: 4032, step: 1 },
  fillLightMode: ['auto', 'off', 'flash'],
};

// ---- capturePhoto -------------------------------------------------------------------------------

describe('capturePhoto', () => {
  test('takePhoto works: the camera\'s own JPEG, asked for at full size in landscape order, flash off', async () => {
    const canvas = installCanvas();
    const still = new Blob(['jpeg-bytes'], { type: 'image/jpeg' });
    const seen = installImageCapture({ capabilities: PHOTO_CAPABILITIES, takePhoto: () => Promise.resolve(still) });
    const track = fakeTrack();
    const result = await capturePhoto({ track, video: fakeVideo() });
    assert.equal(result.capture, 'live');
    assert.equal(result.blob, still);
    assert.equal(seen.tracks[0], track);
    assert.deepEqual(seen.options, [{ imageWidth: 4032, imageHeight: 3024, fillLightMode: 'off' }]);
    // The frame copied at the press, in case takePhoto failed, is never encoded and is handed back.
    assert.equal(canvas.canvases.length, 1);
    assert.equal(canvas.encodes.length, 0, 'no frame encoded');
    assert.equal(canvas.canvases[0].width, 0, 'copy released');
    assert.equal(canvas.canvases[0].height, 0);
  });

  test('no photo sizes on offer: asks for the stream\'s own size, landscape order', async () => {
    installCanvas();
    const seen = installImageCapture({
      capabilities: () => Promise.reject(new DOMException('no', 'NotSupportedError')),
      takePhoto: () => Promise.resolve(new Blob(['jpeg'], { type: 'image/jpeg' })),
    });
    const result = await capturePhoto({ track: fakeTrack({ settings: { width: 1440, height: 1920 } }), video: fakeVideo() });
    assert.equal(result.capture, 'live');
    assert.deepEqual(seen.options, [{ imageWidth: 1920, imageHeight: 1440 }]);
  });

  test('takePhoto rejects: the video frame instead, drawn at the video\'s own size, JPEG 0.92', async () => {
    const canvas = installCanvas();
    installImageCapture({
      capabilities: PHOTO_CAPABILITIES,
      takePhoto: () => Promise.reject(new DOMException('camera busy', 'UnknownError')),
    });
    const video = fakeVideo({ width: 1440, height: 1920 });
    const result = await capturePhoto({ track: fakeTrack(), video });
    assert.equal(result.capture, 'frame');
    assert.ok(result.blob instanceof Blob && result.blob.size > 0);
    assert.equal(result.blob.type, 'image/jpeg');
    assert.deepEqual(canvas.draws, [{ source: video, x: 0, y: 0, w: 1440, h: 1920, canvasW: 1440, canvasH: 1920 }]);
    assert.deepEqual(canvas.encodes, [{ type: 'image/jpeg', quality: 0.92 }]);
    assert.equal(canvas.canvases[0].width, 0, 'canvas released afterwards');
    assert.equal(canvas.canvases[0].height, 0);
  });

  test('takePhoto hangs past the timeout: the video frame, without waiting for it', async () => {
    const canvas = installCanvas();
    installImageCapture({ capabilities: PHOTO_CAPABILITIES, takePhoto: () => new Promise(() => {}) });
    const started = Date.now();
    const result = await capturePhoto({ track: fakeTrack(), video: fakeVideo(), timeoutMs: 40 });
    const waited = Date.now() - started;
    assert.equal(result.capture, 'frame');
    assert.equal(canvas.draws.length, 1);
    assert.ok(waited >= 30, `waited ${waited} ms for takePhoto first`);
    assert.ok(waited < 2000, `gave up on takePhoto after ${waited} ms`);
  });

  test('takePhoto fails late: the frame from the press, not the one showing by then', async () => {
    for (const late of [
      // Rejects after a while (iOS reconfiguring the camera, then giving up) ...
      (video) => () => new Promise((_resolve, reject) => setTimeout(() => {
        turnAway(video);
        reject(new DOMException('camera busy', 'UnknownError'));
      }, 10)),
      // ... or never answers within the timeout.
      (video) => () => {
        setTimeout(() => turnAway(video), 10);
        return new Promise(() => {});
      },
    ]) {
      const canvas = installCanvas();
      const video = fakeVideo({ width: 1440, height: 1920 });
      video.showing = 'the door as framed';
      installImageCapture({ capabilities: PHOTO_CAPABILITIES, takePhoto: late(video) });
      const result = await capturePhoto({ track: fakeTrack(), video, timeoutMs: 40 });
      assert.equal(result.capture, 'frame');
      assert.deepEqual(canvas.shown, ['the door as framed'], 'drawn once, at the press');
      assert.equal(canvas.draws[0].w, 1440, 'at the size it had then');
      assert.equal(canvas.draws[0].h, 1920);
      assert.equal(canvas.encodes.length, 1);
      assert.equal(canvas.canvases[0].width, 0, 'canvas released afterwards');
    }
  });

  test('getPhotoCapabilities hanging counts against the same timeout', async () => {
    installCanvas();
    const seen = installImageCapture({ capabilities: () => new Promise(() => {}), takePhoto: () => Promise.resolve(new Blob(['x'])) });
    const result = await capturePhoto({ track: fakeTrack(), video: fakeVideo(), timeoutMs: 40 });
    assert.equal(result.capture, 'frame');
    assert.equal(seen.options.length, 0, 'takePhoto never reached');
  });

  test('an empty still is no still', async () => {
    const canvas = installCanvas();
    installImageCapture({ capabilities: PHOTO_CAPABILITIES, takePhoto: () => Promise.resolve(new Blob([])) });
    const result = await capturePhoto({ track: fakeTrack(), video: fakeVideo() });
    assert.equal(result.capture, 'frame');
    assert.equal(canvas.draws.length, 1);
  });

  test('no ImageCapture in this browser (iOS before 18.4): the video frame', async () => {
    const canvas = installCanvas();
    removeGlobal('ImageCapture');
    const result = await capturePhoto({ track: fakeTrack(), video: fakeVideo({ width: 1920, height: 1440 }) });
    assert.equal(result.capture, 'frame');
    assert.equal(canvas.draws[0].w, 1920);
    assert.equal(canvas.draws[0].h, 1440);
  });

  test('a track that has ended is not asked for a photo', async () => {
    installCanvas();
    const seen = installImageCapture({ capabilities: PHOTO_CAPABILITIES, takePhoto: () => Promise.resolve(new Blob(['x'])) });
    const result = await capturePhoto({ track: fakeTrack({ readyState: 'ended' }), video: fakeVideo() });
    assert.equal(result.capture, 'frame');
    assert.equal(seen.constructed, 0);
  });

  test('nothing to capture from: rejects', async () => {
    installCanvas();
    removeGlobal('ImageCapture');
    await assert.rejects(capturePhoto({ track: fakeTrack(), video: fakeVideo({ width: 0, height: 0 }) }), /no_frame/);
  });

  test('no frame yet but takePhoto works: the still', async () => {
    const canvas = installCanvas();
    const still = new Blob(['jpeg'], { type: 'image/jpeg' });
    installImageCapture({ capabilities: PHOTO_CAPABILITIES, takePhoto: () => Promise.resolve(still) });
    const result = await capturePhoto({ track: fakeTrack(), video: fakeVideo({ width: 0, height: 0 }) });
    assert.equal(result.blob, still);
    assert.equal(canvas.canvases.length, 0);
  });

  // iOS 18.4+ (and an Android camera that ignores JPEG_ORIENTATION): the phone is on its side, the live
  // frames follow it, the still keeps the camera's default way up.
  for (const [label, still] of [
    ['stored landscape, EXIF says turn it upright', jpegStill(4032, 3024, 6)],
    ['stored portrait, no turn', jpegStill(3024, 4032, 1)],
  ]) {
    test(`a still turned against the live view (${label}): the frame from the press instead`, async () => {
      const canvas = installCanvas();
      const seen = installImageCapture({ capabilities: PHOTO_CAPABILITIES, takePhoto: () => Promise.resolve(still) });
      const video = fakeVideo({ width: 1920, height: 1440 });
      const result = await capturePhoto({ track: fakeTrack(), video });
      assert.equal(seen.options.length, 1, 'the still was asked for');
      assert.equal(result.capture, 'frame');
      assert.notEqual(result.blob, still);
      assert.deepEqual(canvas.draws, [{ source: video, x: 0, y: 0, w: 1920, h: 1440, canvasW: 1920, canvasH: 1440 }]);
      assert.equal(canvas.encodes.length, 1);
      assert.equal(canvas.canvases[0].width, 0, 'canvas released afterwards');
    });
  }

  test('a still the same way up as the live view once its EXIF turn is applied is kept', async () => {
    const canvas = installCanvas();
    for (const [still, width, height] of [
      [jpegStill(4032, 3024, 6), 1440, 1920], // portrait phone: stored landscape, shown portrait
      [jpegStill(4032, 3024, 1), 1920, 1440], // landscape phone that turned its JPEG properly
      [jpegStill(3024, 3024, 1), 1920, 1440], // a square still is neither way up
    ]) {
      installImageCapture({ capabilities: PHOTO_CAPABILITIES, takePhoto: () => Promise.resolve(still) });
      const result = await capturePhoto({ track: fakeTrack(), video: fakeVideo({ width, height }) });
      assert.equal(result.capture, 'live');
      assert.equal(result.blob, still);
    }
    assert.equal(canvas.encodes.length, 0, 'no frame encoded');
  });
});

/**
 * The head of a JPEG stored `width` x `height` px with EXIF Orientation `orientation`: SOI, an APP1 Exif
 * segment (big-endian TIFF, IFD0 holding only Orientation) and a baseline SOF0 frame header.
 */
function jpegStill(width, height, orientation) {
  const tiff = [
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // "MM", 42, IFD0 at offset 8
    0x00, 0x01, // one entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, // Orientation, SHORT
    0x00, 0x00, 0x00, 0x00, // no next IFD
  ];
  const exif = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff]; // "Exif\0\0"
  const app1 = [0xff, 0xe1, 0x00, exif.length + 2, ...exif];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Blob([new Uint8Array([0xff, 0xd8, ...app1, ...sof, 0xff, 0xd9])], { type: 'image/jpeg' });
}

/** The phone moves on while takePhoto is out: another picture, and turned on its side. */
function turnAway(video) {
  video.showing = 'the floor';
  video.videoWidth = 1920;
  video.videoHeight = 1440;
}

// ---- embedBlocksCamera --------------------------------------------------------------------------

describe('embedBlocksCamera', () => {
  const topWindow = () => {
    const win = {};
    win.self = win;
    win.top = win;
    return win;
  };
  const framedWindow = () => {
    const win = { top: {} };
    win.self = win;
    return win;
  };

  test('not in an iframe: a refusal is the customer\'s (or the browser settings\')', () => {
    assert.equal(embedBlocksCamera(topWindow(), {}), false);
    assert.equal(embedBlocksCamera(undefined, undefined), false, 'no window at all (Node)');
  });

  test('in an iframe, the browser\'s own policy answer decides where it gives one', () => {
    const policy = (allowed) => ({ allowsFeature: (name) => (assert.equal(name, 'camera'), allowed) });
    assert.equal(embedBlocksCamera(framedWindow(), { featurePolicy: policy(false) }), true, 'no allow="camera"');
    assert.equal(embedBlocksCamera(framedWindow(), { featurePolicy: policy(true) }), false, 'allowed: the customer said no');
    assert.equal(embedBlocksCamera(framedWindow(), { permissionsPolicy: policy(true) }), false);
  });

  test('in an iframe with no policy API (Safari), or one that throws: blamed on the embed', () => {
    assert.equal(embedBlocksCamera(framedWindow(), {}), true);
    const throwing = { featurePolicy: { allowsFeature() { throw new Error('no'); } } };
    assert.equal(embedBlocksCamera(framedWindow(), throwing), true);
    const guarded = { self: null };
    Object.defineProperty(guarded, 'top', { get() { throw new DOMException('cross origin', 'SecurityError'); } });
    assert.equal(embedBlocksCamera(guarded, {}), true, 'top unreadable');
  });
});

// ---- startCamera / stopCamera -------------------------------------------------------------------

function installMediaDevices(getUserMedia) {
  const calls = [];
  setGlobal('isSecureContext', true);
  setGlobal('navigator', {
    userAgent: 'test',
    mediaDevices: {
      getUserMedia(constraints) {
        calls.push(constraints);
        return getUserMedia(constraints, calls.length);
      },
    },
  });
  return calls;
}

describe('startCamera', () => {
  test('opens the rear camera with cameraConstraints(), sets the video up for iOS and plays it', async () => {
    const track = fakeTrack();
    const stream = fakeStream([track]);
    const calls = installMediaDevices(() => Promise.resolve(stream));
    const video = fakeVideo();
    const result = await startCamera(video);
    assert.deepEqual(calls, [cameraConstraints()]);
    assert.equal(result.stream, stream);
    assert.equal(result.track, track);
    assert.equal(result.playing, true);
    assert.equal(video.srcObject, stream);
    assert.equal(video.muted, true);
    assert.equal(video.playsInline, true);
    assert.equal(video.attributes.playsinline, '');
    assert.equal(video.plays, 1);
  });

  test('iOS refuses play() without a tap: the stream is kept and playing is false', async () => {
    const track = fakeTrack();
    installMediaDevices(() => Promise.resolve(fakeStream([track])));
    const video = fakeVideo({ play: () => Promise.reject(new DOMException('needs a gesture', 'NotAllowedError')) });
    const result = await startCamera(video);
    assert.equal(result.playing, false);
    assert.equal(track.stopped, 0, 'stream not stopped');
    assert.equal(video.srcObject, result.stream);
  });

  test('a camera that would not start is asked once more with plainer constraints', async () => {
    const stream = fakeStream([fakeTrack()]);
    const calls = installMediaDevices((_constraints, n) =>
      n === 1 ? Promise.reject(new DOMException('in use', 'NotReadableError')) : Promise.resolve(stream),
    );
    const result = await startCamera(fakeVideo());
    assert.equal(result.stream, stream);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], { video: { facingMode: { ideal: 'environment' } }, audio: false });
  });

  test('permission refused: no second ask, and the error classifies as blocked', async () => {
    const calls = installMediaDevices(() => Promise.reject(new DOMException('denied', 'NotAllowedError')));
    const error = await startCamera(fakeVideo()).then(() => null, (e) => e);
    assert.equal(calls.length, 1);
    assert.equal(cameraErrorKind(error), 'blocked');
  });

  test('dropped while the browser decides: the late stream is stopped, the video left alone, AbortError', async () => {
    const track = fakeTrack();
    let grant;
    installMediaDevices(() => new Promise((resolve) => {
      grant = resolve;
    }));
    const video = fakeVideo();
    const request = new AbortController();
    const started = startCamera(video, { signal: request.signal });
    request.abort();
    const newer = { id: 'a newer request' };
    video.srcObject = newer;
    grant(fakeStream([track]));
    const error = await started.then(() => null, (e) => e);
    assert.equal(error && error.name, 'AbortError');
    assert.equal(track.stopped, 1, 'camera handed straight back');
    assert.equal(video.srcObject, newer, 'the newer stream stays on the video');
    assert.equal(video.plays, 0);
  });

  test('dropped, then refused with a retryable error: no second ask', async () => {
    const request = new AbortController();
    const calls = installMediaDevices(() => {
      request.abort();
      return Promise.reject(new DOMException('in use', 'NotReadableError'));
    });
    const error = await startCamera(fakeVideo(), { signal: request.signal }).then(() => null, (e) => e);
    assert.equal(calls.length, 1);
    assert.equal(error.name, 'NotReadableError');
  });

  test('getUserMedia is called before anything is awaited (the tap still counts as the gesture)', () => {
    const calls = installMediaDevices(() => new Promise(() => {}));
    startCamera(fakeVideo());
    assert.equal(calls.length, 1, 'called synchronously');
  });

  test('a stream without a video track is stopped and reported as no camera', async () => {
    const audio = { ...fakeTrack(), kind: 'audio' };
    installMediaDevices(() => Promise.resolve(fakeStream([audio])));
    const error = await startCamera(fakeVideo()).then(() => null, (e) => e);
    assert.equal(cameraErrorKind(error), 'unavailable');
    assert.equal(audio.stopped, 1);
  });

  test('no camera API: insecure on an http page, unavailable otherwise', async () => {
    setGlobal('navigator', { userAgent: 'test' });
    setGlobal('isSecureContext', false);
    assert.equal(cameraErrorKind(await startCamera(fakeVideo()).then(() => null, (e) => e)), 'insecure');
    setGlobal('isSecureContext', true);
    assert.equal(cameraErrorKind(await startCamera(fakeVideo()).then(() => null, (e) => e)), 'unavailable');
  });
});

describe('stopCamera', () => {
  test('stops every track, even when one of them throws', () => {
    const a = fakeTrack();
    const b = { ...fakeTrack(), stop() { throw new Error('gone'); } };
    const c = fakeTrack();
    stopCamera(fakeStream([a, b, c]));
    assert.equal(a.stopped, 1);
    assert.equal(c.stopped, 1);
  });

  test('nothing to stop is fine', () => {
    stopCamera(null);
    stopCamera(undefined);
    stopCamera({});
  });
});

// ---- The capture screen (js/screens/capture.js) -------------------------------------------------

/**
 * A just-enough DOM for the capture screen: elements with a parent chain, `hidden`, classes, events, and
 * focus() that, as in a browser, does nothing on a disabled, hidden or unfocusable element. `ui` stands in
 * for the kit (js/ui.js) with the builders the screen uses.
 */
function fakeScreenDom() {
  const doc = { activeElement: null, visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };

  class El {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.parent = null;
      this.hidden = false;
      this.disabled = false;
      this.textContent = '';
      this.attributes = {};
      this.listeners = {};
      this.style = {};
      this.clientWidth = 0;
      this.clientHeight = 0;
      this.classes = new Set();
      this.classList = {
        add: (...names) => names.forEach((name) => this.classes.add(name)),
        remove: (...names) => names.forEach((name) => this.classes.delete(name)),
        toggle: (name, force = !this.classes.has(name)) => {
          if (force) this.classes.add(name);
          else this.classes.delete(name);
          return force;
        },
        contains: (name) => this.classes.has(name),
      };
    }
    append(...nodes) {
      for (const node of nodes.flat()) {
        if (!node || typeof node !== 'object') continue;
        node.parent = this;
        this.children.push(node);
      }
    }
    replaceChildren(...nodes) {
      this.children = [];
      this.append(...nodes);
    }
    contains(node) {
      for (let n = node; n; n = n.parent) if (n === this) return true;
      return false;
    }
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    }
    removeAttribute(name) {
      delete this.attributes[name];
    }
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    }
    removeEventListener(type, fn) {
      this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
    }
    click() {
      if (this.disabled) return;
      for (const fn of [...(this.listeners.click || [])]) fn({ type: 'click', preventDefault() {} });
    }
    focus() {
      const focusable = this.tagName === 'BUTTON' || this.tagName === 'INPUT' || 'tabindex' in this.attributes;
      let shown = true;
      for (let n = this; n; n = n.parent) if (n.hidden) shown = false;
      if (focusable && shown && !this.disabled) doc.activeElement = this;
    }
    find(name) {
      if (this.classes.has(name)) return this;
      for (const child of this.children) {
        const found = child.find(name);
        if (found) return found;
      }
      return null;
    }
  }

  /** A <video> whose play() is refused (iOS wanting a fresh tap) while `refusePlay` is set. */
  function videoElement() {
    const el = new El('video');
    Object.assign(el, { paused: true, videoWidth: 0, videoHeight: 0, srcObject: null, refusePlay: false });
    el.play = () => {
      if (el.refusePlay) return Promise.reject(new DOMException('needs a tap', 'NotAllowedError'));
      el.paused = false;
      return Promise.resolve();
    };
    el.pause = () => {
      el.paused = true;
    };
    return el;
  }

  function h(tag, props = {}, ...children) {
    const el = tag === 'video' ? videoElement() : new El(tag);
    const { class: className, text, attrs, on, ...rest } = props || {};
    if (className) el.classList.add(...String(className).split(/\s+/));
    if (text !== undefined) el.textContent = String(text);
    for (const [name, value] of Object.entries(attrs || {})) el.setAttribute(name, value);
    for (const [type, fn] of Object.entries(on || {})) el.addEventListener(type, fn);
    Object.assign(el, rest);
    el.append(...children);
    return el;
  }

  const ui = {
    h,
    icon: () => new El('svg'),
    button(label, { onClick } = {}) {
      const el = h('button', { class: 'sm-btn', text: label });
      if (typeof onClick === 'function') el.addEventListener('click', onClick);
      el.setLoading = () => {};
      return el;
    },
    fileButton(label, { onFile } = {}) {
      const input = h('input', { type: 'file' });
      const el = h('label', { class: 'sm-btn', text: label }, input);
      el.input = input;
      // What the kit calls with the file the customer picked.
      el.onFile = onFile;
      return el;
    },
    actionBar: (...children) => h('div', { class: 'sm-actionbar' }, ...children),
  };
  return { doc, h, ui };
}

/** A window inside an iframe (top is another window). */
function framedWindow() {
  const win = { top: {}, addEventListener() {}, removeEventListener() {} };
  win.self = win;
  return win;
}

/**
 * Mount the capture screen with `getUserMedia` as the camera; parts are found by their class.
 * `noCameraApi` leaves navigator.mediaDevices out altogether, as in a WebView that exposes none.
 */
function mountCapture({
  getUserMedia,
  noCameraApi = false,
  window: win,
  userAgent = 'test',
  maxTouchPoints = 0,
  t = (key) => key,
  state = {},
  config = {},
} = {}) {
  const dom = fakeScreenDom();
  setGlobal('document', dom.doc);
  setGlobal('navigator', noCameraApi ? { userAgent, maxTouchPoints } : { userAgent, maxTouchPoints, mediaDevices: { getUserMedia } });
  if (win) setGlobal('window', win);
  const root = dom.h('section');
  const went = [];
  const toasts = [];
  const cleanup = mountCaptureScreen(root, {
    ui: dom.ui,
    config,
    state,
    t,
    go: (screenId) => went.push(screenId),
    busy: (fn) => fn(),
    toast: (text) => toasts.push(text),
  });
  const part = (name) => root.find(`sm-capture__${name}`);
  const allow = part('card').children.find((el) => el.tagName === 'BUTTON');
  const [cameraApp, choose] = part('fallbacks').children;
  return { doc: dom.doc, cleanup, part, allow, cameraApp, choose, video: part('video'), went, toasts };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
/** Lets pending promise callbacks run without a timer, for tests that mock setTimeout. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A getUserMedia whose every call waits until the test answers it; `calls` holds each call's answers. */
function heldGetUserMedia() {
  const calls = [];
  const getUserMedia = () =>
    new Promise((resolve, reject) => {
      calls.push({ resolve, reject });
    });
  return { calls, getUserMedia };
}

/** Run every `type` listener the screen put on a fake element (the fake DOM has no event dispatch). */
function fire(el, type) {
  for (const fn of [...(el.listeners[type] || [])]) fn({ type, preventDefault() {} });
}

/** Count the writes to an element's textContent from now on. */
function countTextWrites(el) {
  let value = el.textContent;
  const writes = { count: 0 };
  Object.defineProperty(el, 'textContent', {
    configurable: true,
    get: () => value,
    set: (next) => {
      writes.count += 1;
      value = next;
    },
  });
  return writes;
}

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)';

describe('capture screen', () => {
  test('a refusal inside an iframe without allow="camera": no site-settings help and no Allow camera to fail again', async () => {
    let refuse;
    const screen = mountCapture({
      window: framedWindow(),
      getUserMedia: () => new Promise((_resolve, reject) => {
        refuse = reject;
      }),
    });
    // The customer is on the card's button while the browser decides.
    screen.allow.focus();
    assert.equal(screen.doc.activeElement, screen.allow);
    refuse(new DOMException('not allowed in this frame', 'NotAllowedError'));
    await settle();
    assert.equal(screen.part('panel-title').textContent, 'capture.unavailable.title');
    assert.equal(screen.part('panel-text').textContent, 'capture.unavailable.embedded');
    assert.equal(screen.part('panel-help').hidden, true, 'no settings help');
    assert.equal(screen.allow.hidden, true, 'no Allow camera');
    assert.ok(screen.cameraApp.classes.has('sm-btn--primary'), 'the camera app is the way on');
    assert.ok(screen.part('fallbacks').classes.has('sm-capture__fallbacks--main'));
    assert.equal(screen.doc.activeElement, screen.cameraApp.input, 'focus moved on with the hidden button');
    screen.cleanup();
  });

  test('the same refusal outside an iframe is the customer\'s: settings help and Allow camera', async () => {
    const screen = mountCapture({ getUserMedia: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) });
    await settle();
    assert.equal(screen.part('panel-title').textContent, 'capture.blocked.title');
    assert.equal(screen.part('panel-help').textContent, 'capture.blocked.help.other');
    assert.equal(screen.part('panel-help').hidden, false);
    assert.equal(screen.allow.hidden, false);
    screen.cleanup();
  });

  test('an app\'s built-in browser with no camera API: the in-app words, and no Allow camera that fails again at once', async () => {
    const cases = [
      ['Facebook on an iPhone (WKWebView)', `${IPHONE} Mobile/15E148 [FBAN/FBIOS;FBAV/470.0.0.37.108;FBBV/620000000;FBDV/iPhone15,2]`],
      ['an Android app WebView', 'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.6778.135 Mobile Safari/537.36'],
    ];
    for (const [label, userAgent] of cases) {
      setGlobal('isSecureContext', true); // https: the missing API is the WebView's, not the page's
      const screen = mountCapture({ userAgent, noCameraApi: true });
      // The customer is on the card's button while the screen starts.
      screen.allow.focus();
      assert.equal(screen.doc.activeElement, screen.allow, label);
      await settle();
      assert.equal(screen.part('panel-title').textContent, 'capture.unavailable.title', label);
      assert.equal(screen.part('panel-text').textContent, 'capture.unavailable.inapp', label);
      assert.equal(screen.allow.hidden, true, `${label}: no Allow camera`);
      assert.ok(screen.cameraApp.classes.has('sm-btn--primary'), `${label}: the camera app is the way on`);
      assert.equal(screen.doc.activeElement, screen.cameraApp.input, `${label}: focus moved on with the hidden button`);
      screen.cleanup();
    }
  });

  test('an app\'s built-in browser that has the camera API but would not give the camera: Allow camera stays', async () => {
    const userAgent = 'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.6778.135 Mobile Safari/537.36';
    for (const error of [new DOMException('denied', 'NotAllowedError'), new DOMException('none', 'NotFoundError')]) {
      let calls = 0;
      const screen = mountCapture({
        userAgent,
        getUserMedia: () => {
          calls += 1;
          return Promise.reject(error);
        },
      });
      await settle();
      assert.equal(screen.part('panel-text').textContent, 'capture.unavailable.inapp', error.name);
      assert.equal(screen.allow.hidden, false, `${error.name}: the app may yet be asked to allow it`);
      const before = calls;
      screen.allow.click();
      assert.ok(calls > before, `${error.name}: Allow camera asks again`);
      await settle();
      screen.cleanup();
    }
  });

  test('a browser with no camera API outside an app: the plain words, and no Allow camera', async () => {
    setGlobal('isSecureContext', true);
    const screen = mountCapture({ userAgent: `${IPHONE} Version/18.1 Mobile/15E148 Safari/604.1`, noCameraApi: true });
    await settle();
    assert.equal(screen.part('panel-text').textContent, 'capture.unavailable.unsupported');
    assert.equal(screen.allow.hidden, true);
    screen.cleanup();
  });

  for (const [label, hasFrame] of [
    ['the shutter', true],
    ['the hint, while the shutter waits for a frame', false],
  ]) {
    test(`Allow camera puts the card away: focus goes on to ${label}, not to the top of the page`, async () => {
      const track = fakeTrack();
      const screen = mountCapture({ getUserMedia: () => Promise.resolve(fakeStream([track])) });
      screen.video.refusePlay = true; // iOS: the stream opens, but playback waits for a tap
      await settle();
      assert.equal(screen.part('panel').hidden, false, 'paused: the card asks for a tap');
      screen.allow.focus();
      assert.equal(screen.doc.activeElement, screen.allow);

      screen.video.refusePlay = false;
      if (hasFrame) Object.assign(screen.video, { videoWidth: 1440, videoHeight: 1920 });
      screen.allow.click();
      await settle();
      assert.equal(screen.part('panel').hidden, true, 'live');
      const shutter = screen.part('shutter');
      assert.equal(shutter.disabled, !hasFrame);
      assert.equal(screen.doc.activeElement, hasFrame ? shutter : screen.part('hint'));
      screen.cleanup();
      assert.equal(track.stopped, 1, 'camera released on leaving');
    });
  }

  test('blocked on an iPhone or iPad: Safari gets its aA steps, the other browsers steps that fit them', async () => {
    const cases = [
      [`${IPHONE} Version/18.1 Mobile/15E148 Safari/604.1`, 0, 'capture.blocked.help.ios'],
      // iPadOS Safari asks for desktop sites: a Mac with a touch screen.
      ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15', 5, 'capture.blocked.help.ios'],
      [`${IPHONE} CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1`, 0, 'capture.blocked.help.iosbrowser:Chrome'],
      [`${IPHONE} FxiOS/132.0 Mobile/15E148 Safari/605.1.15`, 0, 'capture.blocked.help.iosbrowser:Firefox'],
      [`${IPHONE} Version/18.0 EdgiOS/131.2903.68 Mobile/15E148 Safari/605.1.15`, 0, 'capture.blocked.help.iosbrowser:Edge'],
      [`${IPHONE} Version/18.0 Mobile/15E148 Safari/604.1 OPT/5.1.0`, 0, 'capture.blocked.help.iosbrowser:Opera'],
      ['Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36', 5, 'capture.blocked.help.android'],
    ];
    for (const [userAgent, maxTouchPoints, help] of cases) {
      const screen = mountCapture({
        userAgent,
        maxTouchPoints,
        t: (key, vars) => (vars && vars.browser ? `${key}:${vars.browser}` : key),
        getUserMedia: () => Promise.reject(new DOMException('denied', 'NotAllowedError')),
      });
      await settle();
      assert.equal(screen.part('panel-title').textContent, 'capture.blocked.title', userAgent);
      assert.equal(screen.part('panel-help').textContent, help, userAgent);
      screen.cleanup();
    }
    // The other browsers' steps name the browser, and none of Safari's buttons.
    assert.match(captureStrings['capture.blocked.help.iosbrowser'], /\{browser\}/);
    assert.doesNotMatch(captureStrings['capture.blocked.help.iosbrowser'], /aA|Website Settings/);
    assert.match(captureStrings['capture.blocked.help.ios'], /aA/);
  });

  test('a camera request that never settles: after the camera app, Allow camera asks again, and the late stream is stopped', async () => {
    const held = heldGetUserMedia();
    const screen = mountCapture({ getUserMedia: held.getUserMedia });
    assert.equal(held.calls.length, 1);
    assert.equal(screen.allow.attributes['aria-disabled'], 'true', 'waiting on the browser');
    screen.allow.click();
    assert.equal(held.calls.length, 1, 'no second ask while the prompt may be up');

    // The prompt is left open (Firefox for Android): the customer tries their camera app, and comes back.
    screen.cameraApp.click();
    assert.equal(screen.part('panel-title').textContent, 'capture.paused.title');
    assert.equal(screen.allow.attributes['aria-disabled'], 'false');
    screen.allow.click();
    assert.equal(held.calls.length, 2, 'Allow camera asks again');

    const fresh = fakeTrack();
    const freshStream = fakeStream([fresh]);
    held.calls[1].resolve(freshStream);
    await settle();
    assert.equal(screen.part('panel').hidden, true, 'live');
    assert.equal(screen.video.srcObject, freshStream);

    // The first prompt is answered at last: that stream goes straight back, the viewfinder keeps the new one.
    const late = fakeTrack();
    held.calls[0].resolve(fakeStream([late]));
    await settle();
    assert.equal(late.stopped, 1);
    assert.equal(fresh.stopped, 0);
    assert.equal(screen.video.srcObject, freshStream);
    assert.equal(screen.part('panel').hidden, true, 'still live');
    screen.cleanup();
    assert.equal(fresh.stopped, 1, 'camera released on leaving');
  });

  test('a request nothing ever answers: after a while Allow camera stops spinning and asks again', (context) => {
    const START_PATIENCE_MS = 8000; // js/screens/capture.js
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const held = heldGetUserMedia();
    const screen = mountCapture({ getUserMedia: held.getUserMedia });
    assert.equal(screen.allow.attributes['aria-disabled'], 'true');
    assert.equal(screen.part('panel-help').hidden, true);
    context.mock.timers.tick(START_PATIENCE_MS - 1000);
    screen.allow.click();
    assert.equal(held.calls.length, 1, 'still giving the prompt its chance');

    context.mock.timers.tick(1000);
    assert.equal(screen.allow.attributes['aria-disabled'], 'false', 'Allow camera works again');
    assert.equal(screen.part('panel-help').hidden, false);
    assert.equal(screen.part('panel-help').textContent, 'capture.starting.slow');
    screen.allow.click();
    assert.equal(held.calls.length, 2, 'asked again');
    assert.equal(screen.allow.attributes['aria-disabled'], 'true', 'waiting on the new request');
    assert.equal(screen.part('panel-help').hidden, true);
    screen.cleanup();
  });

  test('Choose a photo lets go of the camera before the picker opens; a cancelled picker brings it back', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const tracks = [];
    const screen = mountCapture({
      getUserMedia: () => {
        const track = fakeTrack();
        tracks.push(track);
        return Promise.resolve(fakeStream([track]));
      },
    });
    Object.assign(screen.video, { videoWidth: 1440, videoHeight: 1920 });
    await flush();
    assert.equal(screen.part('panel').hidden, true, 'live');

    // iOS offers Take Photo beside the library: the native camera must not open over ours.
    screen.choose.click();
    assert.equal(tracks[0].stopped, 1, 'camera released first');
    assert.equal(screen.part('panel-title').textContent, 'capture.paused.title');

    fire(screen.choose.input, 'cancel');
    context.mock.timers.tick(1000);
    await flush();
    assert.equal(tracks.length, 2, 'opened again');
    assert.equal(screen.part('panel').hidden, true, 'live again');
    screen.cleanup();
  });

  test('re-rendering an unchanged card leaves its words alone (the live region would read them again)', async () => {
    const held = heldGetUserMedia();
    const screen = mountCapture({ getUserMedia: held.getUserMedia });
    const watch = () => ['panel-title', 'panel-text', 'panel-help'].map((name) => [name, countTextWrites(screen.part(name))]);
    // 'starting': the video reports its size while play() is still out.
    let writes = watch();
    fire(screen.video, 'loadedmetadata');
    fire(screen.video, 'resize');
    for (const [name, seen] of writes) assert.equal(seen.count, 0, `starting: ${name}`);

    held.calls[0].reject(new DOMException('denied', 'NotAllowedError'));
    await settle();
    assert.equal(screen.part('panel-title').textContent, 'capture.blocked.title');
    // 'blocked': the phone turns.
    writes = watch();
    fire(screen.video, 'resize');
    for (const [name, seen] of writes) assert.equal(seen.count, 0, `blocked: ${name}`);
    screen.cleanup();
  });

  test('the camera going live is announced once the shutter works, and again when it is back after a pause', async () => {
    const screen = mountCapture({ getUserMedia: () => Promise.resolve(fakeStream([fakeTrack()])) });
    const status = screen.part('status');
    assert.equal(status.attributes.role, 'status');
    assert.equal(status.textContent, '', 'nothing to say while starting');
    await settle();
    assert.equal(screen.part('panel').hidden, true, 'live');
    assert.equal(status.textContent, '', 'not before the shutter works');

    Object.assign(screen.video, { videoWidth: 1440, videoHeight: 1920 });
    fire(screen.video, 'loadedmetadata');
    assert.equal(screen.part('shutter').disabled, false);
    assert.equal(status.textContent, 'capture.ready');
    // Never hidden: a live region has to stay in the accessibility tree for its changes to be read out.
    for (let n = status; n; n = n.parent) assert.equal(n.hidden, false);

    screen.cameraApp.click();
    assert.equal(status.textContent, '', 'emptied while paused');
    screen.allow.click();
    await settle();
    assert.equal(status.textContent, 'capture.ready', 'said again');
    screen.cleanup();
  });

  test('says on the session whether the live camera worked: true once live, false once it failed, nothing while starting', async () => {
    const working = {};
    const live = mountCapture({ state: working, getUserMedia: () => Promise.resolve(fakeStream([fakeTrack()])) });
    assert.equal('liveCamera' in working, false, "'starting' says nothing about it yet");
    await settle();
    assert.equal(live.part('panel').hidden, true, 'live');
    assert.equal(working.liveCamera, true);
    // Paused for the camera app: it still worked on this phone.
    live.cameraApp.click();
    assert.equal(live.part('panel-title').textContent, 'capture.paused.title');
    assert.equal(working.liveCamera, true);
    live.cleanup();

    for (const error of [
      new DOMException('denied', 'NotAllowedError'),
      new DOMException('in use', 'NotReadableError'),
      new DOMException('none', 'NotFoundError'),
      new Error('something else'),
    ]) {
      const failing = { liveCamera: true };
      const screen = mountCapture({ state: failing, getUserMedia: () => Promise.reject(error) });
      await settle();
      assert.equal(screen.part('panel').hidden, false, error.name);
      assert.equal(failing.liveCamera, false, error.name);
      screen.cleanup();
    }
  });

  test('a photo from the shutter keeps the framing guide, in photo px, as state.door.prior for the door screen', async () => {
    const VIDEO = { width: 1440, height: 1920 };
    const VIEW = { width: 390, height: 600 };
    // What loadPhoto needs of the browser: a canvas to grab the frame and draw the working copy on, and a
    // bitmap decoder. getImageData hands back too few pixels for a search, so findDoor answers at once.
    setGlobal('createImageBitmap', async () => ({ width: VIDEO.width, height: VIDEO.height, close() {} }));
    const state = { photo: null, sheet: null, door: { points: null, detection: null }, measure: null, size: null };
    const screen = mountCapture({
      state,
      config: { measurement: { maxWorkingSizePx: 2560 } },
      getUserMedia: () => Promise.resolve(fakeStream([fakeTrack({ settings: VIDEO })])),
    });
    screen.doc.createElement = (tag) => {
      assert.equal(tag, 'canvas');
      return {
        width: 0,
        height: 0,
        getContext: () => ({
          fillRect() {},
          drawImage() {},
          getImageData: (_x, _y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(4) }),
        }),
        toBlob: (callback, type) => setTimeout(() => callback(new Blob(['frame'], { type })), 0),
      };
    };
    Object.assign(screen.part('stage'), { clientWidth: VIEW.width, clientHeight: VIEW.height });
    Object.assign(screen.video, { videoWidth: VIDEO.width, videoHeight: VIDEO.height });
    await settle();
    const shutter = screen.part('shutter');
    assert.equal(shutter.disabled, false, 'ready to take the photo');

    shutter.click();
    for (let i = 0; i < 50 && screen.went.length === 0; i += 1) await settle();
    assert.deepEqual(screen.went, ['door']);
    assert.deepEqual(screen.toasts, []);
    assert.equal(state.method, 'estimate');
    assert.equal(state.photo.capture, 'frame');
    assert.equal(state.photo.width, VIDEO.width);

    const expected = priorFromGuide({
      guide: guideRect(VIEW.width, VIEW.height),
      viewW: VIEW.width,
      viewH: VIEW.height,
      videoW: VIDEO.width,
      videoH: VIDEO.height,
      photoW: VIDEO.width,
      photoH: VIDEO.height,
    });
    assert.ok(Array.isArray(expected) && expected.length === 4, 'the guide maps into this photo');
    assert.deepEqual(state.door.prior, expected);
    // Plain { x, y } copies of their own: nothing else holds them.
    for (const point of state.door.prior) assert.deepEqual(Object.keys(point), ['x', 'y']);
    assert.ok(state.door.detection && typeof state.door.detection === 'object', 'the search ran and its answer was kept');
    screen.cleanup();
  });

  test('a picked photo was never framed by the guide: no prior', async () => {
    setGlobal('createImageBitmap', async () => ({ width: 1440, height: 1920, close() {} }));
    const state = { photo: null, door: { points: null, detection: null } };
    const screen = mountCapture({ state, getUserMedia: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) });
    screen.doc.createElement = () => ({
      width: 0,
      height: 0,
      getContext: () => ({ fillRect() {}, drawImage() {}, getImageData: (_x, _y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(4) }) }),
    });
    await settle();
    // ui.fileButton hands the picked file to the handler the screen gave it.
    const picked = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' });
    assert.equal(typeof screen.cameraApp.onFile, 'function', 'the screen gave the kit its file handler');
    screen.cameraApp.onFile(picked);
    for (let i = 0; i < 50 && screen.went.length === 0; i += 1) await settle();
    assert.deepEqual(screen.went, ['door']);
    assert.equal(state.photo.capture, 'file');
    assert.equal('prior' in state.door, false);
    screen.cleanup();
  });
});

test('no stubbed global outlives its test', () => {
  for (const name of STUBBED) {
    assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, name), ORIGINAL.get(name), name);
  }
});
