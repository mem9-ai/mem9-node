import { loadApiIngressConfig } from './api-ingress';

describe('API ingress configuration', () => {
  it('enables bounded admission without trusting forwarded headers by default', () => {
    expect(loadApiIngressConfig({})).toEqual({
      trustedProxyCidrs: [],
      ipRequestsPerSecond: 20,
      ipBurst: 100,
      totalRequestsPerSecond: 100,
      totalBurst: 300,
    });
  });
  it('accepts explicit proxy addresses and CIDRs', () => {
    expect(
      loadApiIngressConfig({
        PREAUTH_TRUSTED_PROXY_CIDRS: '10.0.1.0/24, 10.0.2.1,fd00::/64',
      }).trustedProxyCidrs,
    ).toEqual(['10.0.1.0/24', '10.0.2.1', 'fd00::/64']);
  });
  it.each([
    'true',
    '*',
    '0.0.0.0/0',
    '::/0',
    '10.0.0.0/33',
    '::/129',
    '10.0.0.0/-1',
    '10.0.0.0/24/extra',
  ])('rejects invalid or universal proxy trust %s', (value) => {
    expect(() =>
      loadApiIngressConfig({ PREAUTH_TRUSTED_PROXY_CIDRS: value }),
    ).toThrow();
  });
  it.each([
    'PREAUTH_IP_REQUESTS_PER_SECOND',
    'PREAUTH_IP_BURST',
    'PREAUTH_TOTAL_REQUESTS_PER_SECOND',
    'PREAUTH_TOTAL_BURST',
  ])('rejects disabling admission through %s', (key) => {
    for (const value of ['0', '-1', 'NaN', 'Infinity', '10001']) {
      expect(() => loadApiIngressConfig({ [key]: value })).toThrow();
    }
  });
});
