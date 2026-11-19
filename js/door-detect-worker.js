/**
 * Module worker that runs the door detector off the main thread (started by js/door-find.js).
 *
 * Protocol: the page posts { id, image: { data, width, height }, opts } with `data` transferred (a copy of
 * the photo's RGBA pixels), and gets back { id, result } where `result` is a door-find Detection
 * ({ ok, quad, confidence, alternatives, reason? }). One request per worker; door-find terminates it after.
 *
 * Importing this file outside a worker (e.g. from a Node test) only defines handleMessage.
 */
import { runDetection } from './door-find.js';

/**
 * Answer one request. Never throws: a malformed message gets a 'bad_input' (or 'error') result.
 *
 * @param {{ id?: unknown, image?: unknown, opts?: object }} data  the message the page posted
 * @returns {{ id: unknown, result: object }}
 */
export function handleMessage(data) {
  const id = data && typeof data === 'object' ? data.id : undefined;
  const image = data && typeof data === 'object' ? data.image : undefined;
  const opts = data && typeof data === 'object' && data.opts && typeof data.opts === 'object' ? data.opts : {};
  return { id, result: runDetection(image, opts) };
}

// Only a dedicated worker scope has both of these; the main thread and Node have neither as a pair.
if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  self.onmessage = (event) => {
    self.postMessage(handleMessage(event.data));
  };
}
