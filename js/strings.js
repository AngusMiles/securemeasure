/**
 * Shared UI copy and the translator.
 *
 * Every user-visible string has an id. Screens ship their own defaults (keys prefixed with the
 * screen id); the shell's defaults live in COMMON. A door company overrides any of them through
 * `config.text`. This module is pure: no DOM, safe to import under Node.
 */

/** Default copy used by the app shell and available to every screen. */
export const COMMON = {
  'common.step': 'Step {n} of {total}',
  'common.steps.1': 'Photo',
  'common.steps.2': 'Mark',
  'common.steps.3': 'Size',
  'common.steps.4': 'Price',
  'common.loading': 'Loading…',
  'common.working': 'Just a moment…',
  'common.error': 'Sorry, something went wrong. Please try again.',
  'common.back': 'Back',
  'common.next': 'Next',
  'common.continue': 'Continue',
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.done': 'Done',
  'common.ok': 'OK',
  'common.yes': 'Yes',
  'common.no': 'No',
  'common.save': 'Save',
  'common.edit': 'Edit',
  'common.change': 'Change',
  'common.skip': 'Skip',
  'common.help': 'Help',
  'common.retry': 'Try again',
  'common.tryAgain': 'Try again',
  'common.startAgain': 'Start again',
  'common.startOver': 'Start again',
  'common.optional': 'optional',
  'common.required': 'Required',
  'common.or': 'or',
  'common.mm': 'mm',
  'common.width': 'Width',
  'common.height': 'Height',
  'common.crashTitle': 'Sorry, that screen didn’t load',
  'common.crashBody': 'Nothing has been sent. Start again and it should come good.',
  'common.bootFailed': 'Sorry, the measuring tool couldn’t load. Check your connection, then refresh this page.',
  // Shown on "Get set up" after the phone closed the page while its camera was open. {choose} is the
  // label of that screen's "Choose a photo" button.
  'common.photoInterrupted':
    'Your phone closed this page while the camera was open, so the photo was lost. Take the photo with your phone’s camera app first, then tap “{choose}” here.',
};

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

/**
 * Merge the shell copy with each screen module's `strings` export into one flat table.
 * COMMON wins on a key collision so a screen cannot accidentally change shared copy.
 *
 * @param {Array<{ strings?: Record<string, string> }>} screenModules
 * @returns {Record<string, string>}
 */
export function buildStrings(screenModules = []) {
  const table = {};
  const modules = Array.isArray(screenModules) ? screenModules : Object.values(screenModules || {});
  for (const module of modules) {
    const strings = module && module.strings;
    if (!strings || typeof strings !== 'object') continue;
    for (const key of Object.keys(strings)) {
      if (typeof strings[key] === 'string') table[key] = strings[key];
    }
  }
  for (const key of Object.keys(COMMON)) table[key] = COMMON[key];
  return table;
}

/**
 * Create the translator used as `ctx.t`.
 * Lookup order: `config.text[key]`, then `strings[key]`, then the key itself.
 * `{name}` placeholders are filled from `vars`; placeholders with no matching var are left as-is.
 *
 * @param {{ text?: Record<string, string> } | null | undefined} config
 * @param {Record<string, string>} strings
 * @returns {(key: string, vars?: Record<string, string | number>) => string}
 */
export function createTranslator(config, strings) {
  const overrides = config && config.text && typeof config.text === 'object' ? config.text : {};
  const defaults = strings && typeof strings === 'object' ? strings : {};

  return function t(key, vars) {
    let template = key;
    if (hasOwn(overrides, key) && overrides[key] != null) template = overrides[key];
    else if (hasOwn(defaults, key) && defaults[key] != null) template = defaults[key];
    template = String(template);
    if (!vars || typeof vars !== 'object') return template;
    return template.replace(/\{(\w+)\}/g, (placeholder, name) =>
      hasOwn(vars, name) && vars[name] != null ? String(vars[name]) : placeholder,
    );
  };
}
