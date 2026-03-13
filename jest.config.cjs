/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/apps', '<rootDir>/packages'],
  moduleNameMapper: {
    '^@mem9/config$': '<rootDir>/packages/config/src',
    '^@mem9/contracts$': '<rootDir>/packages/contracts/src',
    '^@mem9/shared$': '<rootDir>/packages/shared/src',
  },
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverageFrom: [
    'apps/**/*.ts',
    'packages/**/*.ts',
    '!**/*.spec.ts',
    '!**/main.ts',
    '!**/index.ts',
  ],
};
