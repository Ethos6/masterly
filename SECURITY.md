# Security policy

masterly keeps your study material, your progress and your model API key on your machine, so security reports are very welcome.

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting**: open the repository's *Security* tab and choose *Report a vulnerability*. Do not open a public issue for security problems. You will get a reply within a few days.

## What masterly already does

- The web app listens on `127.0.0.1` and refuses requests whose `Host` header is not a local name (DNS-rebinding protection).
- Every state-changing request must carry masterly's custom header and, when the browser sends one, a same-origin `Origin`; other websites cannot act on your behalf.
- The model API key is stored in `~/.masterly/config.json` (owner-only permissions) and is never sent to the browser.
- All model output and document text is escaped before display; the page runs under a strict Content-Security-Policy and cannot be framed.
- Course ids are validated before they touch the file system; uploaded file names are reduced to their base name.
- Uploads are limited to 100 MB per file and 20 million characters of text, with protection against zip bombs in DOCX and EPUB files.

## Supported versions

Security fixes go into the latest release.
