'use strict';

const { accessSync, constants } = require('node:fs');

function databaseTlsUrl(env) {
  const certificate = env.DATABASE_TLS_CA_FILE;
  if (!certificate) return env.DATABASE_URL;
  // Fail before starting the application or migration if the packaged CA is missing.
  accessSync(certificate, constants.R_OK);
  const connection = new URL(env.DATABASE_URL);
  if (connection.protocol !== 'mysql:') throw new Error('Expected a MySQL connection');
  connection.searchParams.set('sslcert', certificate);
  connection.searchParams.set('sslaccept', 'strict');
  return connection.toString();
}

module.exports = { databaseTlsUrl };

if (require.main === module) {
  try {
    process.stdout.write(databaseTlsUrl(process.env) || '');
  } catch {
    // Never include the connection URL, credentials, or raw parser error.
    process.stderr.write('Database TLS configuration is invalid or its CA file is unreadable\n');
    process.exitCode = 1;
  }
}
