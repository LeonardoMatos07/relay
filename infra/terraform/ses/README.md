# Amazon SES for Relay (Terraform)

Everything Relay's `ses` provider needs, in one apply:

| Resource                                                                         | Why                                                                                                  |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Domain identity with **Easy DKIM** (2048-bit)                                    | Messages are signed, so receivers can trust they came from your domain                               |
| **Custom MAIL FROM** (`mail.<domain>`) with MX and SPF                           | Bounces return to your domain and SPF aligns with the From address                                   |
| **DMARC** record                                                                 | Tells receivers what to do with mail that fails DKIM/SPF, and sends you reports                      |
| Route 53 records (optional)                                                      | Created automatically when the domain is in Route 53; listed in `dns_records` otherwise              |
| **Configuration set** `relay`                                                    | TLS required, reputation metrics, suppression of bounced and complaining addresses                   |
| SES events → **SNS → SQS** (+ DLQ)                                               | Delivery, bounce and complaint events, tagged with `relay_message_id`, ready for a receipts consumer |
| **IAM policy**: `ses:SendEmail` only, from the sender only, through the set only | Least privilege for the workers                                                                      |
| IAM user + access key (optional)                                                 | For `docker compose`                                                                                 |
| IAM role for the worker service account (optional)                               | For EKS (IRSA): no keys at all                                                                       |
| Verified test recipients (optional)                                              | Sending while the account is in the SES sandbox                                                      |

## Use

```bash
cd infra/terraform/ses
cp terraform.tfvars.example terraform.tfvars    # sender, domain, test recipients
terraform init
terraform apply
```

Then wire Relay:

```bash
terraform output -raw relay_provider                  # paste into config/providers.real.json
terraform output -raw access_key_id                   # AWS_ACCESS_KEY_ID in .env
terraform output -raw secret_access_key               # AWS_SECRET_ACCESS_KEY in .env
terraform output dns_records                          # only if the domain is not in Route 53
```

Verification takes a few minutes once DNS propagates; the identity shows as verified in the
SES console. Each test recipient gets a confirmation e-mail with a link to click.

## Leaving the sandbox

New SES accounts can only send to verified addresses, about 1 message per second and
200 per day. Production access is a request to AWS, reviewed by a person, so it is not
something Terraform can apply. Request it in the SES console (_Account dashboard → Request
production access_) once DKIM is verified, describing the use case (transactional messages,
how bounces and complaints are handled: the suppression list and the events queue above).
Then raise `ratePerSecond` in the Relay providers file to the quota AWS grants.

## Notes

- The access key secret is stored in the Terraform state. Keep the state out of git (the
  repository `.gitignore` covers it) or use the encrypted S3 backend sketched in `versions.tf`.
  On EKS prefer `eks_oidc_provider_arn` and set `create_access_key = false`.
- The SNS topic is not encrypted with the AWS-managed `aws/sns` key: SES cannot publish to
  topics using it. Use a customer-managed key that allows `ses.amazonaws.com` if required.
- Start DMARC with `p=none`, read the reports for a couple of weeks, then tighten it.
