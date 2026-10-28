# 7. Delivery receipts from providers, forward-only status and a suppression list

- **Status:** Accepted

## Context

`delivered` in Relay means a provider accepted the message. SES then reports Delivery, Bounce or
Complaint minutes later, and Twilio does the same through status callbacks. Without them Relay
cannot tell the sender a message bounced, and keeps mailing addresses that bounce, which hurts
the sending reputation and can get the account suspended.

## Decision

- Providers' callbacks are translated **outside Relay** (relay-receipts Lambdas) into one neutral
  receipt: id, provider, provider message id, Relay message id, type
  (`sent | delivered | delayed | bounced | complained | rejected`), permanence and reason.
  Relay's API knows one format, whichever provider sent it.
- `POST /v1/receipts` finds the message by the `relay_message_id` tag the adapter puts on every
  send, or else by provider + provider message id, in one transaction that locks the message row.
- **Idempotent by receipt id** (`INSERT ... ON CONFLICT DO NOTHING`): queues deliver at least
  once, so a repeated receipt answers `200` and changes nothing.
- `delivery_status` is **ranked and only moves forward**
  (sent < delayed < delivered < bounced/rejected < complained). Events arrive out of order; a
  late `sent` cannot undo `delivered`.
- A **permanent bounce or a complaint** inserts the recipient in `suppressions`. A later
  `POST /v1/messages` for it answers `422` before anything is written. A transient bounce does not
  suppress. `DELETE /v1/suppressions/:channel/:recipient` lifts it. Email addresses are compared
  lowercase; phone numbers are not altered.

## Consequences

- Message status has two axes: `status` (what Relay did) and `delivery_status` (what the
  recipient's side did).
- A receipt for an unknown message answers `404`, and the Lambda drops it instead of retrying.
- Suppression is checked at the API only; messages already queued before the bounce still go out.
- Adding a provider means a translator that publishes the neutral receipt; Relay does not change.
