// Blog custom-domain management.
//
// Wraps two side-effects the /api/blogs/domains routes need:
//   1. DNS verification via node's built-in resolver
//   2. Railway API (customDomainCreate / customDomainDelete) so Railway
//      actually accepts requests for the hostname on the post-to-blogs
//      service and issues a Let's Encrypt cert.
//
// The connected_accounts row we persist is authoritative for post-to-blogs'
// host resolver — it reads directly from Supabase, so writes here must be
// coherent (upsert row + Railway attach, or roll back).

const dns = require('dns').promises;
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const logger = require('../utils/logger');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

const RAILWAY_API = 'https://backboard.railway.com/graphql/v2';
const BLOG_SERVICE_ID = process.env.BLOG_SERVICE_ID || '4fba7cf7-5458-44dd-80b4-53ec355d4d7d';
const BLOG_ENVIRONMENT_ID = process.env.BLOG_ENVIRONMENT_ID || '811f397a-2108-46aa-9feb-a5785164c840';
const BLOG_PROJECT_ID = process.env.BLOG_PROJECT_ID || '774da08a-3338-4022-99a3-d6098e7116b6';
const BLOG_CNAME_TARGET = process.env.BLOG_CNAME_TARGET || 'post-to-blogs-production.up.railway.app';
// Railway's HTTP router requires an explicit target port on custom domains
// (unlike auto-provisioned service domains). Without it, requests hit the
// edge but the edge returns "Application not found" (x-railway-fallback:true)
// because it can't figure out which container port to forward to.
const BLOG_TARGET_PORT = Number(process.env.BLOG_TARGET_PORT) || 8080;

function normalizeHost(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  // Reject apex domains: we only want subdomains (blog.foo.com), never foo.com.
  // Apex requires ALIAS/ANAME/flattening at the DNS provider and is out of MVP scope.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s)) return null;
  if (s.split('.').length < 3) return null; // apex like foo.com
  return s;
}

async function railwayGraphql(query, variables) {
  // NB: Railway silently drops any user-set env var beginning with `RAILWAY_`
  // (reserved for their own auto-injected vars). Store the API token under a
  // non-namespaced name.
  const token = process.env.BLOG_RAILWAY_TOKEN;
  if (!token) throw new Error('BLOG_RAILWAY_TOKEN not set — cannot manage custom domains');
  const res = await axios.post(RAILWAY_API, { query, variables }, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    timeout: 15000,
  });
  if (res.data.errors) {
    const msg = res.data.errors.map(e => e.message).join('; ');
    const err = new Error(`Railway API: ${msg}`);
    err.railwayErrors = res.data.errors;
    throw err;
  }
  return res.data.data;
}

async function verifyCname(hostname, expectedTarget) {
  try {
    const cnames = await dns.resolveCname(hostname);
    const expected = (expectedTarget || '').toLowerCase().replace(/\.$/, '');
    const match = !!expected && cnames.some(c => c.toLowerCase().replace(/\.$/, '') === expected);
    return { ok: match, cnames };
  } catch (err) {
    return { ok: false, error: err.code || err.message, cnames: [] };
  }
}

// Register a hostname on the Railway service. Returns the full customDomain
// object so callers can read status.dnsRecords[0].requiredValue — that value
// is the per-domain CNAME target Let's Encrypt validates against for TLS. It
// is NOT the shared `<service>.up.railway.app` domain; each custom domain gets
// its own subdomain like `abc123xy.up.railway.app`.
async function attachRailwayDomain(hostname) {
  try {
    const data = await railwayGraphql(
      `mutation($input: CustomDomainCreateInput!) {
        customDomainCreate(input: $input) {
          id domain
          status {
            dnsRecords { fqdn recordType requiredValue currentValue status }
            certificates { issuedAt expiresAt }
          }
        }
      }`,
      { input: {
        domain: hostname,
        environmentId: BLOG_ENVIRONMENT_ID,
        serviceId: BLOG_SERVICE_ID,
        projectId: BLOG_PROJECT_ID,
        targetPort: BLOG_TARGET_PORT,
      } }
    );
    return { ok: true, customDomain: data.customDomainCreate };
  } catch (err) {
    const alreadyExists = /already/i.test(err.message);
    return { ok: alreadyExists, error: err.message, alreadyExists };
  }
}

// Read current DNS + cert state for a Railway custom domain. Used every time
// we verify so we always show the user the current cert-issuance state.
async function getRailwayCustomDomainByName(hostname) {
  const data = await railwayGraphql(
    `query($sid: String!) {
      service(id: $sid) {
        serviceInstances { edges { node {
          domains { customDomains {
            id domain
            status {
              dnsRecords { fqdn recordType requiredValue currentValue status }
              certificates { issuedAt expiresAt }
            }
          } }
        } } }
      }
    }`,
    { sid: BLOG_SERVICE_ID }
  );
  const all = (data.service?.serviceInstances?.edges || [])
    .flatMap(e => e.node.domains?.customDomains || []);
  return all.find(d => d.domain?.toLowerCase() === hostname.toLowerCase()) || null;
}

// Nudge Railway to issue a Let's Encrypt cert right now instead of waiting
// for its background poller (which can take several minutes to notice new
// DNS). Called on verify when DNS matches but cert is still missing.
async function triggerRailwayCertIssuance(customDomainId) {
  if (!customDomainId) return { ok: false, error: 'no domain id' };
  try {
    await railwayGraphql(
      `mutation($id: String!) { customDomainIssueCertificate(id: $id) }`,
      { id: customDomainId }
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function detachRailwayDomain(customDomainId) {
  if (!customDomainId) return { ok: true };
  try {
    await railwayGraphql(
      `mutation($id: String!) { customDomainDelete(id: $id) }`,
      { id: customDomainId }
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function listForUser(userId) {
  const { data, error } = await supabase
    .from('connected_accounts')
    .select('id, provider, display_name, external_id, metadata, status, created_at, updated_at')
    .eq('user_id', userId)
    .eq('provider', 'blog_domain')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function getForUser({ userId, id }) {
  const { data, error } = await supabase
    .from('connected_accounts')
    .select('*')
    .eq('user_id', userId)
    .eq('provider', 'blog_domain')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Attach the hostname to Railway first so we get the per-domain requiredValue
// (which is what the user must CNAME to for TLS to work). Return the created
// row with metadata.cname_target set to that per-domain value.
async function createDomain({ userId, hostname, siteName }) {
  const host = normalizeHost(hostname);
  if (!host) {
    const err = new Error('Invalid hostname. Use a subdomain like blog.yoursite.com');
    err.status = 400;
    throw err;
  }
  const externalId = `blog_domain:${host}`;
  const displayName = siteName || host;

  // Register on Railway (or fetch existing) so we have the per-domain CNAME
  // target before returning to the client.
  const attach = await attachRailwayDomain(host);
  let railwayDomain = attach.customDomain;
  if (!railwayDomain && attach.alreadyExists) {
    railwayDomain = await getRailwayCustomDomainByName(host);
  }
  if (!railwayDomain) {
    logger.error('blog_domain.railway_attach_failed', { userId, hostname: host, error: attach.error });
    const err = new Error(`Failed to register with Railway: ${attach.error || 'unknown error'}`);
    err.status = 502;
    throw err;
  }
  const cnameTarget = railwayDomain.status?.dnsRecords?.[0]?.requiredValue || BLOG_CNAME_TARGET;

  // Manual upsert: connected_accounts unique index is partial, so ON CONFLICT
  // can't infer it. Same pattern as upsertWebsite / upsertGoogleSearchConsole.
  const { data: existing } = await supabase
    .from('connected_accounts')
    .select('id, metadata')
    .eq('user_id', userId)
    .eq('provider', 'blog_domain')
    .eq('external_id', externalId)
    .maybeSingle();

  const commonMetadata = {
    hostname: host,
    site_name: siteName || existing?.metadata?.site_name || null,
    cname_target: cnameTarget,
    railway_custom_domain_id: railwayDomain.id,
  };

  if (existing) {
    const mergedMetadata = { ...(existing.metadata || {}), ...commonMetadata };
    const { data, error } = await supabase
      .from('connected_accounts')
      .update({ display_name: displayName, metadata: mergedMetadata, status: 'active' })
      .eq('id', existing.id)
      .select()
      .single();
    if (error) throw error;
    logger.info('blog_domain.updated', { userId, hostname: host, connectionId: data.id });
    return data;
  }

  const { data, error } = await supabase
    .from('connected_accounts')
    .insert({
      user_id: userId,
      provider: 'blog_domain',
      display_name: displayName,
      external_id: externalId,
      status: 'active',
      metadata: {
        ...commonMetadata,
        verified: false,
        created_via: 'dashboard',
      },
    })
    .select()
    .single();
  if (error) throw error;
  logger.info('blog_domain.created', { userId, hostname: host, connectionId: data.id, cnameTarget });
  return data;
}

// Verify does three things every call, regardless of prior state:
//   1. Fetch current state from Railway (or attach if missing).
//   2. Backfill row's metadata.cname_target with the per-domain requiredValue.
//   3. Mark verified only when DNS points to requiredValue AND Let's Encrypt
//      has issued a cert. If either is missing, throw with a specific,
//      user-facing message so the UI knows what to tell them.
async function verifyDomain({ userId, id }) {
  const record = await getForUser({ userId, id });
  if (!record) {
    const err = new Error('Domain not found'); err.status = 404; throw err;
  }
  const hostname = record.metadata?.hostname;
  if (!hostname) {
    const err = new Error('Domain record is missing hostname'); err.status = 400; throw err;
  }

  // Get or create Railway custom domain
  let railwayDomain = null;
  try {
    railwayDomain = await getRailwayCustomDomainByName(hostname);
  } catch (err) {
    logger.warn('blog_domain.railway_lookup_failed', { userId, hostname, error: err.message });
  }
  if (!railwayDomain) {
    const attach = await attachRailwayDomain(hostname);
    if (!attach.ok && !attach.alreadyExists) {
      logger.error('blog_domain.railway_attach_failed', { userId, hostname, error: attach.error });
      const err = new Error(`Failed to register with Railway: ${attach.error}`);
      err.status = 502;
      throw err;
    }
    railwayDomain = attach.customDomain || await getRailwayCustomDomainByName(hostname);
  }
  if (!railwayDomain) {
    const err = new Error('Railway returned no custom domain record'); err.status = 502; throw err;
  }

  const dnsRec = railwayDomain.status?.dnsRecords?.[0];
  const requiredValue = dnsRec?.requiredValue || null;
  const currentValueRaw = dnsRec?.currentValue || null;
  const currentValue = currentValueRaw ? currentValueRaw.toLowerCase().replace(/\.$/, '') : null;
  const expected = requiredValue ? requiredValue.toLowerCase().replace(/\.$/, '') : null;
  const dnsOk = !!(expected && currentValue && currentValue === expected);
  let cert = (railwayDomain.status?.certificates || [])[0];
  let certIssued = !!cert?.issuedAt;

  // Nudge Railway to issue a cert right now if DNS is correct but there's
  // no cert yet. Their background poller can take several minutes to notice
  // — the explicit mutation kicks off issuance immediately. Then re-fetch
  // once to see if the cert already landed.
  if (dnsOk && !certIssued) {
    const trigger = await triggerRailwayCertIssuance(railwayDomain.id);
    logger.info('blog_domain.cert_issuance_triggered', { hostname, ok: trigger.ok, error: trigger.error });
    if (trigger.ok) {
      // Give Let's Encrypt ~4s to complete the ACME dance, then refetch.
      await new Promise(r => setTimeout(r, 4000));
      try {
        const refreshed = await getRailwayCustomDomainByName(hostname);
        if (refreshed) {
          const c2 = (refreshed.status?.certificates || [])[0];
          if (c2?.issuedAt) { cert = c2; certIssued = true; }
        }
      } catch { /* ignore, user can retry */ }
    }
  }
  const fullyReady = dnsOk && certIssued;

  const updatedMeta = {
    ...record.metadata,
    cname_target: requiredValue || record.metadata?.cname_target,
    railway_custom_domain_id: railwayDomain.id,
    railway_current_cname: currentValueRaw,
    railway_cert_issued_at: cert?.issuedAt || null,
    verified: fullyReady,
    ...(fullyReady && !record.metadata?.verified_at ? { verified_at: new Date().toISOString() } : {}),
    last_check_at: new Date().toISOString(),
    last_check_error: fullyReady ? null : (!dnsOk ? 'dns_not_matching' : 'ssl_pending'),
    last_check_cnames: currentValueRaw ? [currentValueRaw] : [],
  };

  const { data, error } = await supabase
    .from('connected_accounts')
    .update({ metadata: updatedMeta, status: 'active' })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;

  if (fullyReady) {
    logger.info('blog_domain.verified', { userId, hostname, connectionId: id });
    return data;
  }

  // Not verified yet — throw so the route returns a 400 with the current
  // state. Include `domain` on the error so the route can return the updated
  // row (frontend uses it to refresh metadata.cname_target with the
  // per-domain value pulled from Railway).
  const msg = !dnsOk
    ? `Waiting for DNS. CNAME for ${hostname} must point to ${requiredValue}. Currently: ${currentValueRaw || '(none)'}`
    : `DNS is correct. SSL certificate is being issued — usually finishes in 1–2 minutes. Click Verify again shortly.`;
  const err = new Error(msg);
  err.status = 400;
  err.details = { requiredValue, currentValue: currentValueRaw, dnsOk, certIssued };
  err.domain = data;
  logger.info('blog_domain.verify_pending', { userId, hostname, dnsOk, certIssued });
  throw err;
}

async function deleteDomain({ userId, id }) {
  const record = await getForUser({ userId, id });
  if (!record) return { ok: true };
  const railwayId = record.metadata?.railway_custom_domain_id;
  await detachRailwayDomain(railwayId); // best-effort — don't block delete on Railway
  const { error } = await supabase
    .from('connected_accounts')
    .delete()
    .eq('id', id)
    .eq('user_id', userId);
  if (error) throw error;
  logger.info('blog_domain.deleted', { userId, connectionId: id, hostname: record.metadata?.hostname });
  return { ok: true };
}

module.exports = {
  normalizeHost,
  BLOG_CNAME_TARGET,
  listForUser,
  getForUser,
  createDomain,
  verifyDomain,
  deleteDomain,
};
