import React, { useState } from 'react';
import { Heart, Rss, Globe, Link2, Copy, Check, Zap, Info, ArrowDown } from 'lucide-react';

// Placeholder tokens shown in the UI. Real values will come from the backend
// once /api/connections/<provider>/init endpoints land.
const PLACEHOLDER_TOKEN = 'aseo_wh_a8ee4b0d51c2423f6c6c29553cdea133';

function useCopy() {
  const [copied, setCopied] = useState(false);
  return {
    copied,
    copy: async (text) => {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch (_) {
        /* clipboard unavailable */
      }
    },
  };
}

const FooterNav = ({ onCancel }) => (
  <div className="flex justify-start">
    <button
      type="button"
      onClick={onCancel}
      className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
    >
      Back to providers
    </button>
  </div>
);

const FeaturesGrid = ({ features, cols = 3, iconColor = 'text-emerald-600' }) => (
  features?.length ? (
    <div>
      <h4 className="text-sm font-semibold text-gray-900 mb-2">What you get</h4>
      <div className={`grid grid-cols-1 sm:grid-cols-${cols} gap-3`}>
        {features.map((f, i) => (
          <div key={i} className="p-3 border border-gray-200 rounded-md flex items-start gap-2">
            <Check className={`h-4 w-4 mt-0.5 flex-shrink-0 ${iconColor}`} />
            <div>
              <p className="text-xs font-semibold text-gray-900">{f.title}</p>
              <p className="text-[11px] text-gray-500 mt-0.5">{f.desc}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  ) : null
);

// ---------------------------------------------------------------------------
// Lovable — "copy prompt into Lovable, get an Edge Function URL back"
// ---------------------------------------------------------------------------

const LOVABLE_PROMPT = `Add a blog to my website. Articles are delivered via webhook from Post-to (https://postto.app) and stored in Supabase.

CRITICAL: Do NOT drop, delete, alter, or modify any existing database tables, columns, data, or RLS policies. Only CREATE new tables and functions. Never use DROP TABLE, TRUNCATE, or DELETE on existing tables. This project has existing data that must be preserved.

REQUIREMENTS:

1. SUPABASE DATABASE TABLE
   - Create a "blog_posts" table ONLY IF IT DOES NOT ALREADY EXIST (use CREATE TABLE IF NOT EXISTS)
   - Table columns:
     * id (integer, primary key) — the article id from Post-to
     * title (text, not null)
     * slug (text, not null, unique)
     * content_html (text) — the full article HTML, ready to render
     * content_markdown (text) — the article in Markdown format
     * hero_image_url (text) — hero/featured image URL
`;

export const LovableForm = ({ onCancel, onConnected }) => {
  const [edgeUrl, setEdgeUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [err, setErr] = useState('');
  const promptCopy = useCopy();

  const submit = async (e) => {
    e.preventDefault();
    if (!edgeUrl.trim()) {
      setErr('Please paste the Edge Function URL.');
      return;
    }
    setSubmitting(true);
    setErr('');
    setTimeout(() => {
      setSubmitting(false);
      onConnected && onConnected({ id: 'lovable-placeholder', provider: 'lovable', display_name: edgeUrl, status: 'active' });
    }, 400);
  };

  const sendTest = () => {
    setTesting(true);
    setTimeout(() => setTesting(false), 800);
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-gray-900">Lovable Blog Integration</h3>
          <p className="text-xs text-gray-500 mt-0.5">Add a full blog to your Lovable site with a single prompt. Articles publish automatically.</p>
        </div>
        <div className="h-10 w-10 rounded-md bg-pink-50 flex items-center justify-center flex-shrink-0">
          <Heart className="h-5 w-5 text-pink-600" />
        </div>
      </div>

      <div className="p-3 bg-pink-50 border border-pink-200 rounded-md flex items-start gap-2 text-xs text-pink-900">
        <Zap className="h-4 w-4 mt-0.5 flex-shrink-0 text-pink-600" />
        <div>
          <p className="font-semibold mb-0.5">How it works</p>
          <p>Paste the prompt below into Lovable. It creates your blog, a Supabase Edge Function endpoint, and a sitemap — with authentication built in. Then paste the Edge Function URL below and hit Connect. Articles publish to your site instantly — no syncing, no polling.</p>
        </div>
      </div>

      <div className="border border-gray-200 rounded-lg overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-200">
          <span className="text-xs font-semibold text-gray-700 inline-flex items-center gap-1.5">
            <Copy className="h-3.5 w-3.5" />
            Lovable Prompt — Webhook
          </span>
          <button
            type="button"
            onClick={() => promptCopy.copy(LOVABLE_PROMPT)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-pink-600 text-white text-xs font-medium rounded-md hover:bg-pink-700"
          >
            {promptCopy.copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {promptCopy.copied ? 'Copied' : 'Copy Prompt'}
          </button>
        </div>
        <pre className="bg-white text-[11px] text-gray-800 p-3 max-h-56 overflow-auto font-mono whitespace-pre-wrap">{LOVABLE_PROMPT}</pre>
      </div>

      <div className="border border-gray-200 rounded-lg p-4 bg-gray-50">
        <p className="text-xs font-semibold text-gray-800 mb-2">Setup steps</p>
        <ol className="space-y-1.5 text-xs text-gray-700">
          {[
            <>Click <strong>Copy Prompt</strong> above and paste it into <a href="https://lovable.dev" target="_blank" rel="noreferrer" className="text-pink-600 underline">Lovable</a></>,
            <>Lovable builds your blog pages, Supabase table, webhook endpoint, and sitemap</>,
            <>Copy the Edge Function URL from Supabase (it looks like <code>https://xxx.supabase.co/functions/v1/receive-article</code>)</>,
            <>Paste the URL below, hit <strong>Send Test</strong> to verify, then <strong>Connect</strong></>,
          ].map((body, i) => (
            <li key={i} className="flex gap-2">
              <span className="flex-shrink-0 h-5 w-5 rounded-full bg-pink-500 text-white text-[10px] font-bold inline-flex items-center justify-center">{i + 1}</span>
              <span className="min-w-0">{body}</span>
            </li>
          ))}
        </ol>
      </div>

      <form onSubmit={submit} className="border border-pink-200 bg-pink-50/40 rounded-lg p-4 space-y-3">
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Edge Function URL <span className="text-red-500">*</span>
          </label>
          <input
            type="url"
            value={edgeUrl}
            onChange={e => setEdgeUrl(e.target.value)}
            placeholder="https://xxx.supabase.co/functions/v1/receive-article"
            className="w-full px-3 py-2 border border-gray-300 bg-white rounded-md text-xs font-mono focus:outline-none focus:ring-2 focus:ring-pink-500 focus:border-pink-500"
          />
          <p className="text-[11px] text-gray-500 mt-1">The Supabase Edge Function URL that Lovable created for you.</p>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Bearer Token</label>
          <input
            type="text"
            readOnly
            value={PLACEHOLDER_TOKEN}
            className="w-full px-3 py-2 border border-gray-300 bg-white rounded-md text-xs font-mono text-gray-700"
            onFocus={e => e.target.select()}
          />
          <p className="text-[11px] text-gray-500 mt-1">Already embedded in the Lovable prompt above — no need to change this.</p>
        </div>

        {err && (
          <div className="p-2 bg-red-50 border border-red-200 rounded text-xs text-red-800">{err}</div>
        )}

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={sendTest}
            disabled={testing || !edgeUrl.trim()}
            className="px-3 py-2 text-xs font-medium text-pink-700 bg-white border border-pink-300 rounded-md hover:bg-pink-50 disabled:opacity-50"
          >
            {testing ? 'Testing…' : 'Send Test'}
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-2 text-xs font-medium text-white bg-pink-600 rounded-md hover:bg-pink-700 disabled:opacity-50"
          >
            {submitting ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      </form>

      <div className="p-3 bg-blue-50 border border-blue-200 rounded-md flex items-start gap-2 text-xs text-blue-900">
        <Info className="h-4 w-4 mt-0.5 flex-shrink-0 text-blue-600" />
        <p>
          <strong>Published URL tracking:</strong> The Edge Function returns the live URL for each article. Post-to uses this to show "View Live" links in your dashboard and enable backlink exchange. The prompt also creates <code>/sitemap.xml</code> for search engine discovery.
        </p>
      </div>

      <FeaturesGrid
        iconColor="text-pink-600"
        features={[
          { title: 'AI-Generated Blog', desc: 'Lovable builds your blog pages, routing, and design from a single prompt' },
          { title: 'Auto-Sitemap', desc: 'Dynamic /sitemap.xml so search engines find every article' },
          { title: 'Backlink Ready', desc: 'Standard /blog/slug URLs let us verify posts and enable backlink exchange' },
        ]}
      />

      <FooterNav onCancel={onCancel} />
    </div>
  );
};

// ---------------------------------------------------------------------------
// RSS & JSON Feeds — one-click enable, no form
// ---------------------------------------------------------------------------

export const RssFeedForm = ({ onCancel, onConnected }) => {
  const [enabling, setEnabling] = useState(false);
  const enable = () => {
    setEnabling(true);
    setTimeout(() => {
      setEnabling(false);
      onConnected && onConnected({ id: 'rss-placeholder', provider: 'rss', display_name: 'RSS & JSON Feeds', status: 'active' });
    }, 400);
  };
  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-gray-900">RSS &amp; JSON Feeds</h3>
          <p className="text-xs text-gray-500 mt-0.5">Programmatic access to your published articles for static site generators and other integrations</p>
        </div>
        <div className="h-10 w-10 rounded-md bg-orange-50 flex items-center justify-center flex-shrink-0">
          <Rss className="h-5 w-5 text-orange-600" />
        </div>
      </div>

      <div className="border border-gray-200 rounded-lg p-4">
        <div className="flex items-start gap-2">
          <Info className="h-4 w-4 mt-0.5 flex-shrink-0 text-gray-500" />
          <div>
            <p className="text-sm font-semibold text-gray-900">Feed Not Enabled</p>
            <p className="text-xs text-gray-600 mt-0.5">Enable RSS &amp; JSON feeds to integrate your published articles with Hugo, Jekyll, Gatsby, Next.js, Eleventy, and other static site generators or RSS readers.</p>
          </div>
        </div>
        <button
          type="button"
          onClick={enable}
          disabled={enabling}
          className="mt-4 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 disabled:opacity-50"
        >
          {enabling ? 'Enabling…' : 'Enable Feed'}
        </button>
      </div>

      <div>
        <h4 className="text-sm font-semibold text-gray-900 mb-2">Features</h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {[
            { title: 'RSS 2.0 & JSON Feed v1', desc: 'Standards-compliant feeds with full content support' },
            { title: 'Secure Token-Based Access', desc: 'Rotate tokens without downtime, revoke anytime' },
            { title: 'Published Articles Only', desc: 'Only published & non-future-dated articles included' },
            { title: 'Fast & Cached', desc: '60-second caching with ETag support for efficiency' },
          ].map((f, i) => (
            <div key={i} className="p-3 border border-gray-200 rounded-md flex items-start gap-2">
              <Check className="h-4 w-4 mt-0.5 flex-shrink-0 text-orange-600" />
              <div>
                <p className="text-xs font-semibold text-gray-900">{f.title}</p>
                <p className="text-[11px] text-gray-500 mt-0.5">{f.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <FooterNav onCancel={onCancel} />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Hosted Blog — pick a subdomain, we host
// ---------------------------------------------------------------------------

export const HostedBlogForm = ({ onCancel, onConnected }) => {
  const [subdomain, setSubdomain] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (!subdomain.trim()) {
      setErr('Please enter a blog subdomain.');
      return;
    }
    setSubmitting(true);
    setErr('');
    setTimeout(() => {
      setSubmitting(false);
      onConnected && onConnected({ id: 'hosted-placeholder', provider: 'hosted_blog', display_name: subdomain, status: 'active' });
    }, 400);
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-gray-900">Hosted Blog</h3>
          <p className="text-xs text-gray-500 mt-0.5">We host your blog for you. Just point a subdomain and your articles are live.</p>
        </div>
        <div className="h-10 w-10 rounded-md bg-emerald-50 flex items-center justify-center flex-shrink-0">
          <Globe className="h-5 w-5 text-emerald-600" />
        </div>
      </div>

      <form onSubmit={submit} className="border border-gray-200 rounded-lg p-4">
        <div className="flex items-start gap-3">
          <span className="flex-shrink-0 h-7 w-7 rounded-full bg-gray-100 text-gray-700 text-xs font-semibold inline-flex items-center justify-center mt-0.5">1</span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-gray-900">Set up your blog subdomain</p>
            <label className="block text-xs font-medium text-gray-700 mt-3 mb-1">Blog subdomain</label>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="text"
                value={subdomain}
                onChange={e => setSubdomain(e.target.value)}
                placeholder="blog.yoursite.com"
                className="flex-1 px-3 py-2 border border-gray-300 rounded-md text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
              />
              <button
                type="submit"
                disabled={submitting || !subdomain.trim()}
                className="px-4 py-2 bg-emerald-500 text-white text-sm font-medium rounded-md hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? 'Saving…' : 'Save Subdomain'}
              </button>
            </div>
            <p className="text-[11px] text-gray-500 mt-1">
              Use a dedicated blog subdomain like <code>blog.yoursite.com</code> or <code>articles.yoursite.com</code>. Please do not enter your main website domain.
            </p>
            {err && (
              <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-800">{err}</div>
            )}
          </div>
        </div>
      </form>

      <FooterNav onCancel={onCancel} />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Webhook Integration — most complex: URL + token + spec + payload + code
// ---------------------------------------------------------------------------

const WEBHOOK_PAYLOAD = `{
  "event": "article.published",
  "id": 42,
  "title": "How to Grow Your Business with SEO",
  "slug": "how-to-grow-your-business-with-seo",
  "published_url": "https://example.com/blog/how-to-grow-your-business-with-seo",
  "metaDescription": "Learn practical SEO strategies to attract more customers…",
  "content_html": "<h1>How to Grow Your Business…</h1><p>Full HTML content…</p>",
  "content_markdown": "# How to Grow Your Business…\\n\\nFull markdown content…",
  "heroImageUrl": "https://cdn.example.com/hero-image.jpg",
  "heroImageAlt": "Alt text for the hero image",
  "infographicImageUrl": "https://cdn.example.com/infographic.png",
  "keywords": ["seo strategies"],
  "metaKeywords": "seo, business growth, marketing",
  "wordpressTags": "seo, marketing, growth",
  "faqSchema": [{"question": "What is SEO?", "answer": "SEO stands for…"}],
  "languageCode": "en",
  "sourceArticleId": null,
  "status": "published",
  "publishedAt": "2026-03-04T10:30:00.000Z",
  "updatedAt":   "2026-03-04T10:30:00.000Z",
  "createdAt":   "2026-03-04T09:00:00.000Z"
}`;

const WEBHOOK_VERIFY_SNIPPET = `// Node.js / Express example
const crypto = require('crypto');
const SECRET = '${PLACEHOLDER_TOKEN}';

// IMPORTANT: Use the raw request body string, not JSON.stringify(parsed).
// With Express, add: app.use(express.raw({ type: 'application/json' }))
// or use express.json() with { verify: (req, res, buf) => { req.rawBody = buf; } }

function verifySignature(rawBody, signature) {
  const expected = crypto
    .createHmac('sha256', SECRET)
    .update(rawBody)
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}

// In your endpoint handler:
const sig = req.headers['x-postto-signature'];
if (!verifySignature(req.rawBody, sig)) {
  return res.status(401).send('Invalid signature');
}`;

const WEBHOOK_AI_PROMPT = `Create a webhook endpoint in my project that receives article data from Post-to (https://postto.app).

CRITICAL: Do NOT drop, delete, alter, or modify any existing database tables, columns, data, or RLS policies. Only CREATE new tables and functions. Never use DROP TABLE, TRUNCATE, or DELETE on existing tables. This project has existing data that must be preserved. Use CREATE TABLE IF NOT EXISTS for any new tables.

## What the endpoint must do:

1. Accept POST requests with a JSON body
2. Verify the Authorization header contains this exact Bearer token: \`${PLACEHOLDER_TOKEN}\` — reject with HTTP 401 if missing or wrong
3. Optionally also verify the HMAC-SHA256 signature (sent in \`X-Postto-Signature\` header, computed from the raw JSON request body string using the same token as the HMAC secret — use the raw body bytes, not a re-serialized version)
4. Check the \`event\` field and \`id\` to decide whether to insert or update`;

const PAYLOAD_FIELDS = [
  ['event', 'string', <><code>article.published</code>, <code>article.updated</code>, or <code>test</code>. Use this to decide whether to insert or update.</>],
  ['id', 'integer', <>Unique article ID — use this to match updates to existing posts</>],
  ['title', 'string', 'Article title'],
  ['slug', 'string', 'URL-friendly slug'],
  ['published_url', 'string|null', 'The live URL of the post (set after first publish)'],
  ['metaDescription', 'string', 'SEO meta description (150-160 chars)'],
  ['content_html', 'string', 'Full article in HTML'],
  ['content_markdown', 'string', 'Full article in Markdown'],
  ['heroImageUrl', 'string|null', 'Featured hero image URL'],
  ['heroImageAlt', 'string|null', 'Alt text for the hero image'],
  ['infographicImageUrl', 'string|null', 'Infographic image URL (if enabled)'],
  ['keywords', 'array', 'Target keywords'],
  ['metaKeywords', 'string|null', 'Comma-separated SEO keywords'],
  ['wordpressTags', 'string|null', 'Comma-separated tags'],
  ['faqSchema', 'array|null', 'FAQ structured data (question/answer pairs)'],
  ['languageCode', 'string', 'ISO language code for this article (e.g. en, es, de)'],
  ['sourceArticleId', 'integer|null', 'For translated articles, the ID of the original source article. Null for primary-language articles.'],
  ['status', 'string', 'Always published for webhook deliveries'],
  ['publishedAt', 'string', 'ISO 8601 publication timestamp'],
  ['updatedAt', 'string', 'ISO 8601 last updated timestamp'],
  ['createdAt', 'string', 'ISO 8601 creation timestamp'],
];

export const WebhookForm = ({ onCancel, onConnected }) => {
  const [url, setUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [err, setErr] = useState('');
  const [showAiPrompt, setShowAiPrompt] = useState(false);
  const promptCopy = useCopy();

  const submit = async (e) => {
    e.preventDefault();
    if (!url.trim()) {
      setErr('Please enter a webhook URL.');
      return;
    }
    setSubmitting(true);
    setErr('');
    setTimeout(() => {
      setSubmitting(false);
      onConnected && onConnected({ id: 'webhook-placeholder', provider: 'webhook', display_name: url, status: 'active' });
    }, 400);
  };

  const sendTest = () => {
    setTesting(true);
    setTimeout(() => setTesting(false), 800);
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-gray-900">Webhook Integration</h3>
          <p className="text-xs text-gray-500 mt-0.5">Send articles to any endpoint automatically. Works with custom CMS platforms, Zapier, Make, n8n, and more.</p>
        </div>
        <div className="h-10 w-10 rounded-md bg-purple-50 flex items-center justify-center flex-shrink-0">
          <Link2 className="h-5 w-5 text-purple-600" />
        </div>
      </div>

      <div className="p-3 bg-indigo-50 border border-indigo-200 rounded-md flex items-center justify-between gap-3">
        <div className="flex items-start gap-2 min-w-0">
          <div className="h-8 w-8 rounded-md bg-indigo-500 flex items-center justify-center flex-shrink-0">
            <Zap className="h-4 w-4 text-white" />
          </div>
          <div className="min-w-0 text-xs text-indigo-900">
            <p className="font-semibold">Skip the manual setup — use our AI vibe coding prompt instead</p>
            <p className="text-indigo-800/80">We've written a ready-to-go prompt you can paste into Cursor, Claude Code, or any AI coding assistant to build your webhook endpoint in seconds.</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setShowAiPrompt(v => !v)}
          className="inline-flex items-center gap-1 px-3 py-2 bg-indigo-600 text-white text-xs font-medium rounded-md hover:bg-indigo-700 flex-shrink-0"
        >
          {showAiPrompt ? 'Hide' : 'Check it out'}
          <ArrowDown className={`h-3.5 w-3.5 transition-transform ${showAiPrompt ? 'rotate-180' : ''}`} />
        </button>
      </div>

      <form onSubmit={submit} className="border border-purple-200 bg-purple-50/40 rounded-lg p-4 space-y-3">
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Webhook URL <span className="text-red-500">*</span>
          </label>
          <input
            type="url"
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder="https://your-site.com/api/webhook"
            className="w-full px-3 py-2 border border-gray-300 bg-white rounded-md text-xs font-mono focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
          />
          <p className="text-[11px] text-gray-500 mt-1">Must be a public URL that accepts POST requests with JSON body.</p>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Bearer Token / Secret</label>
          <input
            type="text"
            readOnly
            value={PLACEHOLDER_TOKEN}
            className="w-full px-3 py-2 border border-gray-300 bg-white rounded-md text-xs font-mono text-gray-700"
            onFocus={e => e.target.select()}
          />
          <p className="text-[11px] text-gray-500 mt-1">
            Sent as <code>Authorization: Bearer &lt;your-token&gt;</code> with every webhook delivery.
            We've generated this token for you — don't change it unless you also changed it in your endpoint code or Lovable prompt.
          </p>
        </div>

        {err && (
          <div className="p-2 bg-red-50 border border-red-200 rounded text-xs text-red-800">{err}</div>
        )}

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={sendTest}
            disabled={testing || !url.trim()}
            className="px-3 py-2 text-xs font-medium text-purple-700 bg-white border border-purple-300 rounded-md hover:bg-purple-50 disabled:opacity-50"
          >
            {testing ? 'Testing…' : 'Send Test'}
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-2 text-xs font-medium text-white bg-purple-600 rounded-md hover:bg-purple-700 disabled:opacity-50"
          >
            {submitting ? 'Connecting…' : 'Connect Webhook'}
          </button>
        </div>
      </form>

      <div>
        <h4 className="text-sm font-semibold text-gray-900 mb-2">What We Send</h4>
        <div className="border border-gray-200 rounded-md overflow-hidden text-xs">
          <div className="grid grid-cols-[80px_1fr] gap-2 p-3 border-b border-gray-200 bg-gray-50">
            <span className="font-mono text-gray-500 uppercase text-[10px]">Method</span>
            <span className="inline-flex items-center px-1.5 py-0.5 bg-gray-100 border border-gray-200 rounded text-[11px] font-mono w-fit">POST</span>
          </div>
          <div className="grid grid-cols-[80px_1fr] gap-2 p-3 bg-white">
            <span className="font-mono text-gray-500 uppercase text-[10px]">Headers</span>
            <pre className="text-[11px] font-mono text-gray-800 whitespace-pre-wrap">{`Content-Type: application/json
Authorization: Bearer ${PLACEHOLDER_TOKEN}
X-Postto-Event: article.published or article.updated
X-Postto-Signature: <HMAC-SHA256 hash>
X-Postto-Delivery: <unique delivery UUID>`}</pre>
          </div>
        </div>
      </div>

      <div>
        <h4 className="text-sm font-semibold text-gray-900 mb-2">Example Payload</h4>
        <pre className="bg-gray-900 text-emerald-300 text-[11px] font-mono p-3 rounded-md overflow-auto max-h-64 whitespace-pre">{WEBHOOK_PAYLOAD}</pre>
      </div>

      <div>
        <h4 className="text-sm font-semibold text-gray-900 mb-2">Payload Fields</h4>
        <div className="border border-gray-200 rounded-md overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="px-3 py-2 font-semibold text-gray-700">Field</th>
                <th className="px-3 py-2 font-semibold text-gray-700 w-32">Type</th>
                <th className="px-3 py-2 font-semibold text-gray-700">Description</th>
              </tr>
            </thead>
            <tbody>
              {PAYLOAD_FIELDS.map(([f, t, d], i) => (
                <tr key={f} className={i % 2 ? 'bg-white' : 'bg-gray-50/50'}>
                  <td className="px-3 py-1.5 font-mono text-purple-700">{f}</td>
                  <td className="px-3 py-1.5 font-mono text-gray-600">{t}</td>
                  <td className="px-3 py-1.5 text-gray-700">{d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <h4 className="text-sm font-semibold text-gray-900 mb-2">
          Response Format <span className="text-xs font-normal text-gray-500">(recommended)</span>
        </h4>
        <p className="text-xs text-gray-600 mb-2">
          Return a JSON response with the published URL so we can link directly to the live article in your dashboard.
          We check for <code>url</code>, <code>published_url</code>, or <code>permalink</code> fields.
        </p>
        <pre className="bg-gray-900 text-emerald-300 text-[11px] font-mono p-3 rounded-md whitespace-pre">{`// Your endpoint should return:
HTTP 200
Content-Type: application/json

{
  "url": "https://yoursite.com/blog/how-to-grow-your-business-with-seo"
}`}</pre>
        <p className="text-[11px] text-gray-500 mt-1">
          If you can't return a URL, just return an HTTP 200. You'll be able to add the URL manually from your content calendar.
        </p>
      </div>

      <div>
        <h4 className="text-sm font-semibold text-gray-900 mb-2">Verifying Webhook Signatures</h4>
        <p className="text-xs text-gray-600 mb-2">
          Every webhook includes an <code>X-Postto-Signature</code> header — an HMAC-SHA256 hash of the JSON body using your bearer token.
          Verify it to confirm the request came from Post-to.
        </p>
        <pre className="bg-gray-900 text-emerald-300 text-[11px] font-mono p-3 rounded-md overflow-auto max-h-72 whitespace-pre">{WEBHOOK_VERIFY_SNIPPET}</pre>
      </div>

      {showAiPrompt && (
        <div>
          <h4 className="text-sm font-semibold text-gray-900 mb-2">Quick Setup with AI</h4>
          <div className="border border-gray-200 rounded-md overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-200">
              <p className="text-xs text-gray-600">Copy this prompt into Cursor, Claude Code, or any AI coding assistant to generate a ready-to-use webhook endpoint for your project.</p>
              <button
                type="button"
                onClick={() => promptCopy.copy(WEBHOOK_AI_PROMPT)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-purple-600 text-white text-xs font-medium rounded-md hover:bg-purple-700 flex-shrink-0"
              >
                {promptCopy.copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {promptCopy.copied ? 'Copied' : 'Copy Prompt'}
              </button>
            </div>
            <pre className="bg-gray-900 text-emerald-300 text-[11px] font-mono p-3 max-h-64 overflow-auto whitespace-pre-wrap">{WEBHOOK_AI_PROMPT}</pre>
          </div>
        </div>
      )}

      <div>
        <h4 className="text-sm font-semibold text-gray-900 mb-2">Common Questions</h4>
        <div className="space-y-3">
          {[
            { q: 'When are webhooks sent?', a: 'Whenever an article is published, updated, or its hero image finishes generating. Your endpoint receives the complete, ready-to-publish article.' },
            { q: 'What should my endpoint return?', a: 'Return HTTP 200 to acknowledge receipt. If possible, include {"url": "https://..."} in your JSON response so we can link to the live article. Any non-2xx response triggers up to 3 automatic retries (1 min, 5 min, 15 min).' },
            { q: 'Can I use this with Zapier, Make, or n8n?', a: 'Yes. Create a "Webhook" trigger in any of those tools, copy the URL they give you, and paste it here. You\'ll receive the full article data in your automation flow.' },
            { q: 'Is my bearer token stored securely?', a: 'Yes. We auto-generate a unique token for your site and store it securely. The same token is embedded in your Lovable prompt and AI setup prompts so everything matches without manual copying.' },
            { q: 'What happens if my endpoint is temporarily down?', a: 'We retry failed deliveries up to 3 times with increasing delays. If all retries fail, the webhook is skipped for that article. Your endpoint should be reliable or queue-backed.' },
            { q: 'Can I use this with serverless functions?', a: 'Absolutely. Webhooks work with AWS Lambda, Vercel Functions, Cloudflare Workers, Netlify Functions, and any platform that can receive POST requests.' },
          ].map((q, i) => (
            <div key={i}>
              <p className="text-xs font-semibold text-gray-900">{q.q}</p>
              <p className="text-xs text-gray-600 mt-0.5">{q.a}</p>
            </div>
          ))}
        </div>
      </div>

      <FooterNav onCancel={onCancel} />
    </div>
  );
};
