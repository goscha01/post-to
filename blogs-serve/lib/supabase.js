const { createClient } = require('@supabase/supabase-js');

// Vercel spins a fresh module per cold start; reuse across invocations via
// global (no persistence needed — Supabase JS client is stateless).
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
  { auth: { persistSession: false } }
);

module.exports = supabase;
