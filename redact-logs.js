// Masks email addresses in console output when running in CI.
// GitHub Actions logs are kept for 90 days and are public on a public repo,
// so lead addresses (including ones inside SMTP error messages) must not
// appear in them. Locally the full addresses are still shown.
//
// Import first in any script that runs in Actions:  import "./redact-logs.js";

const EMAIL_RE = /\b([a-zA-Z0-9._%+\-])[a-zA-Z0-9._%+\-]*@([a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/g;

export const redact = (s) => String(s).replace(EMAIL_RE, "$1***@$2");

if (process.env.CI) {
  for (const method of ["log", "info", "warn", "error"]) {
    const original = console[method].bind(console);
    console[method] = (...args) =>
      original(
        ...args.map((a) =>
          typeof a === "string" ? redact(a) : a instanceof Error ? redact(a.stack || a.message) : a,
        ),
      );
  }
}
