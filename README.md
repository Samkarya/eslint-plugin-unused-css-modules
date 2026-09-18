# eslint-plugin-unused-css-modules

An ESLint rule that flags CSS Module classes — defined in a `*.module.scss` /
`*.module.sass` / `*.module.css` file — that are never referenced by any
component that imports that module. In other words: dead CSS in your CSS
Modules, caught at lint time instead of discovered six months later while
grepping for "why doesn't this style apply."

```
Footer.tsx
  4:1  warning  Class '.active' is defined at Footer.module.scss:167:4
       but never used in any of the 1 file(s) that import it here.
       If it's used dynamically, add it to this rule's markAsUsed option
       unused-css-modules/no-unused-class
```

## Why this exists

TypeScript/ESLint will tell you about an unused *variable*, but
nothing in a typical toolchain tells you about an unused CSS class sitting
inside a `.module.scss` file. Classes get renamed during a refactor, and the
old rule name never gets deleted. Over a couple of years, `*.module.scss`
files accumulate dead weight that nobody notices because it doesn't break
the build.

This rule does a best-effort (not 100% precise — see [Limitations](#known-limitations-and-heuristics))
static analysis to catch the common case: a class exists in the module, but
no file that imports that module ever writes `styles.thatClass` or
`styles['thatClass']`.

## Install

This package isn't (yet) published to the npm registry — install it
straight from GitHub:

```bash
npm install --save-dev github:Samkarya/eslint-plugin-unused-css-modules
```

To pin to a specific commit or tag (recommended, so an upstream change
doesn't silently alter your lint output):

```bash
npm install --save-dev github:Samkarya/eslint-plugin-unused-css-modules#v1.0.0
```

If this later published to npm under this same name, this line becomes:

```bash
npm install --save-dev eslint-plugin-unused-css-modules
```

## Usage

### Legacy config (`.eslintrc.js`)

```js
module.exports = {
  plugins: ['unused-css-modules'],
  rules: {
    'unused-css-modules/no-unused-class': 'warn',
  },
};
```

Or use the bundled `recommended` config:

```js
module.exports = {
  extends: ['plugin:unused-css-modules/recommended'],
};
```

### Flat config (`eslint.config.js`)

```js
const cssModulesLocal = require('eslint-plugin-unused-css-modules');

module.exports = [
  {
    plugins: { 'unused-css-modules': cssModulesLocal },
    rules: {
      'unused-css-modules/no-unused-class': 'warn',
    },
  },
];
```

## Options

```js
'unused-css-modules/no-unused-class': ['warn', {
  markAsUsed: ['active', 'feature'], // class names to always treat as used
  extensions: ['module.scss', 'module.sass', 'module.css'], // default shown
}],
```

- **`markAsUsed`** (`string[]`, default `[]`): a project-wide allowlist of
  class names the rule should never flag, for classes that are applied in a
  way the rule genuinely can't trace (e.g. looked up via a fully dynamic key
  like `styles[entry.type]` with no static prefix/suffix anywhere in source).
  This is global across the whole project — every class with this name in
  any module is exempted. For a single occurrence in one file, prefer the
  [inline scss comment](#exempting-a-single-class-from-inside-the-scss-file)
  below instead, since it's scoped to just that rule and self-documents
  *why* right where the exemption lives.
- **`extensions`** (`string[]`, default `['module.scss', 'module.sass',
  'module.css']`): which file extensions count as a CSS Module import.

## How it decides a class is "used"

For each `import styles from './X.module.scss'`, the rule:

1. Parses `X.module.scss` for `.className` selectors (skipping SCSS
   namespaced access like `mixins.flex-center`, and anything inside
   `:global(...)`, both described below).
2. Finds every sibling file in the same directory that also imports that
   scss module (so a class used by *any* of several components sharing one
   stylesheet counts as used).
3. For each class, checks all of those files for:
   - `styles.className` (dot access)
   - `styles['className']` / `styles["className"]` (bracket access)
   - `` styles[`prefix${expr}suffix`] `` (template-literal bracket access —
     matched as a wildcard pattern, so `` styles[`diff${diff}`] `` is
     recognized as covering `diffEasy`, `diffMedium`, `diffHard`, etc.)
4. Anything left over gets reported, pointing at the exact
   `path:line:column` of the class's definition in the scss file — most
   editors and terminals (VS Code included) auto-linkify that pattern, so
   the warning is one click away from the dead rule itself.

Only the alphabetically-first importing file reports the warning, so a
class shared (and dead) across several sibling components produces one
warning, not N duplicates.

## `:global(...)` classes are never flagged

A class wrapped in `:global(...)` opts out of CSS Modules hashing on
purpose — it's consumed as a plain string class, never through the
`styles` import (a common pattern for hooking into a global keyframe
animation, or a third-party component that appends its own class name,
like `react-router`'s `NavLink`):

```scss
.spinnerWrapper {
  :global(.spin-icon) {
    animation: spin 1s linear infinite;
  }
}
```

The rule recognizes this and skips the class entirely — no `markAsUsed`
entry or comment needed.

> **Note:** only the parenthesized form `:global(.foo)` is currently
> supported. The block form (`:global { .foo { ... } }`) is not yet
> recognized — see [Limitations](#known-limitations-and-heuristics).

## Exempting a single class from inside the scss file

Put a comment containing `css-modules-ignore-unused` either on the same
line as the selector or the line directly above it:

```scss
.feature { // css-modules-ignore-unused
  color: purple;
}
```

```scss
/* css-modules-ignore-unused */
.feature {
  color: purple;
}
```

This is scoped to just that one class in that one file, and the reasoning
travels with the code instead of living in a project-wide config array.

## Known limitations and heuristics

This rule does **not** parse SCSS or JS/TS with a real parser — it's a
pragmatic, regex-based heuristic, chosen to keep the rule dependency-free
and fast. That means:

- **Fully dynamic keys with no static text** — `styles[entry.type]` where
  `entry.type` is a runtime string with no literal prefix/suffix anywhere
  in source — can never be traced. Use `markAsUsed` or the scss comment for
  these.
- **`:global { ... }` block form** is not recognized yet, only
  `:global(...)`.
- **A class name reused in an unrelated context** (e.g. as a JS object key
  that happens to match a class name) could in rare cases cause a false
  "used" result — the check for `styles.className` / `styles['className']`
  is a scoped regex against `ident.className`, not a full AST-aware
  reference check, so it's about as precise as such a regex can be but not
  a real type-checker.
- **First occurrence = "definition"** — when reporting the scss location,
  the rule points at the *first* textual occurrence of `.className` in the
  file. If a class only ever appears nested (e.g. only under `&.foo` inside
  another rule, never as its own top-level block), that's still where it'll
  point — which is the right place to look, just not always the outermost
  rule.

If you hit a false positive or false negative, please open an issue with a
minimal scss + tsx reproduction — most of the fixes so far (template
literals, `:global()`, the ignore-comment convention) came directly from
real cases like that.

## Contributing

Issues and PRs welcome. Please add a test in `tests/` (see
`tests/no-unused-class.test.js` and its `tests/fixtures/` directory) that
reproduces the case you're fixing — the rule reads real files off disk
(it needs to look at sibling importers), so fixtures live as actual files
rather than inline strings.

```bash
npm install
npm test
```

## License

MIT
