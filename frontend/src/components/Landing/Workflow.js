import React from 'react';
import {
  Link2, Brain, Wand2, Star, Send, LineChart, Lightbulb, TrendingUp
} from 'lucide-react';
import {
  ConnectMock, AiBrainMock, ComposerMock, ReviewFanMock,
  PublishMock, AnalyticsMock, RecommendationsMock, GrowthMock
} from './mockups';

// ---------------------------------------------------------------------------
// Section header
// ---------------------------------------------------------------------------
const SectionHeader = () => (
  <div className="max-w-3xl mx-auto text-center mb-16 md:mb-20">
    <div className="inline-flex items-center gap-2 text-xs font-semibold text-primary-700 bg-primary-50 rounded-full px-3 py-1 mb-4">
      The Post-To workflow
    </div>
    <h2 className="text-3xl md:text-5xl font-bold tracking-tight text-slate-900">
      One connection.
      <br />
      <span className="bg-gradient-to-r from-primary-600 to-fuchsia-600 bg-clip-text text-transparent">
        Every marketing task, handled.
      </span>
    </h2>
    <p className="mt-4 text-lg text-slate-600">
      Post-To is an end-to-end AI marketing engine. Here's what runs in the background
      the moment you sign up.
    </p>
  </div>
);

// ---------------------------------------------------------------------------
// Step block — alternating layout, sticky number, product mockup
// ---------------------------------------------------------------------------
const Step = ({ number, icon: Icon, eyebrow, title, body, bullets, mockup, reverse = false, id }) => (
  <div id={id} className="relative">
    <div className={`grid lg:grid-cols-2 gap-10 lg:gap-16 items-center ${reverse ? 'lg:[&>*:first-child]:order-2' : ''}`}>
      {/* Text side */}
      <div>
        <div className="flex items-center gap-3 mb-4">
          <span className="text-xs font-bold text-primary-600 bg-primary-50 ring-1 ring-primary-100 rounded-full px-2.5 py-1">
            Step {number}
          </span>
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            {eyebrow}
          </span>
        </div>
        <h3 className="text-2xl md:text-4xl font-bold tracking-tight text-slate-900 leading-tight">
          {title}
        </h3>
        <p className="mt-4 text-base md:text-lg text-slate-600 leading-relaxed">{body}</p>
        {bullets && (
          <ul className="mt-6 space-y-2.5">
            {bullets.map((b) => (
              <li key={b} className="flex items-start gap-3 text-sm text-slate-700">
                <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-primary-600 flex-shrink-0" />
                <span>{b}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Mockup side */}
      <div className="relative">
        <div className="absolute -inset-6 bg-gradient-to-br from-primary-100/40 via-fuchsia-100/30 to-transparent blur-3xl -z-10 rounded-[3rem]" />
        {mockup}
      </div>
    </div>
  </div>
);

// ---------------------------------------------------------------------------
// Workflow rail — subtle vertical connector between steps
// ---------------------------------------------------------------------------
const Rail = () => (
  <div className="relative flex justify-center py-6" aria-hidden>
    <div className="w-px h-16 bg-gradient-to-b from-primary-300/50 to-transparent" />
  </div>
);

// ---------------------------------------------------------------------------
// The 8 workflow steps
// ---------------------------------------------------------------------------
const Workflow = () => (
  <section id="workflow" className="relative py-24 md:py-32">
    <div className="max-w-7xl mx-auto px-6 lg:px-8">
      <SectionHeader />

      <div className="space-y-16 md:space-y-24">
        <Step
          id="features"
          number="1"
          icon={Link2}
          eyebrow="Connect"
          title="Connect your business once. That's the whole setup."
          body="Google Business Profile, Google Analytics, your website, Instagram, Facebook, LinkedIn, X, WordPress — one picker, one consent, done. Add more accounts as you grow. Post-To handles the rest."
          bullets={[
            'Google Business Profile + Google Analytics via one Google sign-in',
            'Your website scraped for services, tone, and offerings',
            'Social channels connect with a click — no API keys, no dev work',
            'Multi-location? Multi-brand? All managed from one dashboard.'
          ]}
          mockup={<ConnectMock />}
        />

        <Rail />

        <Step
          number="2"
          icon={Brain}
          eyebrow="AI learns"
          title="AI reads your business the way a marketing agency would."
          body="No prompt writing. No profile builder. Post-To ingests everything about you — services, categories, service areas, reviews, website copy, analytics — and turns it into a living knowledge model that content is generated from."
          bullets={[
            'Description, services, categories, service areas — pulled automatically',
            'Voice & tone learned from your reviews and website',
            'Top-performing keywords inferred from GA4 traffic',
            'Every new review continuously updates what AI knows'
          ]}
          mockup={<AiBrainMock />}
          reverse
        />

        <Rail />

        <Step
          number="3"
          icon={Wand2}
          eyebrow="AI generates"
          title="Content for every channel — written in your voice."
          body="One click drafts a Google Business post, an SEO blog article, a review reply, a social caption, a landing page, or a full seasonal campaign. Every asset is grounded in what AI has learned — no generic AI slop, no manual prompts."
          bullets={[
            'Google Business Posts · SEO blog articles · Review replies',
            'Social captions · Landing pages · Promotional campaigns',
            'Seasonal campaigns planned around your local market',
            'Every asset editable — approve, tweak, or regenerate in seconds'
          ]}
          mockup={<ComposerMock />}
        />

        <Rail />

        <Step
          number="4"
          icon={Star}
          eyebrow="Review marketing"
          title="Every 5-star review becomes 5 marketing assets."
          body="Your customers are already selling for you. Post-To turns one glowing review into a Google post, a blog article, a social post, a website testimonial, and a landing page section — automatically. This is our signature move."
          bullets={[
            'A single review → 5 channel-ready marketing assets',
            'Reply drafted, tone-matched, and ready to send',
            'Testimonial blocks auto-injected into your website',
            'Reviews continuously fuel the content engine — no dry weeks'
          ]}
          mockup={<ReviewFanMock />}
          reverse
        />

        <Rail />

        <Step
          number="5"
          icon={Send}
          eyebrow="Publish"
          title="One click publishes everywhere."
          body="Approve the draft, pick your channels, and Post-To adapts tone, length, and images for each platform — then publishes on the schedule most likely to reach your audience. Or hand it fully over: AI can pick the schedule for you."
          bullets={[
            'Google Business, Instagram, Facebook, LinkedIn, X, Website, WordPress',
            'Auto-formatted per platform — no copy/paste, no reformatting',
            'Peak-audience scheduling powered by your analytics',
            'Full autopilot mode: AI picks the topic, the day, and the channel'
          ]}
          mockup={<PublishMock />}
        />

        <Rail />

        <Step
          number="6"
          icon={LineChart}
          eyebrow="Track"
          title="One dashboard for every metric that matters."
          body="Search views, calls, direction requests, website visits, landing pages, campaign performance, devices, geography — unified across Google Business and GA4. Ads performance and ROI reports fold in from the same view as your channels expand."
          bullets={[
            'GBP performance + GA4 traffic in one place',
            'Campaign-level attribution across every published channel',
            'Devices & geography reveal where your customers actually come from',
            'ROI reporting rolls up ads spend, calls, and bookings'
          ]}
          mockup={<AnalyticsMock />}
          reverse
        />

        <Rail />

        <Step
          number="7"
          icon={Lightbulb}
          eyebrow="Improve"
          title="AI tells you what to do next — and can just do it."
          body="Post-To watches your metrics 24/7 and surfaces the moves that will actually move the needle. Every recommendation is one click away from being executed. Over time, most of your marketing runs on autopilot."
          bullets={[
            'Weekly recommendations grounded in real performance data',
            'Trend spotting: rising local searches, seasonal opportunities',
            'Reply reminders, content gaps, missed keyword opportunities',
            'One-click "do it for me" on every recommendation'
          ]}
          mockup={<RecommendationsMock />}
        />

        <Rail />

        <Step
          number="8"
          icon={TrendingUp}
          eyebrow="Grow"
          title="More customers. Fewer hours. Less guessing."
          body="This is what it adds up to: your Google Business Profile stays active, your reviews get answered, your website ranks, your social feeds stay warm — and you get your evenings back."
          bullets={[
            'Marketing runs whether you are online or not',
            'You approve, adjust, or fully automate — your call',
            'One AI marketing manager, priced like a monthly software tool'
          ]}
          mockup={<GrowthMock />}
          reverse
        />
      </div>
    </div>
  </section>
);

export default Workflow;
