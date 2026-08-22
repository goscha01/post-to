import React, { useState } from 'react';
import {
  ShieldCheck,
  Edit,
  Newspaper,
  Link as LinkIcon,
  AlertTriangle,
  Gift,
  CheckCircle2,
  X,
  FileText,
  DollarSign,
  Clock,
  Link2,
  Mail,
  LifeBuoy,
  MessageCircle,
} from 'lucide-react';

// ---------- Mock subscription state (UI-only) ----------
const mockSubscription = {
  plan: 'AutoSEO',
  businessName: 'Spotless Homes',
  trialEndsAt: 'Aug 24, 2026',
  monthlyPrice: 149,
  yearlyPrice: 99,
  articlesPerMonth: 30,
  articlesGenerated: 4,
  articlesTotalWords: 13587,
  costPerArticle: 102,
};

const Billing = () => {
  const [selectedBilling, setSelectedBilling] = useState('yearly');
  const [cancelStep, setCancelStep] = useState(null);
  const [feedback, setFeedback] = useState({ pricing: '', worked: '', hardest: '' });
  const [feedbackError, setFeedbackError] = useState('');
  const [processing, setProcessing] = useState(false);

  const sub = mockSubscription;
  const totalContentValue = sub.articlesGenerated * sub.costPerArticle;

  const openCancelFlow = () => {
    setFeedback({ pricing: '', worked: '', hardest: '' });
    setFeedbackError('');
    setCancelStep('growth_engine');
  };

  const closeCancelFlow = () => setCancelStep(null);

  const goToStep = (step) => {
    setFeedbackError('');
    setCancelStep(step);
  };

  const submitPricingFeedback = () => {
    if (feedback.pricing.trim().length < 2) {
      setFeedbackError('Please write at least a few words to help us understand.');
      return;
    }
    goToStep('feedback_worked');
  };

  const finalizeCancellation = () => {
    setProcessing(true);
    setTimeout(() => {
      setProcessing(false);
      // eslint-disable-next-line no-alert
      window.alert(
        'Your subscription has been cancelled and all payment retry attempts have been stopped. Thank you for your feedback.'
      );
      closeCancelFlow();
    }, 900);
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Subscription Management</h1>
          <p className="text-gray-600 mt-1">Manage your AutoSEO subscription and billing</p>
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-purple-600 to-indigo-600 text-white text-sm font-medium shadow hover:from-purple-700 hover:to-indigo-700"
        >
          <ShieldCheck className="h-4 w-4" />
          Agency/Enterprise Plans →
        </button>
      </div>

      {/* Current plan card */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
        <div className="p-6 sm:p-8">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-bold text-gray-900">
              Current Plan - {sub.businessName}
            </h2>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:text-blue-700"
            >
              <Edit className="h-4 w-4" />
              Edit billing details
            </button>
          </div>

          {/* Trial banner */}
          <div className="rounded-xl border-2 border-yellow-300 bg-yellow-50 p-5">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
              <div className="flex-1">
                <div className="text-lg font-bold text-gray-900">3-Day Trial - Active</div>
                <div className="text-sm text-gray-700 mt-1">Trial ends: {sub.trialEndsAt}</div>
                <div className="flex items-start gap-2 mt-2 text-sm text-yellow-900">
                  <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                  <span>
                    You will be automatically charged <strong>${sub.monthlyPrice}</strong> on{' '}
                    {sub.trialEndsAt} unless you cancel
                  </span>
                </div>
                <ul className="mt-4 space-y-1.5 text-sm text-gray-700">
                  <li className="flex items-center gap-2">
                    <Newspaper className="h-4 w-4 text-gray-500" />
                    1 expert article published daily
                  </li>
                  <li className="flex items-center gap-2">
                    <LinkIcon className="h-4 w-4 text-gray-500" />
                    100 Domain Authority of links. e.g. 4×25DA links, or 10×10DA links (so 4-7
                    links/month)
                  </li>
                </ul>
              </div>
              <div className="flex flex-col items-end gap-3 sm:min-w-[180px]">
                <div className="text-2xl font-bold text-gray-900">
                  ${sub.monthlyPrice}
                  <span className="text-sm font-medium text-gray-600">/month</span>
                </div>
                <button
                  type="button"
                  onClick={openCancelFlow}
                  className="w-full sm:w-auto px-5 py-2.5 bg-red-600 hover:bg-red-700 text-white font-semibold rounded-lg shadow-sm"
                >
                  Cancel Before Charge
                </button>
              </div>
            </div>
          </div>

          {/* Bonus upgrade card */}
          <div className="mt-6 rounded-xl border-2 border-purple-300 bg-gradient-to-br from-purple-50 to-pink-50 p-5">
            <div className="flex items-center gap-2 mb-3">
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-purple-600 text-white text-xs font-bold">
                <Gift className="h-3 w-3" />
                BONUS
              </span>
              <span className="font-bold text-gray-900">
                Activate Now & Get 5 EXTRA Articles
              </span>
            </div>
            <p className="text-sm text-purple-900 mb-1">
              Start your subscription before your trial ends and receive{' '}
              <strong>5 bonus articles</strong> to kick off your SEO growth!
            </p>
            <p className="text-xs text-purple-800 mb-4">
              These extra articles will be scheduled over the next 5 days — that's 2 articles per
              day instead of 1.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
              <button
                type="button"
                onClick={() => setSelectedBilling('monthly')}
                className={`text-left p-4 rounded-xl border-2 transition ${
                  selectedBilling === 'monthly'
                    ? 'border-purple-500 bg-white'
                    : 'border-gray-200 bg-white hover:border-gray-300'
                }`}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="font-bold text-gray-900">Monthly</div>
                    <div className="text-purple-700 font-bold mt-0.5">
                      ${sub.monthlyPrice}
                      <span className="text-sm font-medium text-gray-600">/month</span>
                    </div>
                  </div>
                  <span
                    className={`h-5 w-5 rounded-full border-2 flex items-center justify-center ${
                      selectedBilling === 'monthly'
                        ? 'border-purple-600 bg-purple-600'
                        : 'border-gray-300'
                    }`}
                  >
                    {selectedBilling === 'monthly' && (
                      <span className="h-2 w-2 rounded-full bg-white" />
                    )}
                  </span>
                </div>
                <p className="text-xs text-gray-600 mt-2">More flexibility. Cancel any time.</p>
                <p className="text-xs text-purple-700 font-medium mt-1">
                  + 5 bonus articles included
                </p>
              </button>

              <button
                type="button"
                onClick={() => setSelectedBilling('yearly')}
                className={`relative text-left p-4 rounded-xl border-2 transition ${
                  selectedBilling === 'yearly'
                    ? 'border-emerald-500 bg-white'
                    : 'border-gray-200 bg-white hover:border-gray-300'
                }`}
              >
                <span className="absolute -top-2.5 left-3 inline-flex items-center px-2 py-0.5 rounded-full bg-emerald-500 text-white text-[10px] font-bold shadow">
                  BEST VALUE
                </span>
                <div className="flex items-start justify-between">
                  <div>
                    <div className="font-bold text-gray-900">Yearly</div>
                    <div className="text-emerald-700 font-bold mt-0.5">
                      ${sub.yearlyPrice}
                      <span className="text-sm font-medium text-gray-600">/mo</span>
                    </div>
                  </div>
                  <span
                    className={`h-5 w-5 rounded-full border-2 flex items-center justify-center ${
                      selectedBilling === 'yearly'
                        ? 'border-emerald-600 bg-emerald-600'
                        : 'border-gray-300'
                    }`}
                  >
                    {selectedBilling === 'yearly' && (
                      <span className="h-2 w-2 rounded-full bg-white" />
                    )}
                  </span>
                </div>
                <p className="text-xs text-gray-600 mt-2">Save ~34% vs monthly billing.</p>
                <p className="text-xs text-emerald-700 font-medium mt-1">
                  + 5 bonus articles included
                </p>
              </button>
            </div>

            <div className="text-center">
              <button
                type="button"
                className="inline-flex items-center justify-center px-6 py-3 rounded-lg bg-gradient-to-r from-purple-600 to-pink-600 text-white font-semibold shadow hover:from-purple-700 hover:to-pink-700"
              >
                Get 5 EXTRA Articles - $
                {selectedBilling === 'yearly' ? sub.yearlyPrice : sub.monthlyPrice}/mo
              </button>
              <p className="text-xs text-purple-700 mt-2">🚀 Start growing immediately</p>
            </div>
          </div>
        </div>
      </div>

      {/* ---------- Cancellation flow modal ---------- */}
      {cancelStep && (
        <CancellationModal
          step={cancelStep}
          sub={sub}
          totalContentValue={totalContentValue}
          feedback={feedback}
          setFeedback={setFeedback}
          feedbackError={feedbackError}
          processing={processing}
          onClose={closeCancelFlow}
          goToStep={goToStep}
          submitPricingFeedback={submitPricingFeedback}
          finalizeCancellation={finalizeCancellation}
        />
      )}
    </div>
  );
};

// ---------- Cancellation modal (multi-step) ----------
const CancellationModal = ({
  step,
  sub,
  totalContentValue,
  feedback,
  setFeedback,
  feedbackError,
  processing,
  onClose,
  goToStep,
  submitPricingFeedback,
  finalizeCancellation,
}) => {
  const isFullscreen =
    step === 'growth_engine' ||
    step === 'feedback_pricing' ||
    step === 'feedback_worked' ||
    step === 'feedback_hardest' ||
    step === 'consequences';

  if (isFullscreen) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gradient-to-br from-indigo-600 via-purple-600 to-fuchsia-600">
        {step === 'growth_engine' && (
          <GrowthEngineStep
            sub={sub}
            totalContentValue={totalContentValue}
            onKeep={onClose}
            onCancel={() => goToStep('value_stats')}
          />
        )}
        {step === 'feedback_pricing' && (
          <FeedbackStep
            stepNum={1}
            question="If AutoSEO cost half the price, would you have stayed?"
            value={feedback.pricing}
            onChange={(v) => setFeedback({ ...feedback, pricing: v })}
            error={feedbackError}
            primaryLabel="Continue"
            secondaryLabel="Keep My Subscription"
            onPrimary={submitPricingFeedback}
            onSecondary={onClose}
          />
        )}
        {step === 'feedback_worked' && (
          <FeedbackStep
            stepNum={2}
            question="Was there anything about AutoSEO that worked well for you?"
            placeholder="Share your honest thoughts..."
            value={feedback.worked}
            onChange={(v) => setFeedback({ ...feedback, worked: v })}
            primaryLabel="Continue"
            secondaryLabel="Back"
            onPrimary={() => goToStep('feedback_hardest')}
            onSecondary={() => goToStep('feedback_pricing')}
          />
        )}
        {step === 'feedback_hardest' && (
          <FeedbackStep
            stepNum={3}
            question="What was the hardest part about finding the right SEO solution? (Not just AutoSEO, in general.)"
            placeholder="Share your honest thoughts..."
            value={feedback.hardest}
            onChange={(v) => setFeedback({ ...feedback, hardest: v })}
            primaryLabel="Continue to Cancel"
            secondaryLabel="Back"
            onPrimary={() => goToStep('consequences')}
            onSecondary={() => goToStep('feedback_worked')}
          />
        )}
        {step === 'consequences' && (
          <ConsequencesStep
            processing={processing}
            onGoBack={() => goToStep('feedback_hardest')}
            onConfirm={finalizeCancellation}
          />
        )}
      </div>
    );
  }

  // Compact centered modals on dimmed background
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      {step === 'value_stats' && (
        <ValueStatsStep
          sub={sub}
          onClose={onClose}
          onConnect={onClose}
          onSendInstructions={onClose}
          onContinueCancel={() => goToStep('setup_offer')}
        />
      )}
      {step === 'setup_offer' && (
        <SetupOfferStep
          onClose={onClose}
          onNeedHelp={onClose}
          onContinueCancel={() => goToStep('feedback_pricing')}
        />
      )}
    </div>
  );
};

// ---------- Step 1: Growth engine (value save) ----------
const GrowthEngineStep = ({ sub, totalContentValue, onKeep, onCancel }) => (
  <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl p-6 sm:p-8">
    <div className="flex justify-center mb-4">
      <div className="h-14 w-14 rounded-full bg-emerald-100 flex items-center justify-center">
        <CheckCircle2 className="h-7 w-7 text-emerald-600" />
      </div>
    </div>
    <h2 className="text-2xl font-bold text-gray-900 text-center">
      Your growth engine is running
    </h2>
    <p className="text-gray-600 text-center mt-2">
      Here's what we've done for your business — all on autopilot.
    </p>

    <div className="mt-6 p-4 bg-blue-50 rounded-xl">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="h-9 w-9 rounded-lg bg-white flex items-center justify-center flex-shrink-0">
            <FileText className="h-5 w-5 text-blue-600" />
          </div>
          <div>
            <div className="font-semibold text-gray-900 text-sm">
              {sub.articlesGenerated} deep-researched articles created for your business
            </div>
            <div className="text-xs text-gray-600 mt-0.5">
              {sub.articlesTotalWords.toLocaleString()} words helping customers discover and trust
              your business
            </div>
          </div>
        </div>
        <div className="text-lg font-bold text-emerald-600 flex-shrink-0">
          ${totalContentValue}
        </div>
      </div>
    </div>

    <div className="mt-3 p-4 bg-gray-900 text-white rounded-xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-semibold text-sm">What this would cost to build from scratch</div>
          <div className="text-xs text-gray-400 mt-0.5">
            And it keeps growing every day you stay
          </div>
        </div>
        <div className="text-lg font-bold flex-shrink-0">${totalContentValue}</div>
      </div>
    </div>

    <div className="mt-6 grid grid-cols-2 gap-3">
      <button
        type="button"
        onClick={onKeep}
        className="px-4 py-3 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white font-semibold"
      >
        Keep Growing
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="px-4 py-3 rounded-lg bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium"
      >
        I still want to cancel
      </button>
    </div>
  </div>
);

// ---------- Step 2: Value stats (haven't used it) ----------
const ValueStatsStep = ({ sub, onClose, onConnect, onSendInstructions, onContinueCancel }) => (
  <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden">
    <div className="h-1.5 bg-gradient-to-r from-emerald-400 via-cyan-400 to-blue-500" />
    <div className="p-6">
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex items-start gap-3">
          <div className="h-10 w-10 rounded-full bg-yellow-100 flex items-center justify-center flex-shrink-0">
            <AlertTriangle className="h-5 w-5 text-yellow-600" />
          </div>
          <h2 className="text-lg font-bold text-gray-900">
            Wait — you haven't used any of this yet
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600 flex-shrink-0"
          aria-label="Close"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <p className="text-sm text-gray-600 mb-4">
        Your website isn't connected, so none of the value in your subscription has been
        delivered. Here's what's ready for you right now:
      </p>

      <div className="grid grid-cols-3 gap-2 mb-4">
        <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-100 text-center">
          <div className="flex items-center justify-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-emerald-700">
            <FileText className="h-3 w-3" />
            Articles
          </div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{sub.articlesPerMonth}</div>
          <div className="text-[11px] text-gray-600">per month</div>
        </div>
        <div className="p-3 rounded-lg bg-blue-50 border border-blue-100 text-center">
          <div className="flex items-center justify-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-blue-700">
            <LinkIcon className="h-3 w-3" />
            Backlinks
          </div>
          <div className="text-2xl font-bold text-gray-900 mt-1">4-7</div>
          <div className="text-[11px] text-gray-600">per month</div>
        </div>
        <div className="p-3 rounded-lg bg-purple-50 border border-purple-100 text-center">
          <div className="flex items-center justify-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-purple-700">
            <DollarSign className="h-3 w-3" />
            SEO Value
          </div>
          <div className="text-2xl font-bold text-gray-900 mt-1">$1,000+</div>
          <div className="text-[11px] text-gray-600">waiting</div>
        </div>
      </div>

      <div className="flex items-center gap-2 p-3 rounded-lg bg-gray-50 text-xs text-gray-600 mb-4">
        <Clock className="h-4 w-4 text-gray-400 flex-shrink-0" />
        Most users connect in under 5 minutes — your content starts working immediately.
      </div>

      <button
        type="button"
        onClick={onConnect}
        className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white font-semibold mb-2"
      >
        <Link2 className="h-4 w-4" />
        Connect your website
      </button>
      <button
        type="button"
        onClick={onSendInstructions}
        className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-700 font-medium mb-2"
      >
        <Mail className="h-4 w-4" />
        Send setup instructions to your tech person
      </button>
      <button
        type="button"
        onClick={onContinueCancel}
        className="w-full text-center text-sm text-gray-500 hover:text-gray-700 py-2"
      >
        I still want to cancel
      </button>
    </div>
  </div>
);

// ---------- Step 3: Setup offer ----------
const SetupOfferStep = ({ onClose, onNeedHelp, onContinueCancel }) => (
  <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden">
    <div className="h-1.5 bg-gradient-to-r from-emerald-400 via-cyan-400 to-blue-500" />
    <div className="p-6">
      <div className="flex items-start justify-between gap-2 mb-4">
        <h2 className="text-lg font-bold text-gray-900">
          We'll help you get connected — free of charge
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600 flex-shrink-0"
          aria-label="Close"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="p-4 rounded-lg bg-emerald-50 border border-emerald-100 mb-6">
        <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-emerald-700 mb-2">
          <LifeBuoy className="h-4 w-4" />
          Free Setup Assistance
        </div>
        <p className="text-sm text-gray-700">
          Most of our customers see real results once their website is connected. We'll guide you
          through the integration step by step at no extra cost — just click "I need help" and
          we'll be in touch shortly.
        </p>
      </div>

      <button
        type="button"
        onClick={onNeedHelp}
        className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-gray-900 hover:bg-black text-white font-semibold mb-3"
      >
        <LifeBuoy className="h-4 w-4" />
        I need help setting up
      </button>
      <button
        type="button"
        onClick={onContinueCancel}
        className="w-full text-center text-sm text-gray-500 hover:text-gray-700"
      >
        Continue Cancellation
      </button>
    </div>
  </div>
);

// ---------- Steps 4-6: Feedback questions ----------
const FeedbackStep = ({
  stepNum,
  question,
  placeholder = '',
  value,
  onChange,
  error,
  primaryLabel,
  secondaryLabel,
  onPrimary,
  onSecondary,
}) => (
  <div className="w-full max-w-lg bg-white rounded-2xl shadow-2xl p-6 sm:p-8">
    <div className="flex items-center justify-between text-sm text-gray-500 mb-2">
      <span>Step {stepNum} of 3</span>
      <span>Quick Feedback</span>
    </div>
    <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden mb-6">
      <div
        className="h-full bg-gradient-to-r from-blue-500 to-purple-500 transition-all"
        style={{ width: `${(stepNum / 3) * 100}%` }}
      />
    </div>

    <h2 className="text-lg font-bold text-gray-900 mb-4">{question}</h2>

    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={4}
      className={`w-full px-3 py-2 rounded-lg border ${
        error ? 'border-red-400' : 'border-gray-300'
      } focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm text-gray-900`}
    />
    {error && <p className="text-sm text-red-600 mt-2">{error}</p>}

    <div className="mt-4 p-3 rounded-lg bg-blue-50 flex items-start gap-2">
      <MessageCircle className="h-4 w-4 text-blue-500 mt-0.5 flex-shrink-0" />
      <div className="text-xs text-blue-900">
        <div className="font-semibold">We'd love to help before you go.</div>
        <div>
          Our support team is here to help, and you can chat with us directly to see if we can fix
          this for you.
        </div>
        <div className="font-semibold mt-1">Use the chat in the right bottom corner now.</div>
      </div>
    </div>

    <div className="mt-6 grid grid-cols-2 gap-3">
      <button
        type="button"
        onClick={onSecondary}
        className="px-4 py-3 rounded-lg bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium"
      >
        {secondaryLabel}
      </button>
      <button
        type="button"
        onClick={onPrimary}
        className="px-4 py-3 rounded-lg bg-red-600 hover:bg-red-700 text-white font-semibold"
      >
        {primaryLabel}
      </button>
    </div>
  </div>
);

// ---------- Step 7: Consequences ----------
const ConsequencesStep = ({ processing, onGoBack, onConfirm }) => (
  <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl p-6 sm:p-8">
    <div className="flex justify-center mb-4">
      <div className="h-14 w-14 rounded-full bg-yellow-100 flex items-center justify-center">
        <AlertTriangle className="h-7 w-7 text-yellow-600" />
      </div>
    </div>
    <h2 className="text-xl font-bold text-gray-900 text-center">Important: What You'll Lose</h2>
    <p className="text-gray-600 text-center text-sm mt-1">Please be aware of these consequences:</p>

    <div className="mt-5 space-y-3 p-4 rounded-xl bg-red-50 border border-red-100">
      <div className="flex items-start gap-3">
        <X className="h-5 w-5 text-red-500 mt-0.5 flex-shrink-0" />
        <div>
          <div className="font-bold text-gray-900 text-sm">No More Articles</div>
          <div className="text-xs text-gray-700">
            We will stop generating new SEO-optimized articles for your site
          </div>
        </div>
      </div>
      <div className="flex items-start gap-3">
        <X className="h-5 w-5 text-red-500 mt-0.5 flex-shrink-0" />
        <div>
          <div className="font-bold text-gray-900 text-sm">Loss of SEO Progress</div>
          <div className="text-xs text-gray-700">
            Your search rankings will likely decline without ongoing content
          </div>
        </div>
      </div>
    </div>

    <div className="mt-4 p-3 rounded-lg bg-blue-50 flex items-start gap-2">
      <MessageCircle className="h-4 w-4 text-blue-500 mt-0.5 flex-shrink-0" />
      <div className="text-xs text-blue-900">
        <div className="font-semibold">We'd love to help before you go.</div>
        <div>
          Our support team is here to help, and you can chat with us directly to see if we can fix
          this for you.
        </div>
        <div className="font-semibold mt-1">Use the chat in the right bottom corner now.</div>
      </div>
    </div>

    <div className="mt-6 grid grid-cols-2 gap-3">
      <button
        type="button"
        onClick={onGoBack}
        disabled={processing}
        className="px-4 py-3 rounded-lg bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium disabled:opacity-60"
      >
        Go Back
      </button>
      <button
        type="button"
        onClick={onConfirm}
        disabled={processing}
        className="px-4 py-3 rounded-lg bg-red-600 hover:bg-red-700 text-white font-semibold disabled:opacity-60"
      >
        {processing ? 'Processing...' : 'Cancel My Subscription'}
      </button>
    </div>
  </div>
);

export default Billing;
