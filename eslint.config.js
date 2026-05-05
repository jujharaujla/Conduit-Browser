const nodePlugin = require('eslint-plugin-n');

module.exports = [
  {
    ignores: ['dist/**', 'out/**', 'node_modules/**'],
  },
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        __dirname: 'readonly', __filename: 'readonly', Buffer: 'readonly',
        console: 'readonly', document: 'readonly', fetch: 'readonly',
        global: 'readonly', module: 'readonly', process: 'readonly',
        require: 'readonly', setInterval: 'readonly', setTimeout: 'readonly',
        clearInterval: 'readonly', clearTimeout: 'readonly', URL: 'readonly',
        window: 'readonly',
      },
    },
    plugins: { n: nodePlugin },
    rules: {
      'no-constant-condition': 'error',
      'no-debugger': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-unreachable': 'error',
      'no-unsafe-finally': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'n/no-missing-require': 'error',
    },
  },
];
