'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'public/**',
      'storage/**',
      'bandeja_escaner/**',
      'scripts/**',
      'backups/**'
    ]
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.commonjs }
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['warn', { args: 'none', argsIgnorePattern: '^_' }],
      'no-useless-assignment': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-constant-condition': 'off',
      'no-control-regex': 'off',
      'no-useless-escape': 'off',
      'no-useless-catch': 'off',
      'no-fallthrough': 'off',
      'no-self-assign': 'off',
      'no-prototype-builtins': 'off'
    }
  }
];