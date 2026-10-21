// These reports are publishable only because their inputs are invented. There is
// deliberately no recorder/import path for production Notion, Gmail or portal data.
export function assertSyntheticReport(report) {
  const text = JSON.stringify(report);
  for (const email of text.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []) {
    if (!/@(?:company\.example|example\.(?:invalid|test|com))$/i.test(email)) throw Error('Replay report contains a non-synthetic email address; export blocked');
  }
  if (/(?:sk-ant-|ghp_|gho_|xoxb-[0-9]|sk_live_)[A-Za-z0-9_-]{12,}/.test(text)) throw Error('Replay report contains a credential-shaped value; export blocked');
  return report;
}
