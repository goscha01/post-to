// Scratch script: probe which AWS region hosts the Supabase pooler for this
// project. Deleted after use — do not keep in source control.
require('dotenv').config();
const { Client } = require('pg');

const direct = process.env.SUPABASE_DATABASE_URL;
const m = direct.match(/^postgres(?:ql)?:\/\/([^:]+):([^@]+)@db\.([^.]+)\.supabase\.co:(\d+)\/(.+?)(\?.*)?$/);
if (!m) { console.log('no match for:', direct.replace(/:[^@]+@/, ':***@')); process.exit(1); }
const [, user, pass, ref, port, db] = m;
console.log('user:', user, 'ref:', ref, 'db:', db);

const regions = ['us-east-1','us-west-1','us-east-2','us-west-2','eu-central-1','eu-west-1','ap-southeast-1','ap-northeast-1','ca-central-1'];
(async () => {
  for (const region of regions) {
    const host = `aws-0-${region}.pooler.supabase.com`;
    const url = `postgres://postgres.${ref}:${encodeURIComponent(pass)}@${host}:6543/${db.split('?')[0]}`;
    const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 4000 });
    try {
      await c.connect();
      const r = await c.query('SELECT 1 AS ok');
      console.log('WORKS:', region, '→', host, '→', r.rows[0]);
      await c.end();
      // Output the full URL to stderr so the user can set it as SUPABASE_POOLER_URL
      console.error(`SUPABASE_POOLER_URL=${url}`);
      return;
    } catch (e) {
      console.log('fail:', region, '-', e.message.slice(0, 80));
      try { await c.end(); } catch {}
    }
  }
  console.log('no region worked');
})();
