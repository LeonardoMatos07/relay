import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { classifySesError } from './ses-errors';

const awsError = (name: string, status?: number) =>
  Object.assign(new Error(`${name} happened`), { name, $metadata: { httpStatusCode: status } });

describe('classifySesError', () => {
  it('treats a rejected message (e.g. unverified recipient in the sandbox) as permanent', () => {
    const e = classifySesError(awsError('MessageRejected', 400));
    assert.equal(e.retryable, false);
    assert.equal(e.countsAgainstProvider, false);
  });

  it('fails over when the account or sender is unusable', () => {
    for (const name of ['MailFromDomainNotVerifiedException', 'AccountSuspendedException', 'SendingPausedException']) {
      const e = classifySesError(awsError(name, 400));
      assert.equal(e.retryable, true, name);
      assert.equal(e.countsAgainstProvider, true, name);
    }
  });

  it('retries throttling and server errors', () => {
    assert.equal(classifySesError(awsError('TooManyRequestsException', 429)).retryable, true);
    assert.equal(classifySesError(awsError('InternalFailure', 500)).retryable, true);
  });

  it('treats timeouts and errors without a status as network errors', () => {
    assert.match(classifySesError(awsError('TimeoutError')).message, /network error/);
    assert.equal(classifySesError(new Error('socket hang up')).retryable, true);
  });
});
