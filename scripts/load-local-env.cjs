'use strict';

const { resolve } = require('node:path');

// Resolve from the repository, even when a workspace command runs in apps/*.
// Existing environment variables take precedence over this local file.
try {
  process.loadEnvFile(resolve(__dirname, '../.env'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
