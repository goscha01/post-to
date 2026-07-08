import React from 'react';
import LegalPage, { H2, H3, P, UL } from './LegalPage';

const TermsOfService = () => (
  <LegalPage title="Terms of Service" updated="July 8, 2026">
    <P>
      These Terms of Service ("Terms") govern your access to and use of Post-To
      ("Post-To", "we", "us", "our"), an AI marketing platform for local businesses (the
      "Service"). By creating an account or using the Service, you agree to be bound by
      these Terms and by our Privacy Policy.
    </P>

    <H2>1. Eligibility</H2>
    <P>
      You must be at least 18 years old and legally authorized to bind the business you
      represent. By using the Service on behalf of a business, you represent that you have
      the authority to accept these Terms for that business.
    </P>

    <H2>2. Your account</H2>
    <UL>
      <li>You are responsible for keeping your Google sign-in credentials secure.</li>
      <li>You are responsible for all activity that occurs under your account.</li>
      <li>Notify us immediately at security@post-to.app if you suspect unauthorized access.</li>
    </UL>

    <H2>3. Connected accounts and content</H2>
    <P>
      To use the Service you will connect third-party accounts (Google Business Profile,
      Google Analytics, your website, and social channels). You represent that:
    </P>
    <UL>
      <li>You own or have the right to connect these accounts.</li>
      <li>You have the right to grant Post-To access to their data and to publish content on your behalf.</li>
      <li>You will comply with the terms of each connected platform.</li>
    </UL>
    <P>
      You retain ownership of all content you upload and all content our AI generates from
      your data ("Your Content"). By using the Service, you grant Post-To a worldwide,
      non-exclusive, royalty-free license to store, process, transmit, adapt, and display
      Your Content solely for the purpose of operating and improving the Service and
      publishing on your behalf.
    </P>

    <H2>4. AI-generated content</H2>
    <P>
      The Service uses AI to draft posts, replies, articles, and other marketing assets
      based on your connected data. You acknowledge that:
    </P>
    <UL>
      <li>AI output may contain inaccuracies. You are responsible for reviewing and approving content before publication, or configuring autopilot at your discretion.</li>
      <li>You must not use the Service to generate content that is unlawful, misleading, defamatory, discriminatory, sexually explicit, or infringes third-party rights.</li>
      <li>Post-To makes no representation that AI output is free of similarity to third-party works.</li>
    </UL>

    <H2>5. Acceptable use</H2>
    <P>You agree not to:</P>
    <UL>
      <li>Use the Service to spam, phish, or send unsolicited commercial communications.</li>
      <li>Reverse engineer, scrape, or attempt to extract source code, models, or non-public APIs.</li>
      <li>Interfere with, degrade, or disrupt the Service or the platforms it integrates with.</li>
      <li>Impersonate another person or business, or misrepresent your affiliation.</li>
      <li>Publish content that violates the terms of a connected platform.</li>
      <li>Circumvent rate limits, usage caps, or access controls.</li>
    </UL>

    <H2>6. Subscription, billing, and trials</H2>

    <H3>6.1 Plans</H3>
    <P>
      Post-To is offered on monthly or annual subscription plans described on{' '}
      <a href="/#pricing" className="text-primary-600 hover:underline">the pricing page</a>.
      Features and usage caps depend on the plan you select.
    </P>

    <H3>6.2 Free trial</H3>
    <P>
      New accounts may receive a 14-day free trial. No payment method is required to start.
      If you do not subscribe by the end of the trial, your account will be paused and Your
      Content will remain accessible for 30 days.
    </P>

    <H3>6.3 Charges</H3>
    <P>
      You authorize Post-To to charge your payment method on a recurring basis (monthly or
      annual, depending on plan) until you cancel. All fees are exclusive of applicable
      taxes.
    </P>

    <H3>6.4 Cancellation and refunds</H3>
    <P>
      You may cancel at any time from your account settings. Cancellation takes effect at
      the end of the current billing period. Except where required by law, fees already
      paid are non-refundable. If you cancel during your first month on the Growth or
      Multi-location plan and demonstrate the Service did not save you at least 10 hours,
      email support@post-to.app and we will refund your first month.
    </P>

    <H2>7. Publishing on your behalf</H2>
    <P>
      When you enable publishing to a connected platform, Post-To will submit your approved
      or auto-generated content to that platform's public API. We are not responsible for:
    </P>
    <UL>
      <li>The connected platform accepting, rejecting, moderating, or removing your content.</li>
      <li>Downtime or rate-limit errors caused by the connected platform.</li>
      <li>Changes to the connected platform's terms, API, or availability.</li>
    </UL>

    <H2>8. Third-party services</H2>
    <P>
      The Service integrates with third-party services (Google, Meta, LinkedIn, X, WordPress,
      OpenAI, and others). Your use of those services is governed by their own terms and
      privacy policies. Post-To is not responsible for the acts or omissions of any third
      party.
    </P>

    <H2>9. Intellectual property</H2>
    <P>
      The Service, including all software, designs, logos, and documentation, is the
      property of Post-To or its licensors and is protected by intellectual property laws.
      Except for the limited license to use the Service granted here, no rights are
      transferred to you.
    </P>

    <H2>10. Termination</H2>
    <P>
      You may terminate your account at any time. We may suspend or terminate your access
      immediately if you materially breach these Terms, engage in prohibited use, or if
      required by law. Upon termination, your right to use the Service ends and we may
      delete Your Content after the retention period described in our Privacy Policy.
    </P>

    <H2>11. Disclaimers</H2>
    <P>
      THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND,
      EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND
      NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED, ERROR-FREE,
      OR THAT AI-GENERATED CONTENT WILL BE ACCURATE, APPROPRIATE, OR ACHIEVE ANY PARTICULAR
      MARKETING OUTCOME.
    </P>

    <H2>12. Limitation of liability</H2>
    <P>
      TO THE MAXIMUM EXTENT PERMITTED BY LAW, POST-TO WILL NOT BE LIABLE FOR ANY INDIRECT,
      INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY LOSS OF PROFITS,
      REVENUE, GOODWILL, OR DATA, ARISING OUT OF OR RELATED TO YOUR USE OF THE SERVICE. OUR
      AGGREGATE LIABILITY FOR ANY CLAIM UNDER THESE TERMS WILL NOT EXCEED THE FEES YOU PAID
      TO POST-TO IN THE TWELVE (12) MONTHS BEFORE THE EVENT GIVING RISE TO THE CLAIM.
    </P>

    <H2>13. Indemnification</H2>
    <P>
      You agree to indemnify and hold Post-To harmless from any claim, damage, or expense
      arising from Your Content, your use of the Service in violation of these Terms, or
      your violation of any law or third-party right.
    </P>

    <H2>14. Governing law</H2>
    <P>
      These Terms are governed by the laws of the State of Delaware, United States, without
      regard to conflict-of-laws principles. Any dispute will be resolved exclusively in the
      state or federal courts located in Delaware, and you consent to their jurisdiction.
    </P>

    <H2>15. Changes to the Service and to these Terms</H2>
    <P>
      We may modify or discontinue features of the Service at any time. We may update these
      Terms; material changes will be announced in the product and by email. Continued use
      after the effective date constitutes acceptance.
    </P>

    <H2>16. Contact</H2>
    <P>
      Questions about these Terms? Email{' '}
      <a href="mailto:legal@post-to.app" className="text-primary-600 hover:underline">
        legal@post-to.app
      </a>.
    </P>
  </LegalPage>
);

export default TermsOfService;
