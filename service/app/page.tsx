import { env } from 'cloudflare:workers';
import { type ServiceEnv } from '@/lib/config';
export const dynamic = 'force-dynamic';
export default function Home() {
  const enabled = (env as ServiceEnv).UNCLE_SAM_AUTOMATIC_ACTIVITY === 'enabled';
  return <main style={{ minHeight: '100vh', background: '#f5f1ea', color: '#292523', padding: '12vh 24px', fontFamily: 'system-ui' }}>
    <section style={{ maxWidth: 620, margin: 'auto', borderTop: '5px solid #6b1f2a', paddingTop: 32 }}>
      <p style={{ color: '#6b1f2a', fontSize: 13, letterSpacing: 2, fontWeight: 700 }}>COMPANY</p>
      <h1 style={{ fontSize: 48, letterSpacing: -2, margin: '12px 0' }}>Uncle Sam</h1>
      <p style={{ fontSize: 20, lineHeight: 1.6 }}>Recruiting follow-ups, with the details kept together.</p>
      <p style={{ display: 'inline-block', marginTop: 28, borderRadius: 6, padding: '8px 12px', background: enabled ? '#dbe9d8' : '#e8e0d5', fontWeight: 600 }}>
        {enabled ? 'Automatic activity enabled · gated by the Notion control row' : 'Setup in progress · automatic activity off'}
      </p>
      <p style={{ lineHeight: 1.7, color: '#6f665e', marginTop: 24 }}>
        {enabled
          ? 'The hosted runner reacts to Slack, Notion, calendar and portal events. Every action is recorded in Uncle Sam Operations; Mode Off in the control row pauses it.'
          : 'This service is being connected and tested. The Slack app is installed; live recruiting actions have not been enabled.'}
      </p>
    </section>
  </main>;
}
