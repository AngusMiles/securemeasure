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
import { mount as mountCaptureScreen } from '../js/screens/capture.js';

// ---- Global stubs ------------------------------------------------------------------------------

const STUBBED = ['navigator', 'ImageCapture', 'document', 'isSecureContext', 'window'];
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
});

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
    fileButton(label) {
      const input = h('input', { type: 'file' });
      const el = h('label', { class: 'sm-btn', text: label }, input);
      el.input = input;
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

/** Mount the capture screen with `getUserMedia` as the camera; parts are found by their class. */
function mountCapture({ getUserMedia, window: win } = {}) {
  const dom = fakeScreenDom();
  setGlobal('document', dom.doc);
  setGlobal('navigator', { userAgent: 'test', maxTouchPoints: 0, mediaDevices: { getUserMedia } });
  if (win) setGlobal('window', win);
  const root = dom.h('section');
  const cleanup = mountCaptureScreen(root, {
    ui: dom.ui,
    config: {},
    state: {},
    t: (key) => key,
    go() {},
    busy: (fn) => fn(),
    toast() {},
  });
  const part = (name) => root.find(`sm-capture__${name}`);
  const allow = part('card').children.find((el) => el.tagName === 'BUTTON');
  const cameraApp = part('fallbacks').children[0];
  return { doc: dom.doc, cleanup, part, allow, cameraApp, video: part('video') };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

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
});

test('no stubbed global outlives its test', () => {
  for (const name of STUBBED) {
    assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, name), ORIGINAL.get(name), name);
  }
});
