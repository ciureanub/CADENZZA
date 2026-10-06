/**
 * Seeded deliverable templates. Each is a real starting structure with inline guidance,
 * not an empty page. Guidance is rendered in <em class="hint"> and is meant to be deleted.
 */
const h = (s) => s.trim();

export const TEMPLATES = [
/* ---------------------------------- RELEASE ---------------------------------- */
{
  area: 'release', key: 'release-plan', title: 'Release Plan — <release name>',
  html: h(`
<h2>1. Release identity</h2>
<table><tbody>
<tr><td>Release ID / train</td><td></td></tr>
<tr><td>Target window</td><td></td></tr>
<tr><td>Release manager</td><td></td></tr>
<tr><td>Business sponsor</td><td></td></tr>
</tbody></table>
<h2>2. Scope</h2>
<p><em class="hint">Link the epics and stories. Anything not listed here is out of scope by definition.</em></p>
<ul><li></li></ul>
<h2>3. Dependencies and sequencing</h2>
<p><em class="hint">Upstream systems, integration partners, data migrations, third-party windows.</em></p>
<h2>4. Entry and exit criteria</h2>
<table><tbody><tr><td>Entry</td><td></td></tr><tr><td>Exit</td><td></td></tr></tbody></table>
<h2>5. Environments and path to live</h2>
<p><em class="hint">Reference the environment matrix rather than restating it: [[Environment Inventory Matrix]]</em></p>
<h2>6. Risks</h2>
<p><em class="hint">Summary only — the detail lives in [[RAID Log]].</em></p>
<h2>7. Approvals</h2>
<table><tbody><tr><td>Role</td><td>Name</td><td>Date</td></tr><tr><td></td><td></td><td></td></tr></tbody></table>`)
},
{
  area: 'release', key: 'go-no-go', title: 'Go / No-Go Decision Record',
  html: h(`
<h2>Decision</h2>
<table><tbody>
<tr><td>Release</td><td></td></tr>
<tr><td>Meeting held</td><td></td></tr>
<tr><td>Chair</td><td></td></tr>
<tr><td><strong>Decision</strong></td><td><strong>GO / NO-GO / CONDITIONAL GO</strong></td></tr>
</tbody></table>
<h2>Gate checklist</h2>
<table><tbody>
<tr><td>Gate</td><td>Owner</td><td>Status</td><td>Evidence</td></tr>
<tr><td>All scope items code-complete and merged</td><td></td><td></td><td></td></tr>
<tr><td>Validation deploy green in pre-prod</td><td></td><td></td><td></td></tr>
<tr><td>Test exit criteria met, defects triaged</td><td></td><td></td><td></td></tr>
<tr><td>Rollback tested and timed</td><td></td><td></td><td></td></tr>
<tr><td>Cutover plan rehearsed</td><td></td><td></td><td></td></tr>
<tr><td>Hypercare roster confirmed</td><td></td><td></td><td></td></tr>
<tr><td>Comms issued to stakeholders</td><td></td><td></td><td></td></tr>
<tr><td>Change record approved</td><td></td><td></td><td></td></tr>
</tbody></table>
<h2>Open risks accepted at go</h2>
<p><em class="hint">Name each one and who accepted it. This is the part people are grateful for six weeks later.</em></p>
<h2>Conditions attached to a conditional go</h2>
<h2>Attendees and sign-off</h2>`)
},
{
  area: 'release', key: 'raid', title: 'RAID Log',
  html: h(`
<p><em class="hint">Risks · Assumptions · Issues · Dependencies. One row per item, owner mandatory, review weekly.</em></p>
<table><tbody>
<tr><td>ID</td><td>Type</td><td>Description</td><td>Impact</td><td>Likelihood</td><td>Owner</td><td>Mitigation</td><td>Status</td></tr>
<tr><td>R-01</td><td>Risk</td><td></td><td></td><td></td><td></td><td></td><td>Open</td></tr>
</tbody></table>`)
},
{
  area: 'release', key: 'cutover-plan', title: 'Cutover Plan',
  html: h(`
<p><em class="hint">Timed, owner-per-step, with a named abort point. Rehearse it before you need it.</em></p>
<table><tbody>
<tr><td>#</td><td>T-minus</td><td>Step</td><td>Owner</td><td>Duration</td><td>Depends on</td><td>Verification</td><td>Status</td></tr>
<tr><td>1</td><td>T-24h</td><td>Freeze confirmed, branch cut</td><td></td><td></td><td></td><td></td><td></td></tr>
<tr><td>2</td><td>T-2h</td><td>Pre-deployment steps executed</td><td></td><td></td><td></td><td></td><td></td></tr>
<tr><td>3</td><td>T-0</td><td>Deployment starts</td><td></td><td></td><td></td><td></td><td></td></tr>
<tr><td>4</td><td>T+30m</td><td>Smoke tests</td><td></td><td></td><td></td><td></td><td></td></tr>
<tr><td>5</td><td>T+1h</td><td><strong>Abort decision point</strong></td><td></td><td></td><td></td><td></td><td></td></tr>
</tbody></table>
<h2>Abort criteria</h2>
<h2>Communication points</h2>`)
},
{
  area: 'release', key: 'pir', title: 'Post-Implementation Review',
  html: h(`
<h2>Outcome</h2>
<table><tbody>
<tr><td>Planned window</td><td></td></tr><tr><td>Actual window</td><td></td></tr>
<tr><td>Rollbacks</td><td></td></tr><tr><td>Post-release defects (P1/P2)</td><td></td></tr>
</tbody></table>
<h2>What worked</h2><h2>What did not</h2>
<h2>Actions</h2>
<table><tbody><tr><td>Action</td><td>Owner</td><td>Due</td></tr><tr><td></td><td></td><td></td></tr></tbody></table>`)
},
{
  area: 'release', key: 'dora', title: 'DORA Scorecard',
  html: h(`
<p><em class="hint">Four metrics, per release train, with an evidence link on every number. A metric without a source is an opinion.</em></p>
<table><tbody>
<tr><td>Metric</td><td>Current</td><td>Previous</td><td>Trend</td><td>Evidence</td></tr>
<tr><td>Deployment frequency</td><td></td><td></td><td></td><td></td></tr>
<tr><td>Lead time for changes</td><td></td><td></td><td></td><td></td></tr>
<tr><td>Change failure rate</td><td></td><td></td><td></td><td></td></tr>
<tr><td>Time to restore service</td><td></td><td></td><td></td><td></td></tr>
</tbody></table>`)
},
/* -------------------------------- DEPLOYMENT --------------------------------- */
{
  area: 'deployment', key: 'deployment-runbook', title: 'Deployment Runbook',
  html: h(`
<h2>Scope of this deployment</h2>
<table><tbody><tr><td>Source branch</td><td></td></tr><tr><td>Target environment</td><td></td></tr>
<tr><td>Package type</td><td>delta / full</td></tr><tr><td>Approver</td><td></td></tr></tbody></table>
<h2>Pre-deployment steps</h2>
<p><em class="hint">Manual configuration, feature flags off, dependency deploys, data prep.</em></p>
<ol><li></li></ol>
<h2>Deployment</h2>
<pre><code># commands, exactly as run</code></pre>
<h2>Post-deployment steps</h2>
<ol><li></li></ol>
<h2>Verification</h2>
<h2>Rollback</h2>
<p><em class="hint">Tested? When? How long did it take?</em></p>`)
},
{
  area: 'deployment', key: 'delta-manifest', title: 'Delta Package Manifest',
  html: h(`
<table><tbody>
<tr><td>Base ref</td><td></td></tr><tr><td>Head ref</td><td></td></tr>
<tr><td>Generated</td><td></td></tr><tr><td>Component count</td><td></td></tr>
</tbody></table>
<h2>Added / modified</h2><pre><code></code></pre>
<h2>Destructive changes</h2>
<p><em class="hint">Reviewed by a second pair of eyes. Always.</em></p>
<pre><code></code></pre>
<h2>Excluded by policy</h2>`)
},
{
  area: 'deployment', key: 'pipeline-definition', title: 'Pipeline Definition',
  html: h(`
<h2>Stages</h2>
<table><tbody><tr><td>Stage</td><td>Trigger</td><td>Gate</td><td>Owner</td></tr>
<tr><td>validate</td><td>MR opened</td><td></td><td></td></tr>
<tr><td>deploy-sit</td><td>merge to develop</td><td></td><td></td></tr>
<tr><td>deploy-uat</td><td>manual</td><td></td><td></td></tr>
<tr><td>deploy-prod</td><td>manual + approval</td><td></td><td></td></tr></tbody></table>
<h2>Configuration</h2><pre><code></code></pre>
<h2>Secrets and variables</h2>
<p><em class="hint">Names and where they live. Never values.</em></p>`)
},
{
  area: 'deployment', key: 'smoke-checklist', title: 'Smoke Test Checklist',
  html: h(`
<table><tbody><tr><td>#</td><td>Check</td><td>Expected</td><td>Owner</td><td>Result</td></tr>
<tr><td>1</td><td>Login and landing page</td><td></td><td></td><td></td></tr>
<tr><td>2</td><td>Critical business flow end to end</td><td></td><td></td><td></td></tr>
<tr><td>3</td><td>Integration heartbeat</td><td></td><td></td><td></td></tr>
<tr><td>4</td><td>Scheduled jobs running</td><td></td><td></td><td></td></tr></tbody></table>`)
},
{
  area: 'deployment', key: 'change-record', title: 'Change Record (RFC)',
  html: h(`
<table><tbody>
<tr><td>Change number</td><td></td></tr><tr><td>Type</td><td>standard / normal / emergency</td></tr>
<tr><td>Risk</td><td></td></tr><tr><td>Window</td><td></td></tr>
<tr><td>CAB date</td><td></td></tr><tr><td>Approval status</td><td></td></tr>
</tbody></table>
<h2>Reason for change</h2><h2>Implementation plan</h2>
<h2>Back-out plan</h2><h2>Test evidence</h2>`)
},
/* ------------------------------- ENVIRONMENT --------------------------------- */
{
  area: 'environment', key: 'env-matrix', title: 'Environment Inventory Matrix',
  html: h(`
<p><em class="hint">The single most useful page in this space. Keep it current or delete it — a stale matrix is worse than none.</em></p>
<table><tbody>
<tr><td>Name</td><td>Type</td><td>Purpose</td><td>Owner</td><td>Refresh cadence</td><td>Data class</td><td>Expires</td></tr>
<tr><td>SIT</td><td></td><td>Integration testing</td><td></td><td></td><td></td><td></td></tr>
<tr><td>UAT</td><td></td><td>Business acceptance</td><td></td><td></td><td></td><td></td></tr>
<tr><td>PROD</td><td></td><td>Live</td><td></td><td></td><td>—</td><td>—</td></tr>
</tbody></table>`)
},
{
  area: 'environment', key: 'refresh-runbook', title: 'Environment Refresh Runbook',
  html: h(`
<h2>Pre-refresh</h2>
<p><em class="hint">What must be captured before the environment is overwritten: config, connected apps, users, custom settings, scheduled jobs.</em></p>
<ol><li></li></ol>
<h2>Refresh</h2><ol><li></li></ol>
<h2>Post-refresh</h2>
<p><em class="hint">Data masking, integration re-point, user re-activation, job re-schedule. This is where refreshes go wrong.</em></p>
<ol><li></li></ol>
<h2>Verification</h2><h2>Typical duration</h2>`)
},
{
  area: 'environment', key: 'masking-plan', title: 'Data Seeding and Masking Plan',
  html: h(`
<h2>Legal basis</h2>
<p><em class="hint">Production data in a lower environment needs a stated basis and a masking standard. Pseudonymised data is still personal data.</em></p>
<h2>Fields in scope</h2>
<table><tbody><tr><td>Object</td><td>Field</td><td>Classification</td><td>Treatment</td></tr>
<tr><td></td><td></td><td></td><td>mask / null / synthesise / retain</td></tr></tbody></table>
<h2>Seed data sets</h2><h2>Verification</h2>`)
},
{
  area: 'environment', key: 'drift-report', title: 'Configuration Drift Report',
  html: h(`
<table><tbody><tr><td>Component</td><td>Expected</td><td>Actual</td><td>Environment</td><td>Detected</td><td>Action</td></tr>
<tr><td></td><td></td><td></td><td></td><td></td><td></td></tr></tbody></table>
<h2>Root cause</h2><h2>Prevention</h2>`)
},
{
  area: 'environment', key: 'endpoint-matrix', title: 'Integration Endpoint Matrix',
  html: h(`
<table><tbody>
<tr><td>Integration</td><td>Direction</td><td>Protocol</td><td>Endpoint (per env)</td><td>Auth</td><td>Owner</td><td>Runbook</td></tr>
<tr><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
</tbody></table>
<p><em class="hint">Endpoints are prime candidates for pseudonymisation before this page leaves the machine.</em></p>`)
},
/* ------------------------------- STAKEHOLDER --------------------------------- */
{
  area: 'stakeholder', key: 'stakeholder-register', title: 'Stakeholder Register',
  html: h(`
<table><tbody>
<tr><td>Name</td><td>Role</td><td>Organisation</td><td>Interest</td><td>Influence</td><td>Stance</td><td>Owner</td></tr>
<tr><td></td><td></td><td></td><td>H/M/L</td><td>H/M/L</td><td>champion / neutral / blocker</td><td></td></tr>
</tbody></table>
<p><em class="hint">Personal data. Defaults to Client-Confidential and routes through Entity Guard.</em></p>`)
},
{
  area: 'stakeholder', key: 'raci', title: 'RACI Matrix',
  html: h(`
<table><tbody>
<tr><td>Activity</td><td>Release Mgr</td><td>Tech Lead</td><td>QA Lead</td><td>Product Owner</td><td>Ops</td></tr>
<tr><td>Release planning</td><td>A</td><td>C</td><td>C</td><td>R</td><td>I</td></tr>
<tr><td>Go/No-Go decision</td><td>R</td><td>C</td><td>C</td><td>A</td><td>C</td></tr>
<tr><td>Deployment execution</td><td>A</td><td>R</td><td>I</td><td>I</td><td>R</td></tr>
<tr><td>Rollback decision</td><td>A</td><td>R</td><td>C</td><td>C</td><td>C</td></tr>
</tbody></table>
<p><em class="hint">One A per row. If you have two, you have none.</em></p>`)
},
{
  area: 'stakeholder', key: 'comms-plan', title: 'Communication Plan',
  html: h(`
<table><tbody>
<tr><td>Audience</td><td>Message</td><td>Channel</td><td>Cadence</td><td>Owner</td><td>Format</td></tr>
<tr><td>Executive sponsors</td><td>Status, risk, decisions needed</td><td>Email</td><td>Weekly</td><td></td><td>Summary, 5 bullets</td></tr>
<tr><td>Engineering</td><td>Scope, freeze dates, pipeline changes</td><td>Slack</td><td>Per release</td><td></td><td>Technical detail</td></tr>
<tr><td>Business users</td><td>What changes for them, when</td><td>Email + intranet</td><td>T-5d, T-1d, T+1d</td><td></td><td>Non-technical</td></tr>
</tbody></table>`)
},
{
  area: 'stakeholder', key: 'golive-comms', title: 'Go-Live Communication Pack',
  html: h(`
<h2>Executive summary</h2>
<p><em class="hint">Five bullets maximum. What shipped, what it enables, what it cost, what is next, what needs a decision.</em></p>
<ul><li></li></ul>
<h2>Technical deep-dive</h2>
<p><em class="hint">Same facts, engineering audience: components, migrations, flags, known issues, rollback status.</em></p>
<h2>End-user notice</h2>
<h2>Hypercare and escalation</h2>
<table><tbody><tr><td>Tier</td><td>Contact</td><td>Hours</td><td>Escalate after</td></tr>
<tr><td>1</td><td></td><td></td><td></td></tr></tbody></table>`)
},
{
  area: 'stakeholder', key: 'decision-log', title: 'Decision Log (ADR)',
  html: h(`
<table><tbody>
<tr><td>ID</td><td>Date</td><td>Decision</td><td>Context</td><td>Alternatives rejected</td><td>Decided by</td><td>Reversible?</td></tr>
<tr><td>D-01</td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
</tbody></table>
<p><em class="hint">Record the rejected options. Future-you will re-propose them otherwise.</em></p>`)
}
];

export function seedTemplates(pages) {
  // Everything lives in Release Management; the former space survives as a tag (search: tag:environment).
  const sensByArea = {
    stakeholder: 'Client-Confidential',  // personal data
    environment: 'Internal',             // infrastructure details
    release: 'Public',                   // structured templates, no data by default
    deployment: 'Public'
  };
  let created = 0;
  for (const t of TEMPLATES) {
    if (pages.tree('release').some((p) => p.title === t.title && p.type === 'template')) continue;
    pages.create({
      space_key: 'release', title: t.title, body_html: t.html,
      type: 'template', template_key: t.key,
      sensitivity: sensByArea[t.area] || 'Internal',
      tags: t.area === 'release' ? [] : [t.area]
    });
    created++;
  }
  return created;
}
