'use strict';

const test = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const { RuleTester } = require('eslint');
const rule = require('../rules/no-unused-class');

const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'basic');
const CONSUMER_PATH = path.join(FIXTURES_DIR, 'Consumer.tsx');
const CONSUMER_CODE = fs.readFileSync(CONSUMER_PATH, 'utf8');

const parserOptions = {
  ecmaVersion: 2020,
  sourceType: 'module',
  ecmaFeatures: { jsx: true },
};

// The fixture uses TS type annotations, so it needs the TypeScript
// parser rather than ESLint's default (espree).
const tsParserConfig = { parser: require.resolve('@typescript-eslint/parser') };

const ruleTester = new RuleTester({ parserOptions, ...tsParserConfig });

test('no-unused-class: flags dead classes, exempts used/ignored/dynamic/global ones', () => {
  ruleTester.run('no-unused-class', rule, {
    valid: [],
    invalid: [
      {
        code: CONSUMER_CODE,
        filename: CONSUMER_PATH,
        errors: [{ messageId: 'unusedClass' }],
      },
    ],
  });
});

test('no-unused-class: markAsUsed option suppresses a specific class', () => {
  // Reset the module-level cache between assertions with different options
  // by pointing at a filename ESLint hasn't linted yet in this process --
  // simplest is a fresh RuleTester run against the same fixture.
  const tester = new RuleTester({ parserOptions, ...tsParserConfig });

  tester.run('no-unused-class (markAsUsed)', rule, {
    valid: [
      {
        code: CONSUMER_CODE,
        filename: CONSUMER_PATH,
        options: [{ markAsUsed: ['dead'] }],
      },
    ],
    invalid: [],
  });
});
