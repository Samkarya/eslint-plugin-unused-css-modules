'use strict';

const noUnusedClass = require('./rules/no-unused-class');

module.exports = {
  rules: {
    'no-unused-class': noUnusedClass,
  },
  configs: {
    recommended: {
      plugins: ['unused-css-modules'],
      rules: {
        'unused-css-modules/no-unused-class': 'warn',
      },
    },
  },
};
