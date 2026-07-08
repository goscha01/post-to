import React, { useState } from 'react';
import { Check, Sparkles, ArrowRight, ChevronDown } from 'lucide-react';

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------
const PLANS = [
  {
    name: 'Starter',
    price: 29,
    tagline: 'For solo owners getting consistent',
    highlight: false,
    features: [
      '1 business location',
      'Google Business + Website + GA4',
      '20 AI-generated posts / month',
      '10 AI review replies / month',
      'Basic analytics dashboard',
      'Email support'
    ]
  },
  {
    name: 'Growth',
    price: 79,
    tagline: 'The AI marketing manager',
    highlight: true,
    features: [
      'Up to 3 locations',
      'All social channels (Instagram, Facebook, LinkedIn, X)',
      'Unlimited AI posts, blog articles, replies',
      'Review → 5 marketing assets',
      'Multi-channel scheduling & autopilot',
      'AI recommendations & trend spotting',
      'Full analytics + campaign attribution',
      'Priority support'
    ]
  },
  {
    name: 'Multi-location',
    price: 199,
    tagline: 'For franchises & multi-brand operators',
    highlight: false,
    features: [
      'Unlimited locations',
      'Everything in Growth',
      'Google Ads + Meta Ads integration',
      'ROI reporting across all channels',
      'Brand voice controls per location',
      'Team roles & approvals',
      'API access',
      'Dedicated success manager'
    ]
  }
];

const Pricing = ({ onCtaClick }) => (
  <section id="pricing" className="relative py-24 md:py-28 bg-slate-50/60 border-y border-slate-100">
    <div className="max-w-7xl mx-auto px-6 lg:px-8">
      <div className="max-w-2xl mx-auto text-center mb-14">
        <div className="inline-flex items-center gap-2 text-xs font-semibold text-primary-700 bg-primary-50 rounded-full px-3 py-1 mb-4">
          Pricing
        </div>
        <h2 className="text-3xl md:text-5xl font-bold tracking-tight text-slate-900">
          Priced like software.
          <br />
          Works like a marketing team.
        </h2>
        <p className="mt-4 text-lg text-slate-600">
          Start free for 14 days. Cancel anytime. No credit card to try.
        </p>
      </div>

      <div className="grid md:grid-cols-3 gap-6 max-w-6xl mx-auto">
        {PLANS.map((p) => (
          <div
            key={p.name}
            className={`relative rounded-3xl p-8 flex flex-col transition ${
              p.highlight
                ? 'bg-slate-900 text-white ring-1 ring-slate-800 shadow-2xl shadow-primary-900/20 md:-translate-y-2'
                : 'bg-white ring-1 ring-slate-200'
            }`}
          >
            {p.highlight && (
              <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-white bg-gradient-to-r from-primary-500 to-fuchsia-500 rounded-full px-3 py-1 shadow-lg shadow-primary-900/30">
                  <Sparkles className="w-3 h-3" /> Most popular
                </span>
              </div>
            )}
            <div className="flex-1">
              <div className={`text-xs font-semibold uppercase tracking-wide ${p.highlight ? 'text-primary-300' : 'text-primary-600'}`}>
                {p.name}
              </div>
              <div className="mt-1 text-sm opacity-80">{p.tagline}</div>
              <div className="mt-6 flex items-baseline gap-1">
                <span className="text-5xl font-bold tracking-tight">${p.price}</span>
                <span className={`text-sm font-medium ${p.highlight ? 'opacity-70' : 'text-slate-500'}`}>/ month</span>
              </div>
              <ul className="mt-8 space-y-3">
                {p.features.map((f) => (
                  <li key={f} className="flex items-start gap-2.5 text-sm">
                    <span className={`mt-0.5 w-5 h-5 rounded-full flex-shrink-0 flex items-center justify-center ${
                      p.highlight ? 'bg-primary-500/20 text-primary-300' : 'bg-emerald-50 text-emerald-600'
                    }`}>
                      <Check className="w-3 h-3" strokeWidth={3} />
                    </span>
                    <span className={p.highlight ? 'text-slate-200' : 'text-slate-700'}>{f}</span>
                  </li>
                ))}
              </ul>
            </div>
            <button
              onClick={onCtaClick}
              className={`mt-8 w-full inline-flex items-center justify-center gap-2 rounded-xl font-semibold py-3 text-sm transition ${
                p.highlight
                  ? 'bg-white text-slate-900 hover:bg-slate-100'
                  : 'bg-slate-900 text-white hover:bg-slate-800'
              }`}
            >
              Start free trial
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>

      <p className="text-center text-xs text-slate-500 mt-10">
        Annual billing saves 20% · Every plan includes SOC 2-grade infra and daily backups.
      </p>
    </div>
  </section>
);

// ---------------------------------------------------------------------------
// FAQ
// ---------------------------------------------------------------------------
const FAQS = [
  {
    q: 'Do I have to write prompts or configure anything?',
    a: 'No. Post-To learns your business automatically from your Google Business Profile, website, reviews, and analytics. The AI writes in your voice from day one — no prompt engineering, no persona setup.'
  },
  {
    q: 'Which platforms can I publish to?',
    a: 'At launch: Google Business Profile, your website, WordPress, Instagram, Facebook, LinkedIn, and X. One click adapts the post to each channel’s tone and format.'
  },
  {
    q: 'How is Post-To different from a social scheduler like Buffer or Hootsuite?',
    a: 'Schedulers publish what you write. Post-To writes, publishes, tracks, and improves — end to end. You approve, or you go full autopilot.'
  },
  {
    q: 'Will my content sound like generic AI?',
    a: 'No. Post-To reads your reviews and website to learn how you actually talk. Every asset is grounded in real facts about your business — services, service area, tone, top keywords.'
  },
  {
    q: 'What happens to my Google reviews?',
    a: 'Every review becomes marketing fuel. Post-To drafts a reply for your approval, then can turn the review into a Google post, blog article, social post, testimonial, and landing-page block — automatically.'
  },
  {
    q: 'Can I manage multiple locations or brands?',
    a: 'Yes. Each location has its own knowledge model, voice, and schedule. The Multi-location plan adds cross-location reporting and per-location brand controls.'
  },
  {
    q: 'Is there a free trial?',
    a: 'Yes. 14 days, no credit card required. Connect your business and see the AI at work before you decide anything.'
  }
];

const Faq = () => {
  const [open, setOpen] = useState(0);
  return (
    <section id="faq" className="py-24 md:py-28">
      <div className="max-w-4xl mx-auto px-6 lg:px-8">
        <div className="text-center mb-12">
          <div className="inline-flex items-center gap-2 text-xs font-semibold text-primary-700 bg-primary-50 rounded-full px-3 py-1 mb-4">
            FAQ
          </div>
          <h2 className="text-3xl md:text-5xl font-bold tracking-tight text-slate-900">
            Questions, answered.
          </h2>
        </div>

        <div className="space-y-3">
          {FAQS.map((f, i) => {
            const isOpen = open === i;
            return (
              <div
                key={f.q}
                className={`rounded-2xl ring-1 transition ${
                  isOpen ? 'ring-slate-300 bg-white shadow-sm' : 'ring-slate-200 bg-white'
                }`}
              >
                <button
                  onClick={() => setOpen(isOpen ? -1 : i)}
                  className="w-full flex items-center gap-4 text-left px-6 py-5"
                >
                  <span className="flex-1 text-base font-semibold text-slate-900">{f.q}</span>
                  <ChevronDown className={`w-5 h-5 text-slate-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                </button>
                {isOpen && (
                  <div className="px-6 pb-5 -mt-1 text-sm text-slate-600 leading-relaxed">{f.a}</div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};

// ---------------------------------------------------------------------------
// Final CTA
// ---------------------------------------------------------------------------
const FinalCta = ({ onCtaClick }) => (
  <section className="relative py-24 md:py-32 overflow-hidden">
    <div className="max-w-5xl mx-auto px-6 lg:px-8">
      <div className="relative rounded-[2.5rem] p-12 md:p-16 bg-gradient-to-br from-slate-900 via-slate-900 to-primary-950 text-white overflow-hidden">
        <div className="absolute -top-20 -right-20 w-96 h-96 rounded-full bg-primary-500/30 blur-3xl" />
        <div className="absolute -bottom-32 -left-16 w-96 h-96 rounded-full bg-fuchsia-500/20 blur-3xl" />
        <div className="relative text-center">
          <div className="inline-flex items-center gap-2 rounded-full bg-white/10 ring-1 ring-white/20 px-3 py-1.5 text-xs font-semibold backdrop-blur">
            <Sparkles className="w-3.5 h-3.5 text-primary-300" />
            Your AI marketing manager is waiting
          </div>
          <h2 className="mt-6 text-4xl md:text-6xl font-bold tracking-tight">
            Connect your business.
            <br />
            <span className="bg-gradient-to-r from-primary-300 to-fuchsia-300 bg-clip-text text-transparent">
              Marketing runs itself.
            </span>
          </h2>
          <p className="mt-5 text-lg text-slate-300 max-w-xl mx-auto">
            14 days free. No credit card. If Post-To doesn’t save you 10 hours in the first
            month, we’ll refund and part as friends.
          </p>
          <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
            <button
              onClick={onCtaClick}
              className="group inline-flex items-center gap-2 rounded-xl bg-white text-slate-900 font-semibold px-7 py-4 text-sm shadow-2xl transition hover:bg-slate-100"
            >
              Start free trial
              <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition" />
            </button>
            <a
              href="#pricing"
              className="inline-flex items-center gap-2 rounded-xl bg-white/10 backdrop-blur ring-1 ring-white/20 text-white font-semibold px-7 py-4 text-sm hover:bg-white/15 transition"
            >
              See pricing
            </a>
          </div>
          <p className="mt-6 text-xs text-slate-400">
            Setup takes ~2 minutes · Cancel anytime · Your data stays yours
          </p>
        </div>
      </div>
    </div>
  </section>
);

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------
const Footer = () => (
  <footer className="border-t border-slate-200 py-10">
    <div className="max-w-7xl mx-auto px-6 lg:px-8 flex flex-col md:flex-row items-center justify-between gap-4 text-sm text-slate-500">
      <div className="flex items-center gap-2">
        <div className="w-6 h-6 rounded-md bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center">
          <Sparkles className="w-3 h-3 text-white" />
        </div>
        <span className="font-semibold text-slate-700">Post-To</span>
        <span className="text-slate-400">— AI marketing for local businesses</span>
      </div>
      <div className="flex gap-6">
        <a href="#pricing" className="hover:text-slate-800">Pricing</a>
        <a href="#faq" className="hover:text-slate-800">FAQ</a>
        <a href="/login" className="hover:text-slate-800">Sign in</a>
      </div>
    </div>
  </footer>
);

const Offer = ({ onCtaClick }) => (
  <>
    <Pricing onCtaClick={onCtaClick} />
    <Faq />
    <FinalCta onCtaClick={onCtaClick} />
    <Footer />
  </>
);

export default Offer;
