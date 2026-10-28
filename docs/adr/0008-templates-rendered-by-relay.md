# 8. Products send their own HTML; Relay renders the variables

- **Status:** Accepted

## Context

Relay serves more than one product (today Energia, later others). Each has its own e-mails, look
and wording. Relay must not know any of them, and it must not become a template registry that
every product has to deploy into before it can send.

## Decision

- The **product owns its templates** and sends them with each request: `subject`, `body` (text),
  `html` (e-mail only) and `variables`, an object of values for `{{name}}` placeholders.
- Relay **renders at the API** and stores the result. Rendering is one pass, so a value that
  contains `{{x}}` is never expanded again, and values are **HTML-escaped inside `html`** (not in
  `subject` or `body`): a recipient name like `<script>` cannot become markup.
- A placeholder with no variable is a `400` naming it, instead of an e-mail that says `{{code}}`.
  Rendering only happens when `variables` is present, so existing callers that send literal
  braces are unaffected.
- Sizes are checked after rendering. `html` is limited to 200,000 characters, `variables` to 50
  entries of strings or numbers.
- Workers and providers only see finished messages: the SES adapter sends `Text` and `Html`; SMS,
  WhatsApp and push ignore `html`.
- `metadata` (already part of the contract) is where a product says who it is, e.g.
  `{ "product": "energia", "template": "reset-code" }`.

## Consequences

- Adding a product or changing an e-mail needs no Relay deploy.
- Relay stores the rendered message, including the recipient's name, as it already stored the
  text. Variables themselves are not stored apart from the rendered output.
- Relay does not offer conditionals or loops: a product that needs them renders before sending.
- Per-message payloads are larger (an HTML e-mail is a few KB), which is fine for Kafka and
  Postgres at these sizes.
