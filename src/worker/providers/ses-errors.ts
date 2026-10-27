import { classifyHttpStatus, classifyNetworkError, DeliveryError } from '../../core/delivery-error';

/** The message itself is unacceptable (e.g. unverified recipient in the sandbox). */
const PERMANENT = new Set(['MessageRejected', 'BadRequestException', 'InvalidParameterValue']);

/** Our SES account or sender is unusable right now: fail over and open the circuit. */
const ACCOUNT = new Set([
  'MailFromDomainNotVerifiedException',
  'AccountSuspendedException',
  'SendingPausedException',
  'NotFoundException', // configuration set or identity missing
]);

/** SES is throttling us: our own rate limit is set above the account's quota. */
const THROTTLING = new Set(['TooManyRequestsException', 'LimitExceededException', 'ThrottlingException']);

interface AwsLikeError {
  name?: string;
  message?: string;
  $metadata?: { httpStatusCode?: number };
}

/** Maps an AWS SDK error from SendEmail to the retry and circuit semantics of the router. */
export function classifySesError(err: unknown): DeliveryError {
  const e = (err ?? {}) as AwsLikeError;
  const name = e.name ?? 'Error';
  const detail = `ses ${name}: ${e.message ?? ''}`.slice(0, 200);
  const status = e.$metadata?.httpStatusCode;

  if (PERMANENT.has(name)) return new DeliveryError(detail, false, false, status ?? 400);
  if (ACCOUNT.has(name) || THROTTLING.has(name)) return new DeliveryError(detail, true, true, status);
  if (name === 'AbortError' || name === 'TimeoutError' || status === undefined) return classifyNetworkError(err);
  return classifyHttpStatus(status, detail);
}
