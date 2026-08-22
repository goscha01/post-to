import React, { useState } from 'react';
import { AlertTriangle, Info, Check, ExternalLink, ShoppingBag } from 'lucide-react';

// Reusable "Blog integration" panel used by Shopify, Webflow, Wix, Squarespace,
// BigCommerce, Duda and HubSpot. All 7 share the same visual template:
//
//   1. Header (title + subtitle + brand glyph)
//   2. Optional warning/security banner
//   3. Credential form (variable fields) with a themed Connect button
//   4. Numbered step-by-step setup guide
//   5. FAQ list
//   6. "What you get" 3-column feature grid
//
// Instead of coding each panel by hand, callers pass a config object.
// See PROVIDER_CONFIGS at the bottom of this file for the per-provider setup.

const BlogIntegrationForm = ({ config, onCancel, onConnected, onSubmit }) => {
  const [values, setValues] = useState(() =>
    Object.fromEntries((config.fields || []).map(f => [f.key, f.default || '']))
  );
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');

  const set = (k, v) => setValues(prev => ({ ...prev, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    // Required check.
    const missing = (config.fields || []).find(f => f.required && !String(values[f.key] || '').trim());
    if (missing) {
      setErr(`Please fill in "${missing.label}".`);
      return;
    }
    setSubmitting(true);
    setErr('');
    try {
      // Prefer the real-backend onSubmit prop. Fall back to placeholder for
      // providers that aren't wired yet (Shopify, Squarespace, etc.).
      if (onSubmit) {
        const row = await onSubmit(values);
        onConnected && onConnected(row);
      } else {
        await new Promise(r => setTimeout(r, 400));
        onConnected && onConnected({
          id: `${config.providerKey}-placeholder`,
          provider: config.providerKey,
          display_name: values[config.displayField] || config.brandName,
          status: 'active',
        });
      }
    } catch (e2) {
      setErr(e2?.response?.data?.error || e2?.message || 'Failed to connect');
    } finally {
      setSubmitting(false);
    }
  };

  // Shopify-style flow uses an install-app button rather than a credential form.
  if (config.installApp) {
    return (
      <div className="space-y-5">
        <IntegrationHeader config={config} />

        <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-lg flex items-start gap-3">
          <div className="h-10 w-10 rounded-md bg-white flex items-center justify-center flex-shrink-0">
            <ShoppingBag className="h-5 w-5 text-emerald-700" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-gray-900">{config.installApp.title}</h3>
            <p className="text-xs text-gray-600 mt-0.5">{config.installApp.subtitle}</p>
          </div>
          <a
            href={config.installApp.href}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-2 border border-gray-300 bg-white rounded-md text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Install App
          </a>
        </div>

        <FeaturesGrid features={config.features} />
        <FooterNav onCancel={onCancel} />
      </div>
    );
  }

  const buttonThemes = {
    gray: 'bg-gray-900 hover:bg-gray-800 text-white',
    indigo: 'bg-indigo-600 hover:bg-indigo-700 text-white',
    amber: 'bg-amber-500 hover:bg-amber-600 text-white',
    blue: 'bg-blue-600 hover:bg-blue-700 text-white',
    orange: 'bg-orange-500 hover:bg-orange-600 text-white',
    emerald: 'bg-emerald-600 hover:bg-emerald-700 text-white',
  };
  const buttonClass = buttonThemes[config.buttonTheme] || buttonThemes.emerald;

  const guideBg = {
    gray: 'bg-gray-50 border-gray-200 text-gray-800',
    indigo: 'bg-indigo-50 border-indigo-200 text-indigo-800',
    amber: 'bg-amber-50 border-amber-200 text-amber-800',
    blue: 'bg-blue-50 border-blue-200 text-blue-800',
    orange: 'bg-orange-50 border-orange-200 text-orange-800',
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-800',
  }[config.buttonTheme] || 'bg-gray-50 border-gray-200 text-gray-800';

  return (
    <div className="space-y-5">
      <IntegrationHeader config={config} />

      {config.warning && (
        <div className="p-3 bg-amber-50 border border-amber-200 rounded-md text-xs text-amber-900">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <div className="flex-1">
              <p className="font-semibold mb-1">{config.warning.title}</p>
              <ul className="list-disc ml-4 space-y-1">
                {config.warning.bullets.map((b, i) => (
                  <li key={i} dangerouslySetInnerHTML={{ __html: b }} />
                ))}
              </ul>
              {config.warning.footnote && (
                <p className="mt-2 text-[11px] text-amber-800/80" dangerouslySetInnerHTML={{ __html: config.warning.footnote }} />
              )}
            </div>
          </div>
        </div>
      )}

      <form onSubmit={submit} className="border border-gray-200 rounded-lg p-4 space-y-4">
        <FieldGrid fields={config.fields} values={values} set={set} />
        {err && (
          <div className="p-2 bg-red-50 border border-red-200 rounded text-xs text-red-800">{err}</div>
        )}
        <button
          type="submit"
          disabled={submitting}
          className={`inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-md disabled:opacity-50 disabled:cursor-not-allowed ${buttonClass}`}
        >
          {submitting ? 'Connecting…' : (config.buttonLabel || 'Connect')}
        </button>
      </form>

      {config.steps?.length > 0 && (
        <div className={`border rounded-lg overflow-hidden ${guideBg.replace('text-', 'text-')}`}>
          <div className={`px-4 py-2 flex items-center gap-2 border-b ${guideBg.split(' ')[0]} ${guideBg.split(' ')[1]}`}>
            <Info className="h-4 w-4" />
            <span className="text-xs font-semibold">Step-by-step setup guide</span>
          </div>
          <ol className="p-4 space-y-4 bg-white">
            {config.steps.map((s, i) => (
              <li key={i} className="flex gap-3">
                <span className={`flex-shrink-0 h-6 w-6 rounded-full text-white text-xs font-semibold inline-flex items-center justify-center ${
                  {
                    gray: 'bg-gray-800',
                    indigo: 'bg-indigo-500',
                    amber: 'bg-amber-500',
                    blue: 'bg-blue-500',
                    orange: 'bg-orange-500',
                    emerald: 'bg-emerald-500',
                  }[config.buttonTheme] || 'bg-gray-800'
                }`}>{i + 1}</span>
                <div className="flex-1 min-w-0 text-xs">
                  <p className="font-semibold text-gray-900">{s.title}</p>
                  <p className="text-gray-600 mt-0.5" dangerouslySetInnerHTML={{ __html: s.body }} />
                  {s.hint && (
                    <p className="text-amber-700 mt-1" dangerouslySetInnerHTML={{ __html: s.hint }} />
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}

      {config.faq?.length > 0 && (
        <div className="border border-gray-200 rounded-lg p-4">
          <h4 className="text-sm font-semibold text-gray-900 mb-3">Frequently Asked Questions</h4>
          <div className="space-y-3">
            {config.faq.map((q, i) => (
              <div key={i}>
                <p className="text-xs font-semibold text-gray-900">{q.q}</p>
                <p className="text-xs text-gray-600 mt-0.5" dangerouslySetInnerHTML={{ __html: q.a }} />
              </div>
            ))}
          </div>
        </div>
      )}

      <FeaturesGrid features={config.features} />
      <FooterNav onCancel={onCancel} />
    </div>
  );
};

const IntegrationHeader = ({ config }) => {
  const Icon = config.brandIcon;
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="text-base font-semibold text-gray-900">{config.title}</h3>
        <p className="text-xs text-gray-500 mt-0.5">{config.subtitle}</p>
      </div>
      <div className={`h-10 w-10 rounded-md flex items-center justify-center flex-shrink-0 ${config.brandBg}`}>
        <Icon className={`h-5 w-5 ${config.brandColor}`} />
      </div>
    </div>
  );
};

const FieldGrid = ({ fields, values, set }) => {
  // Group fields by row-hint: `half: true` puts two fields side by side,
  // `groupTitle` starts a new subsection with a heading.
  const groups = [];
  let currentGroup = { title: null, subtitle: null, rows: [] };
  let currentRow = [];
  const flush = () => {
    if (currentRow.length) {
      currentGroup.rows.push(currentRow);
      currentRow = [];
    }
  };
  const flushGroup = () => {
    flush();
    if (currentGroup.rows.length || currentGroup.title) {
      groups.push(currentGroup);
    }
    currentGroup = { title: null, subtitle: null, rows: [] };
  };
  for (const f of fields) {
    if (f.groupTitle) {
      flushGroup();
      currentGroup.title = f.groupTitle;
      currentGroup.subtitle = f.groupSubtitle;
      continue;
    }
    if (f.half) {
      currentRow.push(f);
      if (currentRow.length === 2) flush();
    } else {
      flush();
      currentRow = [f];
      flush();
    }
  }
  flushGroup();

  return (
    <div className="space-y-4">
      {groups.map((g, gi) => (
        <div key={gi}>
          {g.title && (
            <div className="mb-2">
              <p className="text-sm font-medium text-gray-800">
                {g.title}
                {g.subtitle && <span className="ml-1 text-xs font-normal text-gray-500">{g.subtitle}</span>}
              </p>
            </div>
          )}
          <div className="space-y-3">
            {g.rows.map((row, ri) => (
              <div key={ri} className={row.length === 2 ? 'grid grid-cols-1 sm:grid-cols-2 gap-3' : row.length === 3 ? 'grid grid-cols-1 sm:grid-cols-3 gap-3' : ''}>
                {row.map(f => <Field key={f.key} field={f} value={values[f.key]} set={set} />)}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
};

const Field = ({ field, value, set }) => (
  <div>
    <label className="block text-xs font-medium text-gray-700 mb-1">
      {field.label}
      {field.required && <span className="text-red-500 ml-0.5">*</span>}
      {field.optionalNote && <span className="ml-1 text-[11px] font-normal text-gray-400">{field.optionalNote}</span>}
    </label>
    <input
      type={field.type || 'text'}
      value={value}
      onChange={e => set(field.key, e.target.value)}
      placeholder={field.placeholder}
      autoComplete={field.type === 'password' ? 'off' : undefined}
      className={`w-full px-3 py-2 border border-gray-300 rounded-md text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 ${field.mono ? 'font-mono' : ''}`}
    />
    {field.help && (
      <p className="text-[11px] text-gray-500 mt-1" dangerouslySetInnerHTML={{ __html: field.help }} />
    )}
  </div>
);

const FeaturesGrid = ({ features }) => (
  features?.length ? (
    <div>
      <h4 className="text-sm font-semibold text-gray-900 mb-2">What you get</h4>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {features.map((f, i) => (
          <div key={i} className="p-3 border border-gray-200 rounded-md flex items-start gap-2">
            <Check className="h-4 w-4 text-emerald-600 mt-0.5 flex-shrink-0" />
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

// ---------------------------------------------------------------------------
// Brand glyphs — inline so we don't add a brand-icons dep.
// ---------------------------------------------------------------------------

const brandGlyph = (letters, extra = '') => function Glyph({ className = '' }) {
  return <span className={`inline-flex items-center justify-center font-bold text-[13px] leading-none ${extra} ${className}`}>{letters}</span>;
};

export const SquarespaceGlyph = brandGlyph('◎');
export const BigCommerceGlyph = brandGlyph('B');
export const DudaGlyph = brandGlyph('D');
export const HubSpotGlyph = brandGlyph('◈');
export const GoHighLevelGlyph = brandGlyph('↑↑');

// ---------------------------------------------------------------------------
// Provider configs
// ---------------------------------------------------------------------------

export const PROVIDER_CONFIGS = {
  shopify: {
    providerKey: 'shopify',
    brandName: 'Shopify',
    brandIcon: ShoppingBag,
    brandColor: 'text-emerald-700',
    brandBg: 'bg-emerald-50',
    title: 'Shopify Store Blog',
    subtitle: 'Publish articles directly to your Shopify blog on autopilot. Your content brings customers to your store.',
    buttonTheme: 'emerald',
    installApp: {
      title: 'Install Post-to on your Shopify Store',
      subtitle: 'Publish SEO-optimized articles directly to your Shopify blog on autopilot.',
      href: 'https://apps.shopify.com/',
    },
    features: [
      { title: 'Automatic Publishing', desc: 'Articles publish to your Shopify blog automatically' },
      { title: 'SEO Optimized', desc: 'Content optimized to bring customers to your store' },
      { title: 'Multilingual Support', desc: 'Publish in multiple languages for international stores' },
    ],
  },

  webflow: {
    providerKey: 'webflow',
    brandName: 'Webflow',
    brandIcon: null, // filled at import time from Connections.js
    brandColor: 'text-indigo-600',
    brandBg: 'bg-indigo-50',
    title: 'Webflow CMS',
    subtitle: 'Connect your Webflow site to publish articles directly to your CMS collections',
    buttonTheme: 'indigo',
    buttonLabel: 'Connect',
    displayField: 'apiToken',
    fields: [
      { groupTitle: 'Connect with API Token', groupSubtitle: '— generate a token in your Webflow site settings and paste it below. Takes about 2 minutes.' },
      { key: 'apiToken', label: 'Webflow API Token', placeholder: 'Paste your Webflow API token here…', required: true, mono: true },
    ],
    steps: [
      { title: 'Open your site settings', body: 'Go to <a href="https://webflow.com/dashboard" target="_blank" rel="noreferrer" class="text-indigo-600 hover:underline">webflow.com/dashboard</a>, find your site, and click the <strong>Settings</strong> (gear) icon.' },
      { title: 'Go to Apps & Integrations', body: 'In the left sidebar, click <strong>Apps &amp; Integrations</strong>.' },
      { title: 'Generate API Token', body: 'Scroll down to the <strong>API access</strong> section and click <strong>Generate API token</strong>.' },
      { title: 'Set permissions: Sites → Read and Write', body: 'In the token dialog, find <strong>Sites</strong> and set it to <strong>Read and write</strong>.' },
      { title: 'Set permissions: CMS → Read and Write', body: 'Also set <strong>CMS</strong> to <strong>Read and write</strong>. This lets us publish articles to your collections.' },
      { title: 'Name your token and generate', body: 'Give it any name (e.g. "Post-to"), confirm CMS is set to Read and write, then click <strong>Generate token</strong>.' },
      { title: 'Copy your token', body: "Copy the token and paste it in the field above. <strong>Webflow only shows it once</strong> — if you lose it, you'll need to generate a new one." },
    ],
    faq: [
      { q: 'Only seeing Name and Slug in field mapping?', a: 'Your CMS collection needs additional fields (Rich Text, Image, etc.) — add them in the Webflow Designer, then reopen the mapping.' },
      { q: 'Blog content not displaying in the Webflow Editor?', a: 'Confirm your published collection template renders the Rich Text field. Publishing succeeds even if the template is missing.' },
      { q: 'Site or collection not showing?', a: 'Your token needs Sites and CMS both set to Read and write. Regenerate with correct permissions.' },
      { q: 'Publish fails?', a: 'Check the token has CMS Read & Write. Also make sure the collection has fields matching the article schema.' },
      { q: 'What if I regenerate my API token?', a: 'Paste the new token here — the old one stops working immediately.' },
      { q: 'Will articles go live immediately?', a: 'Optional. You can toggle Auto Publish per site; otherwise they land as staged items in your CMS.' },
      { q: 'Do I need a specific Webflow plan?', a: "Any paid Site plan works. You'll need CMS Hosting to receive published items." },
      { q: 'Wrong workspace or site?', a: 'Tokens are per-site — generate one from the site you want to publish to.' },
    ],
    features: [
      { title: 'Direct Publishing', desc: 'Push articles to CMS collections automatically' },
      { title: 'Field Mapping', desc: 'Customize how content maps to your fields' },
      { title: 'Auto Publish', desc: 'Optional auto-publish to your live site' },
    ],
  },

  wix: {
    providerKey: 'wix',
    brandName: 'Wix',
    brandIcon: null,
    brandColor: 'text-amber-700',
    brandBg: 'bg-amber-50',
    title: 'Wix Blog Integration',
    subtitle: 'Publish your SEO-optimized articles directly to your Wix blog. Connect once and let your content work for you.',
    buttonTheme: 'amber',
    buttonLabel: 'Connect',
    displayField: 'siteId',
    fields: [
      { groupTitle: 'Connect Your Wix Site', groupSubtitle: '— enter your Wix Site ID and API Key to start publishing articles to your Wix blog automatically.' },
      { key: 'siteId', label: 'Site ID', placeholder: 'e.g. 01c24d92-2ba6-48bd-90cd-87e33d2e9957', required: true, mono: true, help: 'Open your Wix dashboard — the Site ID is in the URL after <code>dashboard/</code>' },
      { key: 'apiKey', label: 'API Key', placeholder: 'Paste your Wix API key here', required: true, mono: true, help: 'Generate an API key in Wix: Avatar → Account Settings → API Keys. Enable <strong>Wix Contacts</strong> &amp; <strong>Wix Blog</strong> permissions.' },
    ],
    steps: [
      { title: 'Find Your Site ID', body: 'Open your <a href="https://manage.wix.com/" target="_blank" rel="noreferrer" class="text-amber-700 hover:underline">Wix dashboard</a>. In the address bar, copy the ID after <code>dashboard/</code>.' },
      { title: 'Open Account Settings', body: 'Click your avatar (top right) → <strong>Account Settings</strong>.' },
      { title: 'Go to API Keys', body: 'In the left sidebar, click <strong>API Keys</strong>.' },
      { title: 'Click Generate API Key', body: 'Click the <strong>+ Generate API Key</strong> button in the top right.' },
      { title: 'Name it & expand permissions', body: 'Name the key "Post-to". Under <strong>Permissions</strong>, find <strong>All site permissions</strong> and click <strong>See all</strong> to expand.' },
      { title: 'Enable Wix Contacts & Wix Blog', body: 'Scroll down and check the boxes for <strong>Wix Contacts &amp; Members</strong> and <strong>Wix Blog</strong>.' },
      { title: 'Generate & Verify', body: 'Click <strong>Generate Key</strong>. Wix will send a verification code to your email. Enter the code and click <strong>Verify &amp; Generate Key</strong>.' },
      { title: 'Copy the Token', body: "Click <strong>Copy Token &amp; Close</strong>. This is your API Key — you won't be able to see it again." },
      { title: 'Paste & Connect', body: "Enter your Site ID and API Key above, then click <strong>Connect</strong>. We'll verify the connection and start publishing your articles automatically." },
    ],
    faq: [
      { q: 'Site not connecting?', a: 'Double-check your Site ID from the URL after <code>dashboard/</code> in your Wix dashboard.' },
      { q: 'API Key issues?', a: 'Regenerate the key in Wix and confirm both permissions (<strong>Wix Contacts &amp; Members</strong> and <strong>Wix Blog</strong>) are enabled.' },
      { q: 'Publish fails?', a: 'Ensure your API Key is valid and has the required permissions. Verify that your blog exists in Wix.' },
      { q: 'Can I change publish status later?', a: 'Yes. Update your integration settings in Post-to to change between Publish Immediately and Draft mode.' },
      { q: 'What happens if I regenerate my API key?', a: 'You must update the new API key in Post-to. The old key will stop working immediately.' },
      { q: 'Need more help?', a: 'Contact support via the bottom-right chat icon.' },
    ],
    features: [
      { title: 'Automatic Publishing', desc: 'Articles publish to your Wix blog automatically' },
      { title: 'Rich Content', desc: 'Full formatting with headings, images, and links' },
      { title: 'Hero Images', desc: 'Cover images sync with your posts automatically' },
    ],
  },

  squarespace: {
    providerKey: 'squarespace',
    brandName: 'Squarespace',
    brandIcon: null,
    brandColor: 'text-gray-900',
    brandBg: 'bg-gray-100',
    title: 'Squarespace Blog Integration',
    subtitle: 'Publish articles directly to your Squarespace website blog',
    buttonTheme: 'gray',
    buttonLabel: 'Connect',
    displayField: 'website',
    warning: {
      title: 'Important security steps before connecting',
      bullets: [
        '<strong>Create a unique password</strong> in your Squarespace account just for this connection. Do NOT reuse a password from any other account.',
        '<strong>Turn off two-factor authentication</strong> on your Squarespace account — all methods (passkeys, authenticator app, text message). (<a href="https://account.squarespace.com/settings/security" target="_blank" rel="noreferrer" class="underline">Go to 2FA settings</a>)',
      ],
      footnote: '🔒 Your password is encrypted with AES-256 and never stored in plain text.',
    },
    fields: [
      { key: 'website', label: 'Your Website Address', placeholder: 'yourbusiness.com', required: true, help: 'The address people visit your site at — e.g. <code>yourbusiness.com</code>. We\'ll figure out the rest.' },
      { key: 'email', label: 'Squarespace Email', type: 'email', placeholder: 'your@email.com', required: true, half: true },
      { key: 'password', label: 'Squarespace Password', type: 'password', placeholder: 'Your unique Squarespace password', required: true, half: true },
    ],
    steps: [
      { title: 'Change Your Squarespace Password', body: 'Go to your <a href="https://account.squarespace.com/settings/security" target="_blank" rel="noreferrer" class="text-gray-800 underline">Squarespace Account Security settings</a> and change your password to a <strong>new, unique password</strong> that you don\'t use anywhere else.', hint: '<strong>Why?</strong> This protects your other accounts. If you ever disconnect Post-to, just change your Squarespace password back.' },
      { title: 'Turn Off Two-Factor Authentication', body: 'In your <a href="https://account.squarespace.com/settings/security" target="_blank" rel="noreferrer" class="text-gray-800 underline">Two-factor authentication settings</a>, turn off all verification methods (passkeys, authenticator app, text message). Post-to needs to log in to publish articles and cannot pass verification codes.' },
      { title: 'Make Sure Your Site Has a Blog', body: 'In the Squarespace editor, make sure you have a <strong>Blog</strong> page added. If you don\'t have one yet, add it from <strong>Pages → + → Blog</strong>.' },
      { title: 'Enter Your Credentials & Connect', body: 'Fill in the form above with your <strong>website address</strong> (e.g. <code>yourbusiness.com</code>), your <strong>Squarespace email</strong>, and your <strong>new unique password</strong>. Then click <strong>Connect</strong>.', hint: 'Don\'t worry about getting the domain format exactly right — we\'ll automatically detect the correct one from your Squarespace account.' },
    ],
    faq: [
      { q: 'Why do I need a unique password?', a: 'Your password is encrypted and stored securely, but using a unique password ensures your other accounts stay safe no matter what. You can always change it back later.' },
      { q: 'Why do I need to turn off 2FA and login verification?', a: 'Post-to logs into your Squarespace account to publish articles. Any verification step (2FA, email codes, or login verification) blocks automated logins because there\'s no way to enter the code automatically.' },
      { q: 'Is my password stored securely?', a: 'Yes. Your password is encrypted with <strong>AES-256</strong> — the same encryption standard used by banks and governments. It is never stored in plain text.' },
      { q: 'What should I enter for the website address?', a: 'Enter the address your visitors use — like <code>yourbusiness.com</code>. We\'ll automatically detect the correct Squarespace site from your account, so you don\'t need to worry about the exact format.' },
      { q: 'What if I change my Squarespace password later?', a: 'You\'ll need to update it here too — come back to this page and enter your new password. We\'ll let you know if your password stops working.' },
      { q: 'What happens if I disconnect?', a: 'Your published articles remain on your Squarespace site. We delete your stored credentials immediately. You can then change your Squarespace password back to your regular one.' },
      { q: 'Need more help?', a: 'Contact support via the bottom-right chat icon.' },
    ],
    features: [
      { title: 'Automatic Publishing', desc: 'Articles publish to your Squarespace blog automatically' },
      { title: 'Rich HTML Content', desc: 'Full formatting with headings, images, and links' },
      { title: 'SEO Metadata', desc: 'Meta titles, descriptions, and hero images included' },
    ],
  },

  bigcommerce: {
    providerKey: 'bigcommerce',
    brandName: 'BigCommerce',
    brandIcon: null,
    brandColor: 'text-blue-700',
    brandBg: 'bg-blue-50',
    title: 'BigCommerce Blog Integration',
    subtitle: 'Publish articles directly to your BigCommerce store blog',
    buttonTheme: 'blue',
    buttonLabel: 'Connect',
    displayField: 'storeHash',
    fields: [
      { key: 'storeHash', label: 'Store Hash', placeholder: 'e.g. mh5fua96uw', required: true, mono: true, help: 'The part after <code>store-</code> in your BigCommerce URL.', half: true },
      { key: 'accessToken', label: 'Access Token', placeholder: 'Paste your Access Token here', required: true, mono: true, help: 'From a Store-level API account with Content <strong>modify</strong> access.', half: true },
      { groupTitle: 'WebDAV Credentials', groupSubtitle: '(optional — for image uploads)' },
      { key: 'webdavUrl', label: 'WebDAV URL', placeholder: 'https://store-abc.mybigcommerce.com/dav' },
      { key: 'webdavUser', label: 'WebDAV Username', placeholder: 'Username', half: true },
      { key: 'webdavPass', label: 'WebDAV Password', placeholder: 'Password', type: 'password', half: true },
      { key: 'authorName', label: 'Author Name', optionalNote: '(optional)', placeholder: 'Name to show on published posts' },
    ],
    steps: [
      { title: 'Get Your Store Hash', body: 'Open your BigCommerce store URL. In the address bar, copy the part between <code>store-</code> and <code>.mybigcommerce.com</code>.<br/>Example: <code>https://store-mh5fua96uw.mybigcommerce.com/...</code> → Store Hash: <strong>mh5fua96uw</strong>' },
      { title: 'Open API Accounts', body: 'In BigCommerce, go to <strong>Settings</strong> (left sidebar) → scroll down to the <strong>API</strong> section → click <strong>Store-level API accounts</strong>.' },
      { title: 'Create API Account', body: 'Click <strong>Create API account</strong> (top right). Select token type <strong>V2/V3 API token</strong>. Name it <strong>"Post-to"</strong>.' },
      { title: 'Set Content Permission', body: 'Under <strong>Content</strong>, choose <strong>modify</strong> access. This allows Post-to to create and update blog posts.' },
      { title: 'Save & Copy the Access Token', body: 'Click <strong>Save</strong>. Copy the Access Token immediately. BigCommerce only shows it once.' },
      { title: 'Get WebDAV Credentials (optional)', body: 'In BigCommerce, go to <strong>Settings</strong> → scroll to <strong>Advanced</strong> → click <strong>File access (WebDAV)</strong>. Copy the WebDAV Path, Username, and Password.<br/>These credentials allow Post-to to upload article thumbnail images to your store.' },
      { title: 'Paste & Connect', body: "Enter your Store Hash and Access Token above, then click <strong>Connect</strong>. We'll verify the connection and start publishing your articles automatically." },
    ],
    faq: [
      { q: 'Store not connecting?', a: 'Double-check your Store Hash from the URL between <code>store-</code> and <code>.mybigcommerce.com</code>.' },
      { q: 'Access Token issues?', a: 'Create a new API account in BigCommerce and confirm <strong>Content</strong> is set to <strong>modify</strong>.' },
      { q: 'Images not uploading?', a: 'Ensure your WebDAV credentials are correct. Go to <strong>Settings → Advanced → File access (WebDAV)</strong> to verify.' },
      { q: 'What happens if I regenerate my API key?', a: 'You must update the new Access Token in Post-to. The old token will stop working immediately.' },
      { q: 'Need more help?', a: 'Contact support via the bottom-right chat icon.' },
    ],
    features: [
      { title: 'Automatic Publishing', desc: 'Articles publish to your BigCommerce blog automatically' },
      { title: 'Rich HTML Content', desc: 'Full formatting with headings, images, and links' },
      { title: 'Image Thumbnails', desc: 'Hero images uploaded via WebDAV as post thumbnails' },
    ],
  },

  duda: {
    providerKey: 'duda',
    brandName: 'Duda',
    brandIcon: null,
    brandColor: 'text-indigo-600',
    brandBg: 'bg-indigo-50',
    title: 'Duda Blog Integration',
    subtitle: 'Publish articles directly to your Duda website blog',
    buttonTheme: 'indigo',
    buttonLabel: 'Connect',
    displayField: 'siteName',
    fields: [
      { key: 'siteName', label: 'Site Name', placeholder: 'e.g. 1501ccca016a4220861ef07fe2c8eb0d', required: true, mono: true, help: 'Found in the URL bar when editing your site in the Duda editor.' },
      { key: 'apiUser', label: 'API Username', placeholder: 'Your API username', required: true, half: true },
      { key: 'apiPass', label: 'API Password', placeholder: 'Your API password', type: 'password', required: true, half: true },
    ],
    steps: [
      { title: 'Find Your Site Name', body: 'Open the Duda editor for your site. The <strong>site_name</strong> is in the URL bar — it\'s the unique identifier for your site (a long alphanumeric string).<br/>Example: <code>https://my.duda.co/home/site/1501ccca016a4220861ef07fe2c8eb0d</code>' },
      { title: 'Open API Access Settings', body: 'In your Duda dashboard, go to <strong>White Label</strong> (left sidebar) → <strong>API Access</strong>. This is where your API credentials are located.', hint: '<strong>Note:</strong> API access requires a Duda <strong>Agency</strong> plan or higher.' },
      { title: 'Copy Your API Username & Password', body: 'Your <strong>API Username</strong> and <strong>API Password</strong> are shown on the API Access page. If you haven\'t set a password yet, you can reset it to generate one.<br/>If you reset your password, existing integrations using the old password will stop working.' },
      { title: 'Make Sure Your Site Has a Blog', body: 'Open the Duda editor for your site. If you haven\'t already, add the <strong>Blog</strong> feature from the editor. Your site needs a blog enabled for Post-to to publish articles.' },
      { title: 'Paste & Connect', body: "Enter your Site Name, API Username, and API Password above, then click <strong>Connect</strong>. We'll verify the connection and start publishing your articles automatically." },
    ],
    faq: [
      { q: 'Where do I find API Access?', a: 'Log in to Duda → <strong>White Label</strong> (left sidebar) → <strong>API Access</strong>. If you don\'t see this option, your plan may not include API access.' },
      { q: 'What plan do I need?', a: "Duda's Blog API requires an <strong>Agency plan</strong> or higher. Contact Duda if you're on a lower plan." },
      { q: 'Site not connecting?', a: 'Double-check the Site Name from your Duda URL. Make sure the blog feature is enabled on your site.' },
      { q: 'What happens if I reset my API password?', a: 'You must update the new password in Post-to. The old password will stop working immediately.' },
      { q: 'Need more help?', a: 'Contact support via the bottom-right chat icon.' },
    ],
    features: [
      { title: 'Automatic Publishing', desc: 'Articles publish to your Duda blog automatically' },
      { title: 'Rich HTML Content', desc: 'Full formatting with headings, images, and links' },
      { title: 'Hero Images', desc: 'Cover images sync with your posts automatically' },
    ],
  },

  gohighlevel: {
    providerKey: 'gohighlevel',
    brandName: 'GoHighLevel',
    brandIcon: null,
    brandColor: 'text-gray-100',
    brandBg: 'bg-gray-900',
    title: 'GoHighLevel Blog Integration',
    subtitle: 'Publish articles directly to your GoHighLevel blog',
    buttonTheme: 'blue',
    buttonLabel: 'Connect',
    displayField: 'locationId',
    fields: [
      { key: 'token', label: 'Private Integration Token', placeholder: 'pit-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', required: true, mono: true, help: 'Found in your GoHighLevel Private Integration settings.' },
      { key: 'locationId', label: 'Location ID', placeholder: 'e.g. ve9EPM428h8vShlRW1KT', required: true, mono: true, help: 'Your sub-account ID. Found in <strong>Settings → Business Profile</strong>, or in the URL when logged in.' },
    ],
    steps: [
      { title: 'Open Your GoHighLevel Settings', body: 'Log in to <a href="https://app.gohighlevel.com" target="_blank" rel="noreferrer" class="text-blue-600 hover:underline">app.gohighlevel.com</a> and click <strong>Settings</strong> in the bottom-left sidebar.' },
      { title: 'Create a Private Integration', body: 'Navigate to <strong>Settings → Integrations → Private Integrations</strong>. Click <strong>"Create new Integration"</strong>.<br/>Give it a name like <code>Post-to Blog Publisher</code>.' },
      { title: 'Set the Required Permissions', body: 'On the <strong>Scopes</strong> step, enable these blog-related permissions:<br/><ul class="list-disc ml-4 mt-1"><li><strong>blogs/post.write</strong> — Create blog posts</li><li><strong>blogs/post-update.write</strong> — Update blog posts</li><li><strong>blogs/list.readonly</strong> — List available blogs</li><li><strong>blogs/author.readonly</strong> — Get blog authors</li><li><strong>medias.write</strong> — Add your article images to GoHighLevel</li></ul>' },
      { title: 'Copy the Token', body: 'After creating the integration, <strong>copy the generated token</strong>. You won\'t be able to see it again later.<br/>Paste it in the "Private Integration Token" field above.' },
      { title: 'Find Your Location ID', body: 'Go to <strong>Settings → Business Profile</strong>. Your Location ID (also called Sub-Account ID) is displayed there, or you can find it in the URL bar when logged into a sub-account.<br/>It looks like a long alphanumeric string, e.g. <code>ve9EPM428h8vShlRW1KT</code>.' },
      { title: 'Click Connect', body: 'Paste both values above and click <strong>"Connect"</strong>. We\'ll automatically find your blog and start publishing articles.' },
    ],
    faq: [
      { q: 'Do I need a specific GoHighLevel plan?', a: 'You need a GoHighLevel plan that includes the Blog/Website Builder feature. Most Agency plans include this.' },
      { q: 'Where do I find my Location ID?', a: 'Log into your sub-account. Go to <strong>Settings → Business Profile</strong>. The Location ID is displayed on that page. You can also find it in the URL bar.' },
      { q: 'Is my token stored securely?', a: 'Yes, your Private Integration token is encrypted before storage and never shown in plain text.' },
      { q: 'Can I remove articles from GoHighLevel?', a: 'When you delete an article here, it will be archived on GoHighLevel automatically. You can fully delete it from GoHighLevel\'s blog manager if needed.' },
    ],
    features: [
      { title: 'Auto-publish', desc: 'Articles go live on your GoHighLevel blog automatically' },
      { title: 'Full SEO', desc: 'Meta titles, descriptions, and featured images included' },
      { title: 'Media Upload', desc: 'Article images uploaded to your GoHighLevel media library' },
    ],
  },

  hubspot: {
    providerKey: 'hubspot',
    brandName: 'HubSpot',
    brandIcon: null,
    brandColor: 'text-orange-600',
    brandBg: 'bg-orange-50',
    title: 'HubSpot Blog Integration',
    subtitle: 'Publish articles directly to your HubSpot CMS blog',
    buttonTheme: 'orange',
    buttonLabel: 'Connect',
    displayField: 'accessToken',
    fields: [
      { key: 'accessToken', label: 'Access Token', placeholder: 'pat-na1-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', required: true, mono: true, help: 'Found in your HubSpot Legacy App settings. We\'ll auto-detect your blog.' },
    ],
    steps: [
      { title: 'Go to Legacy Apps', body: 'Log in to <a href="https://app.hubspot.com" target="_blank" rel="noreferrer" class="text-orange-600 hover:underline">app.hubspot.com</a>. In the top navigation bar, click <strong>Development</strong>, then click <strong>Legacy Apps</strong> in the left sidebar.' },
      { title: 'Create a Legacy Private App', body: 'Click <strong>"Create legacy app"</strong> in the top right, then select <strong>Private</strong> in the dialog box.<br/>Give it a name like <code>Post-to Blog Publisher</code>.' },
      { title: 'Set the Required Scopes', body: 'Click the <strong>"Scopes"</strong> tab, then click <strong>"Add new scope"</strong>. Add both:<br/><ul class="list-disc ml-4 mt-1"><li><code>content</code> — create, update, and publish blog posts</li><li><code>files</code> — upload article images into your HubSpot File Manager</li></ul>Then click "Update". Without the files scope, images stay on Post-to hosting.' },
      { title: 'Create the App & Copy the Token', body: 'Click <strong>"Create app"</strong> in the top right, then click <strong>"Continue creating"</strong> to confirm. HubSpot will show your access token. Click <strong>"Show token"</strong> and copy it.<br/>The token starts with <code>pat-na1-</code> or similar. Keep it safe — you won\'t be able to see it again.' },
      { title: 'Paste the Token Above & Connect', body: "Paste your access token in the field above and click <strong>Connect</strong>. We'll automatically detect your blog and start publishing articles there." },
    ],
    faq: [
      { q: 'Which HubSpot plan do I need?', a: 'The Blog API requires <strong>Content Hub Professional</strong> or higher. Starter and Free plans don\'t include blog API access.' },
      { q: 'Do I need to be a super admin?', a: 'Yes. Only super admins can create legacy private apps in HubSpot.' },
      { q: 'What if I have multiple blogs?', a: 'We\'ll ask you to choose which blog to publish to. You can also change it anytime after connecting with the "Change blog" button.' },
      { q: 'Where are article images hosted?', a: 'We upload hero and infographic images to your HubSpot File Manager (folder: /post-to), so they load from HubSpot — not from Post-to.' },
    ],
    features: [
      { title: 'Auto-publish', desc: 'Articles go live on your HubSpot blog automatically' },
      { title: 'Full SEO', desc: 'Meta titles, descriptions, and featured images included' },
      { title: 'Keeps in sync', desc: 'Content updates and deletions sync automatically' },
    ],
  },
};

export default BlogIntegrationForm;
