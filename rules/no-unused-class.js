'use strict';

const fs = require('fs');
const path = require('path');

const CODE_EXT_RE = /\.(tsx|ts|jsx|js)$/;

/**
 * Removes block/line comments and the CONTENTS of quoted strings (keeping
 * empty quotes) so that things like `@use '../foo.scss' as bar;` or
 * `content: "some.text";` never get misread as class selectors.
 *
 * Every replacement preserves the original character count and newline
 * positions (comments become blank-filled but same-length spans, quoted
 * contents become space-padded), so an index into the cleaned string is
 * still a valid index into the original source -- this is what lets
 * extractClassNames() report accurate line/column numbers.
 */
function stripStringsAndComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|\s)\/\/.*$/gm, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/'(?:\\.|[^'\\])*'/g, (m) => `'${' '.repeat(m.length - 2)}'`)
    .replace(/"(?:\\.|[^"\\])*"/g, (m) => `"${' '.repeat(m.length - 2)}"`);
}

/**
 * True if the `.` at `dotIndex` in `text` is a SCSS namespaced member
 * access (`mixins.flex-center`, `mixins.media-breakpoint-down(sm)`,
 * `math.div(...)`) rather than a real CSS class selector.
 *
 * The distinguishing pattern: a real class selector's dot is either at
 * the very start of a selector, or immediately follows ANOTHER
 * dot-prefixed class in a compound chain (`.foo.bar` -- `bar`'s dot is
 * preceded by `foo`, and `foo` is itself preceded by a dot). A
 * namespace access's dot is preceded by a bare identifier that has NO
 * leading dot of its own (`mixins`, `variables`, `math`). Checking this
 * -- rather than what comes AFTER the dot -- correctly handles
 * parenthesis-less mixin calls like `@include mixins.flex-center;` that
 * a "followed by (" check would miss.
 */
function isNamespaceAccess(text, dotIndex) {
  let i = dotIndex - 1;
  let sawWordChar = false;
  while (i >= 0 && /[a-zA-Z0-9_-]/.test(text[i])) {
    sawWordChar = true;
    i--;
  }
  if (!sawWordChar) return false; // dot at selector-start position
  if (i >= 0 && text[i] === '.') return false; // compound class chain
  return true; // bare identifier directly before the dot -> namespace access
}

/**
 * Precomputes the character offset where each line starts, so repeated
 * offset -> {line, column} lookups don't each re-scan the whole file.
 */
function buildLineStarts(source) {
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') lineStarts.push(i + 1);
  }
  return lineStarts;
}

/** Converts a character offset into a 1-based {line, column}. */
function offsetToLineColumn(lineStarts, offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - lineStarts[lo] + 1 };
}

// Written directly in the .scss file, either on the same line as the
// selector or on the line immediately above it, to mark a class as
// intentionally dynamic without touching ESLint config at all:
//   .feature { // css-modules-ignore-unused
//     ...
//   }
// or:
//   /* css-modules-ignore-unused */
//   .feature {
const IGNORE_MARKER_RE = /css-modules-ignore-unused/i;

/**
 * True if the line containing (or immediately preceding) `lineNumber`
 * carries the ignore-marker comment. Checked against the raw,
 * un-stripped source lines, since the marker IS a comment.
 */
function hasIgnoreMarker(rawLines, lineNumber) {
  const ownLine = rawLines[lineNumber - 1] || '';
  const lineAbove = rawLines[lineNumber - 2] || '';
  return IGNORE_MARKER_RE.test(ownLine) || IGNORE_MARKER_RE.test(lineAbove);
}

/**
 * Finds the character ranges (in `cleaned` source offsets) spanned by
 * `:global(...)` wrappers. CSS Modules leaves whatever is inside
 * `:global(...)` unhashed, so it's a real, plain CSS class -- consumed
 * as a bare string (e.g. a class some third-party component or global
 * animation hooks into), never through the `styles` import. Classes
 * found inside these ranges are therefore not "module classes" at all
 * and shouldn't be held to the used-via-`styles.x` check.
 */
function findGlobalRanges(cleaned) {
  const ranges = [];
  const globalRe = /:global\s*\(/g;
  let m;
  while ((m = globalRe.exec(cleaned)) !== null) {
    const start = m.index;
    let depth = 1;
    let i = m.index + m[0].length; // just past the opening '('
    while (i < cleaned.length && depth > 0) {
      if (cleaned[i] === '(') depth++;
      else if (cleaned[i] === ')') depth--;
      i++;
    }
    ranges.push([start, i]); // end is exclusive, one past the closing ')'
  }
  return ranges;
}

function isWithinRanges(ranges, index) {
  return ranges.some(([start, end]) => index >= start && index < end);
}

/**
 * Extracts class selector names from SCSS/CSS source, along with the
 * {line, column} of each class's first (i.e. defining) occurrence, so
 * callers can point the user straight at the relevant line, and whether
 * that occurrence carries an ignore-marker comment (see
 * IGNORE_MARKER_RE). Heuristic, not a real parser: pulls `.identifier`
 * tokens that are in selector position, skipping SCSS namespaced
 * function/mixin calls (see isNamespaceAccess) and `:global(...)`
 * classes (see findGlobalRanges), neither of which are module classes.
 */
function extractClassNames(source) {
  const cleaned = stripStringsAndComments(source);
  const lineStarts = buildLineStarts(source);
  const rawLines = source.split('\n');
  const globalRanges = findGlobalRanges(cleaned);
  const classes = new Map(); // className -> {line, column, ignored}
  const classToken = /\.([a-zA-Z_-][a-zA-Z0-9_-]*)/g;
  let match;
  while ((match = classToken.exec(cleaned)) !== null) {
    if (isNamespaceAccess(cleaned, match.index)) continue;
    if (isWithinRanges(globalRanges, match.index)) continue;
    if (!classes.has(match[1])) {
      const pos = offsetToLineColumn(lineStarts, match.index);
      classes.set(match[1], {
        ...pos,
        ignored: hasIgnoreMarker(rawLines, pos.line),
      });
    }
  }
  return classes;
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Turns the contents of a template literal (e.g. `diff${diff}` or
 * `${prefix}-active`) into a RegExp that treats every `${...}`
 * interpolation as a wildcard, so a class name can be tested against
 * the static parts the source actually reveals.
 */
function templateContentToRegex(templateContent) {
  const staticParts = templateContent.split(/\$\{[^}]*\}/);
  const pattern = staticParts.map(escapeRegExp).join('[\\s\\S]*');
  return new RegExp(`^${pattern}$`);
}

/**
 * True if `className` could be produced by some `ident[\`...\`]`
 * template-literal bracket access in `sourceText` -- e.g.
 * `styles[\`diff${diff}\`]` covers `diffEasy`, `diffMedium`, `diffHard`.
 * This is necessarily a heuristic: since the interpolated part is
 * dynamic, we can only confirm the class name is *consistent* with the
 * static parts of the template, not that it's definitely reachable.
 */
function isClassUsedViaTemplate(sourceText, ident, className) {
  const templateAccessRe = new RegExp(
    `\\b${escapeRegExp(ident)}\\s*\\[\\s*\`([^\`]*)\`\\s*\\]`,
    'g'
  );
  let match;
  while ((match = templateAccessRe.exec(sourceText)) !== null) {
    const templateContent = match[1];
    if (!templateContent.includes('${')) continue; // no interpolation; handled by bracketAccess
    if (templateContentToRegex(templateContent).test(className)) {
      return true;
    }
  }
  return false;
}

function isClassUsed(sourceText, ident, className) {
  const dotAccess = new RegExp(
    `\\b${escapeRegExp(ident)}\\.${escapeRegExp(className)}\\b`
  );
  const bracketAccess = new RegExp(
    `\\b${escapeRegExp(ident)}\\s*\\[\\s*['"\`]${escapeRegExp(
      className
    )}['"\`]\\s*\\]`
  );
  return (
    dotAccess.test(sourceText) ||
    bracketAccess.test(sourceText) ||
    isClassUsedViaTemplate(sourceText, ident, className)
  );
}

function findImportInFile(content, scssAbsPath, fileDir) {
  const importRe =
    /import\s+(?:\*\s+as\s+)?([a-zA-Z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = importRe.exec(content)) !== null) {
    const [, ident, importPath] = m;
    if (!importPath.startsWith('.')) continue;
    if (path.resolve(fileDir, importPath) === scssAbsPath) {
      return ident;
    }
  }
  return null;
}

/**
 * Finds every code file in the same directory as the scss module that
 * imports it, so a class shared across sibling files (e.g. several page
 * components pulling from one StaticPages.module.scss) isn't flagged
 * just because one of them doesn't happen to use it.
 */
function findSiblingImporters(scssAbsPath) {
  const dir = path.dirname(scssAbsPath);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const importers = [];
  for (const entry of entries) {
    if (!CODE_EXT_RE.test(entry)) continue;
    const filePath = path.join(dir, entry);
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    const ident = findImportInFile(content, scssAbsPath, dir);
    if (ident) {
      importers.push({ file: filePath, ident, content });
    }
  }
  return importers;
}

// Cache per scss file for the lifetime of one ESLint run, since many
// sibling files trigger the same computation otherwise.
const moduleCache = new Map();

function computeModuleUsage(scssAbsPath, currentFile, currentContent, currentIdent) {
  if (moduleCache.has(scssAbsPath)) {
    return moduleCache.get(scssAbsPath);
  }

  let scssSource;
  try {
    scssSource = fs.readFileSync(scssAbsPath, 'utf8');
  } catch {
    const empty = {
      classNames: [],
      classPositions: new Map(),
      usedClasses: new Set(),
      importers: [],
    };
    moduleCache.set(scssAbsPath, empty);
    return empty;
  }

  const classPositions = extractClassNames(scssSource);
  const importers = findSiblingImporters(scssAbsPath);

  // Make sure the file currently being linted is counted even if, for
  // whatever reason, the directory scan didn't pick it up (e.g. a
  // module imported from outside its own directory).
  if (!importers.some((i) => i.file === currentFile)) {
    importers.push({ file: currentFile, ident: currentIdent, content: currentContent });
  }

  const usedClasses = new Set();
  for (const [className, pos] of classPositions) {
    const used =
      pos.ignored ||
      importers.some(({ content, ident }) => isClassUsed(content, ident, className));
    if (used) usedClasses.add(className);
  }

  const result = {
    classNames: Array.from(classPositions.keys()),
    classPositions,
    usedClasses,
    importers,
  };
  moduleCache.set(scssAbsPath, result);
  return result;
}

module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow CSS Module classes that are defined in a *.module.scss file but never referenced in any file that imports it.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          markAsUsed: {
            type: 'array',
            items: { type: 'string' },
          },
          extensions: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      unusedClass:
        "Class '.{{className}}' is defined at {{scssLocation}} but never used in any of the {{importerCount}} file(s) that import it here. If it's used dynamically, add it to this rule's markAsUsed option.",
    },
  },

  create(context) {
    const options = context.options[0] || {};
    const markAsUsed = new Set(options.markAsUsed || []);
    const extensions = options.extensions || [
      'module.scss',
      'module.sass',
      'module.css',
    ];
    const extensionPattern = new RegExp(
      `\\.(${extensions.map(escapeRegExp).join('|')})$`
    );

    const filename = context.getFilename();
    if (filename === '<input>' || filename === '<text>') return {};

    return {
      ImportDeclaration(node) {
        const importPath = node.source.value;
        if (typeof importPath !== 'string') return;
        if (!extensionPattern.test(importPath)) return;
        if (!importPath.startsWith('.')) return;

        let ident = null;
        for (const specifier of node.specifiers) {
          if (
            specifier.type === 'ImportDefaultSpecifier' ||
            specifier.type === 'ImportNamespaceSpecifier'
          ) {
            ident = specifier.local.name;
            break;
          }
        }
        if (!ident) return;

        const scssAbsPath = path.resolve(path.dirname(filename), importPath);
        const currentContent = context.getSourceCode().getText();

        const { classNames, classPositions, usedClasses, importers } =
          computeModuleUsage(scssAbsPath, filename, currentContent, ident);

        // Only the alphabetically-first importer reports, so a class
        // shared (and dead) across N sibling files produces one set of
        // warnings instead of N duplicates.
        const sortedFiles = importers.map((i) => i.file).sort();
        const isDesignatedReporter = sortedFiles[0] === filename;
        if (!isDesignatedReporter) return;

        for (const className of classNames) {
          if (markAsUsed.has(className)) continue;
          if (!usedClasses.has(className)) {
            const pos = classPositions.get(className);
            // `path:line:column` is the format most editors/terminals
            // (VS Code included) auto-linkify in output, so clicking
            // this jumps straight to the dead rule in the scss file.
            const scssLocation = pos
              ? `${scssAbsPath}:${pos.line}:${pos.column}`
              : scssAbsPath;
            context.report({
              node,
              messageId: 'unusedClass',
              data: {
                className,
                scssLocation,
                importerCount: importers.length,
              },
            });
          }
        }
      },
    };
  },
};