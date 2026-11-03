# Amazon RDS trust store

`rds-global-bundle.pem` contains public CA certificates downloaded on 2026-11-03
from https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem.

SHA-256: `90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b`

Both service images copy the complete `prisma` directory. The shared entrypoint
uses this bundle with Prisma's `sslcert` and `sslaccept=strict` options when
`DATABASE_TLS_CA_FILE` is configured, including for migration commands. The
existing database credentials remain in Secrets Manager and are not rotated.

To update the trust store, download the bundle from the same official HTTPS URL,
review its CA subjects, expiry dates and digest, then repeat the real RDS TLS
positive test and wrong-CA/wrong-hostname negative tests before rollout. Do not
replace strict verification with `accept_invalid_certs`.
