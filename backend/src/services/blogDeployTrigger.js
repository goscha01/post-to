// Fires post-publish deploy triggers based on the blog_domain's
// deploy_trigger config. Today only 'github_actions' via
// repository_dispatch. Additional triggers (Vercel deploy hook,
// AWS CodeBuild, Netlify webhook) can plug in the same way.
//
// Never throws in a way that fails the publish — deploy triggers are a
// side-effect. If the trigger fails, the article is still on S3 and the
// customer can redeploy manually.

const axios = require('axios');
const logger = require('../utils/logger');

// POST /repos/:owner/:repo/dispatches — GitHub's programmatic hook for
// firing workflow runs configured with `on: repository_dispatch`. Requires
// a token with repo scope (or fine-grained: contents R/W + metadata R).
async function fireGithubDispatch({ domain, blog }) {
  const meta = domain.metadata || {};
  const token = meta.github_token;
  const repo = meta.github_repo;                                // 'owner/repo'
  const eventType = meta.github_workflow_event || 'publish-blog';
  if (!token || !repo) {
    return { ok: false, skipped: true, reason: 'no github_token or github_repo' };
  }

  const url = `https://api.github.com/repos/${repo}/dispatches`;
  try {
    const res = await axios.post(url, {
      event_type: eventType,
      client_payload: {
        slug: blog.slug,
        title: blog.title,
        published_at: blog.published_at,
      },
    }, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'post-to-publisher/1.0',
      },
      timeout: 10000,
      validateStatus: () => true,
    });
    if (res.status === 204) {
      logger.info('blog_deploy.github_dispatch_ok', { repo, eventType, slug: blog.slug });
      return { ok: true, provider: 'github_actions', repo, eventType };
    }
    const msg = res.data?.message || `HTTP ${res.status}`;
    logger.warn('blog_deploy.github_dispatch_failed', { repo, eventType, status: res.status, error: msg });
    return { ok: false, error: msg };
  } catch (err) {
    logger.warn('blog_deploy.github_dispatch_error', { repo, eventType, error: err.message });
    return { ok: false, error: err.message };
  }
}

// Dispatch based on the domain's configured deploy_trigger. Returns a small
// summary object callers can pass through to the response so the UI can show
// "auto-deploy fired" vs "manual deploy required".
async function trigger({ domain, blog }) {
  const which = domain.metadata?.deploy_trigger;
  if (which === 'github_actions') return fireGithubDispatch({ domain, blog });
  return { ok: false, skipped: true, reason: 'no deploy_trigger configured' };
}

module.exports = { trigger, fireGithubDispatch };
