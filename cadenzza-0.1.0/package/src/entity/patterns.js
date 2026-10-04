/**
 * Layer 2 detection. `autoMask: true` rules are unambiguously identifying and are
 * substituted immediately. `autoMask: false` rules raise candidates for human triage
 * — that is how the gazetteer grows without ever silently redacting the wrong thing.
 */
export const RULES = [
  {
    name: 'email',
    type: 'person',
    autoMask: true,
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
  },
  {
    name: 'salesforce-id',
    type: 'other',
    autoMask: true,
    // 15-char ID, optionally + 3-char checksum drawn from A-Z0-5
    re: /\b[a-zA-Z0-9]{15}(?:[A-Z0-5]{3})?\b/g,
    // Known key prefix, and at least two digits so plain words ("accomplishments") never match
    guard: (s) => /^(00[0-9A-Za-z]|a[0-9A-Za-z]{2}|500|006|003|001|012|005)/.test(s) && /\d.*\d/.test(s)
  },
  {
    name: 'jira-key',
    type: 'project',
    autoMask: false,
    re: /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g
  },
  {
    name: 'legal-entity',
    type: 'org',
    autoMask: false,
    // A capitalised token (or two) followed by a legal suffix: "Northwind AG", "Acme Holding GmbH"
    re: /\b(?:[A-Z][\w.&'-]{1,20}\s+){1,3}(?:SE|AG|GmbH|S\.A\.|SRL|S\.R\.L\.|PLC|plc|N\.V\.|NV|S\.p\.A\.|SpA|Ltd|Limited|Inc|LLC|BV|B\.V\.|Oy|AB|A\/S)\b/g
  },
  {
    name: 'internal-host',
    type: 'host',
    autoMask: true,
    re: /\b(?:[a-z0-9-]+\.)+(?:internal|intranet|local|corp|lan|test|dev|uat|sit|prod)\b/gi
  },
  {
    name: 'ipv4',
    type: 'host',
    autoMask: true,
    re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g
  },
  {
    name: 'iban',
    type: 'other',
    autoMask: true,
    re: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g
  },
  {
    name: 'vat',
    type: 'other',
    autoMask: true,
    re: /\b(?:VAT|CUI|CIF|USt-IdNr\.?)[:\s]*[A-Z]{0,2}\d{6,12}\b/gi
  }
];

/** Run every rule over text. Returns [{ rule, type, surface, start, end, autoMask }] */
export function detectPatterns(text) {
  const hits = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text)) !== null) {
      const surface = m[0];
      if (rule.guard && !rule.guard(surface)) continue;
      hits.push({
        rule: rule.name,
        type: rule.type,
        surface,
        start: m.index,
        end: m.index + surface.length,
        autoMask: rule.autoMask
      });
      if (m.index === rule.re.lastIndex) rule.re.lastIndex++;
    }
  }
  return hits.sort((a, b) => a.start - b.start);
}
