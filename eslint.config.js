import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/', 'dist-test/', 'node_modules/'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      'max-len': ['error', { code: 140 }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }]
    }
  }
)
