// Spreadsheet formula-injection guard for CSV exports.
//
// A CSV cell whose first character is one of `= + - @` (or a leading tab / CR)
// is evaluated as a formula by Excel, Google Sheets, and LibreOffice when the
// file is opened — even when the field is RFC-4180 quoted, because the quotes
// are stripped on import before the cell content is evaluated. A low-privilege
// user who can set an exported field (a recording/schedule name, a tag, a note)
// could otherwise plant `=HYPERLINK(...)` / `@SUM(...)` / DDE payloads that run
// on a higher-privileged operator's machine when they export and open the CSV.
//
// Prefixing a single quote forces the cell to be treated as literal text. Each
// exporter keeps its own RFC-4180 quoting; this only neutralises the formula
// trigger, so non-formula values are unchanged.
const CSV_FORMULA_TRIGGER = /^[=+\-@\t\r]/u;

export function neutralizeCsvFormula(text: string): string {
  return CSV_FORMULA_TRIGGER.test(text) ? `'${text}` : text;
}
