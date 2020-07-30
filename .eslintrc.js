module.exports = {
  env: {
    node: true,
    mocha: true,
  },
  extends: [
    'plugin:node/recommended',
    'airbnb-base',
  ],
  rules: {
    'no-param-reassign': ['error', { props: false }],
  },
  overrides: [
    {
      files: ['*.spec.js'],
      rules: {
        'node/no-unpublished-require': 'off',
      },
    },
  ],
};
