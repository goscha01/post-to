// Frontend tests for MetaAds.js — covers what the Phase 1C spec requires:
//   - missing Ads scope UI
//   - not-connected UI
//   - account picker
//   - overview single-result rendering
//   - overview mixed-result rendering
//   - diagnostics rendering (including Meta source tag)
//   - no mutation controls rendered (Apply/Pause/Budget/Delete)
//   - JSON export excludes sensitive metadata

import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

// Mock the whole service module so we can drive each state without a real backend.
jest.mock('../services/metaAdsService', () => ({
  __esModule: true,
  default: {
    diagnoseAuth: jest.fn(),
    listAvailableAccounts: jest.fn(),
    selectAccount: jest.fn(),
    listConnected: jest.fn(),
    getOverview: jest.fn(),
    getCampaigns: jest.fn(),
    getAdSets: jest.fn(),
    getAds: jest.fn(),
    getPlacements: jest.fn(),
    getDevices: jest.fn(),
    getDemographics: jest.fn(),
    getDayHour: jest.fn(),
    getCreatives: jest.fn(),
    getDeliveryIssues: jest.fn(),
    getDiagnostics: jest.fn(),
    interpretMetaError: jest.fn((err) => ({
      intent: err?.response?.data?.code ? String(err.response.data.code).toLowerCase() : 'generic',
      message: err?.message || 'err',
    })),
  },
}));

// eslint-disable-next-line import/first
import metaAdsService from '../services/metaAdsService';
// eslint-disable-next-line import/first
import MetaAds from './MetaAds';

// -------- helpers --------

const asOk = (payload) => Promise.resolve(payload);
const asErr = (code) => Promise.reject({ response: { data: { code }, status: 400 }, message: code });

function stubHappyReports() {
  metaAdsService.getOverview.mockResolvedValue({
    adAccountId: 'act_1',
    days: 30,
    totals: { spend: 100, impressions: 5000, reach: 4000, frequency: 1.2, clicks: 40, ctr: 0.8, cpc: 2.5, cpm: 20 },
    results: { value: 5, actionType: 'lead', label: 'OUTCOME_LEADS' },
    costPerResult: 20,
    resultsByObjective: [{ objective: 'OUTCOME_LEADS', actionType: 'lead', results: 5, spend: 100, costPerResult: 20 }],
    campaignCount: 2,
  });
  metaAdsService.getDiagnostics.mockResolvedValue({
    counts: { high: 1, medium: 0, low: 0, total: 1 },
    issues: [
      {
        id: 'i1', severity: 'high', type: 'high_frequency',
        title: 'Ad shown 5.0× per user', guidance: 'Refresh creative',
        entityType: 'ad', entityIds: ['a1'],
        metrics: { frequency: 5, impressions: 2000 }, source: 'computed',
      },
      {
        id: 'i2', severity: 'high', type: 'meta_delivery_issue',
        title: 'Payment method invalid', guidance: 'Add a card',
        entityType: 'ad', entityIds: ['a2'],
        metrics: { errorCode: 1487220 }, source: 'meta',
      },
    ],
  });
  metaAdsService.getCampaigns.mockResolvedValue({ campaigns: [] });
  metaAdsService.getAdSets.mockResolvedValue({ adsets: [] });
  metaAdsService.getAds.mockResolvedValue({ ads: [] });
  metaAdsService.getPlacements.mockResolvedValue({ rows: [] });
  metaAdsService.getDevices.mockResolvedValue({ rows: [] });
  metaAdsService.getDemographics.mockResolvedValue({ rows: [] });
  metaAdsService.getDayHour.mockResolvedValue({ rows: [] });
  metaAdsService.getCreatives.mockResolvedValue({ creatives: [] });
  metaAdsService.getDeliveryIssues.mockResolvedValue({ issues: [] });
}

beforeEach(() => {
  jest.clearAllMocks();
  // Clean localStorage between tests so account-selection carryover doesn't
  // pollute the "picker shows when no selection" test.
  window.localStorage.clear();
});

// ============================================================================
// Connection states
// ============================================================================

test('renders not_connected state when Meta not connected', async () => {
  metaAdsService.diagnoseAuth.mockResolvedValue({ metaConnected: false });
  render(<MetaAds />);
  await waitFor(() => screen.getByText(/Connect Meta to see Ads reporting/i));
  expect(screen.getByText(/Go to Connections/i)).toBeInTheDocument();
});

test('renders missing_scope state with reconnect CTA when ads_read missing', async () => {
  metaAdsService.diagnoseAuth.mockResolvedValue({
    metaConnected: true,
    isValid: true,
    hasAdsReadScope: false,
    hasAdsManagementScope: false,
  });
  render(<MetaAds />);
  await waitFor(() => screen.getByText(/Reconnect Meta for Ads reporting/i));
  expect(screen.getByText(/existing Pages and Instagram accounts remain connected/i)).toBeInTheDocument();
});

test('renders no_accounts state when Meta returns META_NO_AD_ACCOUNTS', async () => {
  metaAdsService.diagnoseAuth.mockResolvedValue({ metaConnected: true, isValid: true, hasAdsReadScope: true });
  metaAdsService.listAvailableAccounts.mockResolvedValue({
    code: 'META_NO_AD_ACCOUNTS',
    accounts: [],
  });
  render(<MetaAds />);
  await waitFor(() => screen.getByText(/No accessible ad accounts/i));
});

// ============================================================================
// Account picker
// ============================================================================

test('renders account picker when accounts available but none selected', async () => {
  metaAdsService.diagnoseAuth.mockResolvedValue({ metaConnected: true, isValid: true, hasAdsReadScope: true });
  metaAdsService.listAvailableAccounts.mockResolvedValue({
    accounts: [
      { id: 'act_1', name: 'Tampa', currency: 'USD' },
      { id: 'act_2', name: 'Jax', currency: 'USD' },
    ],
    selection: { adAccountIds: [], defaultAdAccountId: null },
  });
  render(<MetaAds />);
  // Picker heading is unique to the picker component.
  await screen.findByText(/Choose a Meta ad account/i);
  // Wait for the accounts to populate — findAllByText auto-waits until at
  // least one match appears, then we check we got exactly two.
  const btns = await screen.findAllByText(/Use this account/i);
  expect(btns).toHaveLength(2);
});

test('picker calls selectAccount when Use this account is clicked', async () => {
  metaAdsService.diagnoseAuth.mockResolvedValue({ metaConnected: true, isValid: true, hasAdsReadScope: true });
  metaAdsService.listAvailableAccounts.mockResolvedValue({
    accounts: [{ id: 'act_1', name: 'Tampa', currency: 'USD' }],
    selection: { adAccountIds: [], defaultAdAccountId: null },
  });
  metaAdsService.selectAccount.mockResolvedValue({
    adAccountIds: ['act_1'],
    defaultAdAccountId: 'act_1',
  });
  stubHappyReports();
  render(<MetaAds />);
  const useBtn = await screen.findByText(/Use this account/i);
  fireEvent.click(useBtn);
  await waitFor(() => expect(metaAdsService.selectAccount).toHaveBeenCalledWith(
    expect.objectContaining({ adAccountIds: expect.arrayContaining(['act_1']) })
  ));
});

// ============================================================================
// Overview rendering — single vs mixed results
// ============================================================================

test('overview: single-objective account shows top-level results KPI', async () => {
  metaAdsService.diagnoseAuth.mockResolvedValue({ metaConnected: true, isValid: true, hasAdsReadScope: true });
  metaAdsService.listAvailableAccounts.mockResolvedValue({
    accounts: [{ id: 'act_1', name: 'Tampa', currency: 'USD' }],
    selection: { adAccountIds: ['act_1'], defaultAdAccountId: 'act_1' },
  });
  stubHappyReports();
  render(<MetaAds />);
  await waitFor(() => screen.getByText(/Spend/i));
  // Result KPI label is "Lead" not "Campaigns"
  expect(screen.getByText('Lead')).toBeInTheDocument();
  // Value is formatted integer 5
  expect(screen.getByText('5')).toBeInTheDocument();
});

test('overview: mixed-objective account shows breakdown, not top-level scalar', async () => {
  metaAdsService.diagnoseAuth.mockResolvedValue({ metaConnected: true, isValid: true, hasAdsReadScope: true });
  metaAdsService.listAvailableAccounts.mockResolvedValue({
    accounts: [{ id: 'act_1', name: 'Tampa', currency: 'USD' }],
    selection: { adAccountIds: ['act_1'], defaultAdAccountId: 'act_1' },
  });
  metaAdsService.getOverview.mockResolvedValue({
    adAccountId: 'act_1', days: 30,
    totals: { spend: 200, impressions: 10000, reach: 8000, frequency: 1.25, clicks: 100, ctr: 1, cpc: 2, cpm: 20 },
    results: { value: null, actionType: null, label: null },
    costPerResult: null,
    resultsByObjective: [
      { objective: 'OUTCOME_LEADS', actionType: 'lead', results: 5, spend: 100, costPerResult: 20 },
      { objective: 'OUTCOME_SALES', actionType: 'purchase', results: 2, spend: 100, costPerResult: 50 },
    ],
    campaignCount: 2,
  });
  metaAdsService.getDiagnostics.mockResolvedValue({ counts: {}, issues: [] });
  metaAdsService.getCampaigns.mockResolvedValue({ campaigns: [] });
  metaAdsService.getAdSets.mockResolvedValue({ adsets: [] });
  metaAdsService.getAds.mockResolvedValue({ ads: [] });
  metaAdsService.getPlacements.mockResolvedValue({ rows: [] });
  metaAdsService.getDevices.mockResolvedValue({ rows: [] });
  metaAdsService.getDemographics.mockResolvedValue({ rows: [] });
  metaAdsService.getDayHour.mockResolvedValue({ rows: [] });
  metaAdsService.getCreatives.mockResolvedValue({ creatives: [] });
  metaAdsService.getDeliveryIssues.mockResolvedValue({ issues: [] });

  render(<MetaAds />);
  await waitFor(() => screen.getByText(/Results by objective/i));
  expect(screen.getByText('Leads')).toBeInTheDocument();
  expect(screen.getByText('Sales')).toBeInTheDocument();
});

// ============================================================================
// Diagnostics rendering + Meta source pill
// ============================================================================

test('diagnostics: renders each issue card with severity + source pill', async () => {
  metaAdsService.diagnoseAuth.mockResolvedValue({ metaConnected: true, isValid: true, hasAdsReadScope: true });
  metaAdsService.listAvailableAccounts.mockResolvedValue({
    accounts: [{ id: 'act_1', name: 'Tampa', currency: 'USD' }],
    selection: { adAccountIds: ['act_1'], defaultAdAccountId: 'act_1' },
  });
  stubHappyReports();
  render(<MetaAds />);
  // Click the Diagnostics tab. Tab appears once the connected view renders.
  const diagTab = await waitFor(() => screen.getByRole('button', { name: /Diagnostics/i }));
  fireEvent.click(diagTab);
  await waitFor(() => screen.getByText(/Payment method invalid/i));
  // Meta-source pill visible on the meta-source issue
  expect(screen.getByText('Meta')).toBeInTheDocument();
  // "Review with Campaign Assistant →" CTA is present on issue cards
  expect(screen.getAllByText(/Review with Campaign Assistant/i).length).toBeGreaterThanOrEqual(1);
});

// ============================================================================
// No mutation controls anywhere
// ============================================================================

test('no mutation controls rendered on the entire dashboard', async () => {
  metaAdsService.diagnoseAuth.mockResolvedValue({ metaConnected: true, isValid: true, hasAdsReadScope: true });
  metaAdsService.listAvailableAccounts.mockResolvedValue({
    accounts: [{ id: 'act_1', name: 'Tampa', currency: 'USD' }],
    selection: { adAccountIds: ['act_1'], defaultAdAccountId: 'act_1' },
  });
  stubHappyReports();
  render(<MetaAds />);
  await waitFor(() => screen.getByText(/Spend/i));
  // Walk every rendered button and assert none match a Phase 2 mutation label.
  const forbiddenLabels = [
    /^Apply$/i,
    /^Apply Fix/i,
    /^Pause$/i,
    /^Pause Ad$/i,
    /^Pause Campaign$/i,
    /^Resume$/i,
    /^Set Budget/i,
    /^Update Budget/i,
    /^Boost$/i,
    /^Delete$/i,
  ];
  const buttons = screen.getAllByRole('button');
  for (const btn of buttons) {
    for (const pattern of forbiddenLabels) {
      expect(btn.textContent || '').not.toMatch(pattern);
    }
  }
});

// ============================================================================
// JSON export excludes sensitive metadata
// ============================================================================

test('JSON export excludes access tokens and sensitive metadata keys', async () => {
  metaAdsService.diagnoseAuth.mockResolvedValue({ metaConnected: true, isValid: true, hasAdsReadScope: true });
  metaAdsService.listAvailableAccounts.mockResolvedValue({
    accounts: [{ id: 'act_1', name: 'Tampa', currency: 'USD', timezoneName: 'America/Detroit' }],
    selection: { adAccountIds: ['act_1'], defaultAdAccountId: 'act_1' },
  });
  stubHappyReports();

  // Capture the JSON content by intercepting the Blob constructor. jsdom
  // does not implement Blob.text(), so we snapshot the parts instead.
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const originalBlob = global.Blob;
  const capturedText = [];
  global.Blob = class MockBlob {
    constructor(parts) {
      this._parts = parts;
      capturedText.push(parts.join(''));
    }
    get size() { return 0; }
    get type() { return 'application/json'; }
  };
  URL.createObjectURL = () => 'blob:mock';
  URL.revokeObjectURL = () => {};
  // Also stub anchor.click so the download doesn't actually navigate.
  const originalClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = () => {};

  try {
    render(<MetaAds />);
    await waitFor(() => screen.getByText(/Spend/i));
    const jsonBtn = screen.getByTitle(/no tokens or connection metadata/i);
    fireEvent.click(jsonBtn);

    expect(capturedText.length).toBe(1);
    const text = capturedText[0];
    // Never contains any of these fragments — none of our per-tab payloads
    // should carry tokens even by accident.
    const forbidden = [
      'owner_user_token',
      'page_access_token',
      'user_access_token',
      'access_token',
      'EAAG', // Meta token prefix
      'client_secret',
    ];
    for (const f of forbidden) {
      expect(text).not.toContain(f);
    }
    // Sanity: export includes what we expect it to
    const parsed = JSON.parse(text);
    expect(parsed.account.id).toBe('act_1');
    expect(parsed.overview).toBeDefined();
    expect(parsed.diagnostics).toBeDefined();
  } finally {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    global.Blob = originalBlob;
    HTMLAnchorElement.prototype.click = originalClick;
  }
});
