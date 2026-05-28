'use strict';

module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  env: {
    es2020: true,
    node: true,
  },
  rules: {
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-non-null-assertion': 'off',
    '@typescript-eslint/no-require-imports': 'off',
    '@typescript-eslint/no-var-requires': 'off',
  },
  ignorePatterns: [
    'lib/',
    'dist/',
    'node_modules/',
    'run-stage2.js',
    // Stale compiled JS artifacts — .ts files are the source of truth
    'src/*.js',
    '*.js.map',
  ],
  overrides: [
    {
      // Test files + mock files get Jest globals
      files: [
        '**/__tests__/**/*.{js,ts,tsx}',
        '**/__mocks__/**/*.{js,ts,tsx}',
        '**/*.test.{js,ts,tsx}',
        '**/*.spec.{js,ts,tsx}',
      ],
      env: {
        jest: true,
      },
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
      },
    },
  ],
};
