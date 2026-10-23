# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private reporting instead:
the **Security** tab of this repository, then **Report a vulnerability**. Include what you found,
how to reproduce it and which version or commit you tested. You will get an acknowledgement, and
a fix or an explanation of why it is not one, as soon as the maintainer can manage; this is a
personal project with no response-time guarantee.

## Scope and design

How authentication works, what the app trusts, what it deliberately does not defend against, and
the controls around bots, webhooks, outbound requests, custom CSS and the desktop bridge are
written down in the [trust model](docs/security/trust-model.md). Reports that show that document
to be wrong are especially useful.

Known limitations (no end-to-end encryption, trust in the host and in Tailscale's control plane)
are listed there and in the [README](README.md#limitations).

## Supported versions

Only the latest commit on `main` is maintained.
