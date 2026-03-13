import { assertBatchTransition, assertJobTransition } from './state-machine';

describe('state machine', () => {
  it('accepts valid transitions', () => {
    expect(() => assertJobTransition('UPLOADING', 'PROCESSING')).not.toThrow();
    expect(() => assertBatchTransition('QUEUED', 'RUNNING')).not.toThrow();
  });

  it('rejects invalid transitions', () => {
    expect(() => assertJobTransition('COMPLETED', 'PROCESSING')).toThrow('Invalid job status transition');
    expect(() => assertBatchTransition('SUCCEEDED', 'RUNNING')).toThrow('Invalid batch status transition');
  });
});
