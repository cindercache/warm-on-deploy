# Security policy

## Reporting a vulnerability

Report suspected vulnerabilities in this action to **support@cindercache.com**. Please do not open a
public issue for a security report.

Include what you need to describe the problem, which is usually the version or tag affected, the
behavior you observed, and the steps that produce it. A proof of concept helps but is not required.

We aim to acknowledge your report within a few business days and to tell you whether we consider it in
scope. If a fix is warranted we will release it under a new tag and move the `v1` tag forward.

## Scope

This repository contains the GitHub Action only. It runs on your own GitHub runner and talks to the
CinderCache API over HTTPS. Reports about the API itself, the dashboard, or the marketing site are
welcome at the same address.

## What this action handles

The action reads a deploy-webhook token from an input and registers it with the runner's secret masking
before producing any other output, so an accidental echo is redacted. It sends the token as an
`Authorization: Bearer` header and never places it in a URL or writes it to a file. The action has no
dependencies and performs no network calls other than to the configured `api-base`, which must use
HTTPS.
