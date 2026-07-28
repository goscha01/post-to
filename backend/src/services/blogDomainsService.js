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
  const token = process.env.RAILWAY_TOKEN;
  if (!token) throw new Error('RAILWAY_TOKEN not set — cannot manage custom domains');
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

async function verifyCname(hostname) {
  try {
    const cnames = await dns.resolveCname(hostname);
    const expected = BLOG_CNAME_TARGET.toLowerCase();
    const match = cnames.some(c => c.toLowerCase().replace(/\.$/, '') === expected);
    return { ok: match, cnames };
  } catch (err) {
    return { ok: false, error: err.code || err.message, cnames: [] };
  }
}

async function attachRailwayDomain(hostname) {
  try {
    const data = await railwayGraphql(
      `mutation($input: CustomDomainCreateInput!) {
        customDomainCreate(input: $input) { id domain status { dnsRecords { fqdn recordType requiredValue currentValue status } } }
      }`,
      { input: { domain: hostname, environmentId: BLOG_ENVIRONMENT_ID, serviceId: BLOG_SERVICE_ID, projectId: BLOG_PROJECT_ID } }
    );
    return { ok: true, id: data.customDomainCreate.id, status: data.customDomainCreate.status };
  } catch (err) {
    // If the domain is already attached to this service, treat as success and return existing.
    const alreadyExists = /already/i.test(err.message);
    return { ok: alreadyExists, error: err.message };
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

async function createDomain({ userId, hostname, siteName }) {
  const host = normalizeHost(hostname);
  if (!host) {
    const err = new Error('Invalid hostname. Use a subdomain like blog.yoursite.com');
    err.status = 400;
    throw err;
  }
  const externalId = `blog_domain:${host}`;
  const displayName = siteName || host;

  // Manual upsert: the connected_accounts unique index is partial
  // (WHERE external_id IS NOT NULL) so ON CONFLICT can't infer it. Same
  // pattern as connectionsService.upsertWebsite / upsertGoogleSearchConsole.
  const { data: existing } = await supabase
    .from('connected_accounts')
    .select('id, metadata')
    .eq('user_id', userId)
    .eq('provider', 'blog_domain')
    .eq('external_id', externalId)
    .maybeSingle();

  if (existing) {
    // Preserve existing verification state on re-add — user might be
    // editing site_name or retrying after a delete. Only bump cname_target
    // if it drifted.
    const mergedMetadata = {
      ...(existing.metadata || {}),
      hostname: host,
      site_name: siteName || existing.metadata?.site_name || null,
      cname_target: BLOG_CNAME_TARGET,
    };
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
        hostname: host,
        site_name: siteName || null,
        verified: false,
        cname_target: BLOG_CNAME_TARGET,
        created_via: 'dashboard',
      },
    })
    .select()
    .single();
  if (error) throw error;
  logger.info('blog_domain.created', { userId, hostname: host, connectionId: data.id });
  return data;
}

async function verifyDomain({ userId, id }) {
  const record = await getForUser({ userId, id });
  if (!record) {
    const err = new Error('Domain not found'); err.status = 404; throw err;
  }
  const hostname = record.metadata?.hostname;
  if (!hostname) {
    const err = new Error('Domain record is missing hostname'); err.status = 400; throw err;
  }

  const dnsCheck = await verifyCname(hostname);
  if (!dnsCheck.ok) {
    logger.warn('blog_domain.dns_check_failed', { userId, hostname, cnames: dnsCheck.cnames, error: dnsCheck.error });
    // Update the record with the latest attempt info but don't mark verified.
    await supabase.from('connected_accounts').update({
      metadata: { ...record.metadata, last_check_at: new Date().toISOString(), last_check_cnames: dnsCheck.cnames, last_check_error: dnsCheck.error || null },
    }).eq('id', id);
    const err = new Error(`CNAME for ${hostname} does not point to ${BLOG_CNAME_TARGET}. Found: ${dnsCheck.cnames.join(', ') || '(none)'}`);
    err.status = 400;
    err.details = { cnames: dnsCheck.cnames, expected: BLOG_CNAME_TARGET };
    throw err;
  }

  // DNS is good — attach to Railway so it accepts the hostname + issues SSL.
  const attach = await attachRailwayDomain(hostname);
  if (!attach.ok) {
    logger.error('blog_domain.railway_attach_failed', { userId, hostname, error: attach.error });
    const err = new Error(`DNS verified, but failed to register with Railway: ${attach.error}`);
    err.status = 502;
    throw err;
  }

  const updatedMeta = {
    ...record.metadata,
    verified: true,
    verified_at: new Date().toISOString(),
    railway_custom_domain_id: attach.id || record.metadata?.railway_custom_domain_id || null,
    last_check_at: new Date().toISOString(),
    last_check_error: null,
  };
  const { data, error } = await supabase
    .from('connected_accounts')
    .update({ metadata: updatedMeta, status: 'active' })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  logger.info('blog_domain.verified', { userId, hostname, connectionId: id });
  return data;
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
