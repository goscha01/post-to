import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';
import {
  BarChart3,
  TrendingUp,
  TrendingDown,
  Eye,
  Users,
  Phone,
  Globe,
  Calendar,
  Download,
  RefreshCw,
  ChevronDown,
  MousePointer,
  MessageSquare,
  ShoppingCart,
  Info
} from 'lucide-react';

const Insights = () => {
  const { isAuthenticated } = useAuth();
  const [insights, setInsights] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedProfile, setSelectedProfile] = useState('');
  const [selectedPeriod, setSelectedPeriod] = useState('30');
  const [refreshing, setRefreshing] = useState(false);
  const [useCustomTime, setUseCustomTime] = useState(false);
  const [customStartDate, setCustomStartDate] = useState('');
  const [customEndDate, setCustomEndDate] = useState('');
  const [showAllMetrics, setShowAllMetrics] = useState(false);

  useEffect(() => {
    if (isAuthenticated) {
      fetchData();
    }
  }, [isAuthenticated]);

  const fetchData = async () => {
    try {
      setLoading(true);
      const profilesResponse = await axios.get('http://localhost:3001/api/gmb/accounts');
      if (profilesResponse.data.accounts) {
        const profilesWithLocations = await Promise.all(
          profilesResponse.data.accounts.map(async (account) => {
            try {
                      // Extract account ID from the full name
        const accountId = account.name.split('/').pop();
        const locationsResponse = await axios.get(
          `http://localhost:3001/api/gmb/accounts/${accountId}/locations`
        );
              return {
                ...account,
                locations: locationsResponse.data.locations || []
              };
            } catch (error) {
              return { ...account, locations: [] };
            }
          })
        );
        setProfiles(profilesWithLocations);
        if (profilesWithLocations.length > 0 && profilesWithLocations[0].locations.length > 0) {
          const firstLocation = profilesWithLocations[0].locations[0].name;
          setSelectedProfile(firstLocation);
          // Automatically fetch insights for the first profile when page loads
          // Pass the profiles data directly to avoid state timing issues
          await fetchInsightsWithProfiles(firstLocation, selectedPeriod, profilesWithLocations);
        }
      }
    } catch (error) {
      console.error('Error fetching data:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchInsightsWithProfiles = async (profileId, period, profilesData) => {
    if (!profileId) return;
    
    try {
      console.log('🔍 Profile ID received:', profileId);
      console.log('🔍 Profile ID type:', typeof profileId);
      
      // Extract account ID and location ID from the profile
      let accountId, locationId;
      
      if (profileId.includes('/')) {
        const profileParts = profileId.split('/');
        console.log('🔍 Profile parts:', profileParts);
        
        if (profileParts[0] === 'locations' && profileParts.length === 2) {
          // Format: locations/{locationId}
          locationId = profileParts[1];
          // Get account ID from the first profile
          if (profilesData.length > 0 && profilesData[0].name) {
            const accountNameParts = profilesData[0].name.split('/');
            accountId = accountNameParts[accountNameParts.length - 1];
          }
        } else if (profileParts.includes('accounts') && profileParts.includes('locations')) {
          // Format: accounts/{accountId}/locations/{locationId}
          const accountIndex = profileParts.findIndex(part => part === 'accounts');
          const locationIndex = profileParts.findIndex(part => part === 'locations');
          
          if (accountIndex !== -1 && locationIndex !== -1) {
            accountId = profileParts[accountIndex + 1];
            locationId = profileParts[locationIndex + 1];
          }
        }
      } else {
        // Handle simple ID format
        locationId = profileId;
        // Try to get account ID from the first profile
        if (profilesData.length > 0 && profilesData[0].name) {
          const accountNameParts = profilesData[0].name.split('/');
          accountId = accountNameParts[accountNameParts.length - 1];
        }
      }
      
      console.log('🔍 Extracted accountId:', accountId);
      console.log('🔍 Extracted locationId:', locationId);
      
      if (!accountId || !locationId) {
        console.error('❌ Failed to extract accountId or locationId from profile:', profileId);
        return;
      }
      
      // Use the working basic insights endpoint
      const requestData = {
        accessToken: localStorage.getItem('gmb_google_access_token'),
        accountId: accountId,
        locationId: locationId,
        metricRequests: [
          { metric: 'VIEWS_MAPS' },
          { metric: 'VIEWS_MAPS_DESKTOP' },
          { metric: 'VIEWS_MAPS_MOBILE' },
          { metric: 'VIEWS_SEARCH_DESKTOP' },
          { metric: 'VIEWS_SEARCH_MOBILE' },
          { metric: 'VIEWS_SEARCH' },
          { metric: 'ACTIONS_PHONE' },
          { metric: 'ACTIONS_WEBSITE' },
          { metric: 'ACTIONS_DRIVING_DIRECTIONS' },
          { metric: 'BUSINESS_CONVERSATIONS' },
          { metric: 'BUSINESS_BOOKINGS' },
          { metric: 'BUSINESS_FOOD_ORDERS' },
          { metric: 'BUSINESS_FOOD_MENU_CLICKS' }
        ],
        timeRange: useCustomTime && customStartDate && customEndDate
          ? {
              startTime: new Date(customStartDate).toISOString(),
              endTime: new Date(customEndDate).toISOString()
            }
          : {
              startTime: new Date(Date.now() - (parseInt(period) * 24 * 60 * 60 * 1000)).toISOString(),
              endTime: new Date().toISOString()
            }
      };

      console.log('📤 Fetching insights with data:', requestData);
      
      const response = await axios.post('http://localhost:3001/api/insights/basic', requestData);
      
      if (response.data.success) {
        setInsights(response.data.data);
        console.log('✅ Insights fetched successfully:', response.data.data);
        console.log('🔍 Response data structure:', JSON.stringify(response.data, null, 2));
        console.log('🔍 Insights data structure:', JSON.stringify(response.data.data, null, 2));
        console.log('🔍 Location metrics:', JSON.stringify(response.data.data?.locationMetrics, null, 2));
      } else {
        console.error('❌ Failed to fetch insights:', response.data.error);
      }
    } catch (error) {
      console.error('Error fetching insights:', error);
    }
  };

  const fetchInsights = async (profileId, period) => {
    if (!profileId) return;
    
    try {
      console.log('🔍 Profile ID received:', profileId);
      console.log('🔍 Profile ID type:', typeof profileId);
      
      // Extract account ID and location ID from the profile
      let accountId, locationId;
      
      if (profileId.includes('/')) {
        const profileParts = profileId.split('/');
        console.log('🔍 Profile parts:', profileParts);
        
        if (profileParts[0] === 'locations' && profileParts.length === 2) {
          // Format: locations/{locationId}
          locationId = profileParts[1];
          // Get account ID from the first profile
          if (profiles.length > 0 && profiles[0].name) {
            const accountNameParts = profiles[0].name.split('/');
            accountId = accountNameParts[accountNameParts.length - 1];
          }
        } else if (profileParts.includes('accounts') && profileParts.includes('locations')) {
          // Format: accounts/{accountId}/locations/{locationId}
          const accountIndex = profileParts.findIndex(part => part === 'accounts');
          const locationIndex = profileParts.findIndex(part => part === 'locations');
          
          if (accountIndex !== -1 && locationIndex !== -1) {
            accountId = profileParts[accountIndex + 1];
            locationId = profileParts[locationIndex + 1];
          }
        }
      } else {
        // Handle simple ID format
        locationId = profileId;
        // Try to get account ID from the first profile
        if (profiles.length > 0 && profiles[0].name) {
          const accountNameParts = profiles[0].name.split('/');
          accountId = accountNameParts[accountNameParts.length - 1];
        }
      }
      
      console.log('🔍 Extracted accountId:', accountId);
      console.log('🔍 Extracted locationId:', locationId);
      
      if (!accountId || !locationId) {
        console.error('❌ Failed to extract accountId or locationId from profile:', profileId);
        return;
      }
      
      // Use the working basic insights endpoint
      const requestData = {
        accessToken: localStorage.getItem('gmb_google_access_token'),
        accountId: accountId,
        locationId: locationId,
        metricRequests: [
          { metric: 'VIEWS_MAPS' },
          { metric: 'VIEWS_MAPS_DESKTOP' },
          { metric: 'VIEWS_MAPS_MOBILE' },
          { metric: 'VIEWS_SEARCH_DESKTOP' },
          { metric: 'VIEWS_SEARCH_MOBILE' },
          { metric: 'VIEWS_SEARCH' },
          { metric: 'ACTIONS_PHONE' },
          { metric: 'ACTIONS_WEBSITE' },
          { metric: 'ACTIONS_DRIVING_DIRECTIONS' },
          { metric: 'BUSINESS_CONVERSATIONS' },
          { metric: 'BUSINESS_BOOKINGS' },
          { metric: 'BUSINESS_FOOD_ORDERS' },
          { metric: 'BUSINESS_FOOD_MENU_CLICKS' }
        ],
        timeRange: useCustomTime && customStartDate && customEndDate
          ? {
              startTime: new Date(customStartDate).toISOString(),
              endTime: new Date(customEndDate).toISOString()
            }
          : {
              startTime: new Date(Date.now() - (parseInt(period) * 24 * 60 * 60 * 1000)).toISOString(),
              endTime: new Date().toISOString()
            }
      };

      console.log('📤 Fetching insights with data:', requestData);
      
      const response = await axios.post('http://localhost:3001/api/insights/basic', requestData);
      
      if (response.data.success) {
        setInsights(response.data.data);
        console.log('✅ Insights fetched successfully:', response.data.data);
        console.log('🔍 Response data structure:', JSON.stringify(response.data, null, 2));
        console.log('🔍 Insights data structure:', JSON.stringify(response.data.data, null, 2));
        console.log('🔍 Location metrics:', JSON.stringify(response.data.data?.locationMetrics, null, 2));
      } else {
        console.error('❌ Failed to fetch insights:', response.data.error);
      }
    } catch (error) {
      console.error('Error fetching insights:', error);
    }
  };

  const refreshInsights = async () => {
    if (!selectedProfile) return;
    
    setRefreshing(true);
    try {
      // Use the working basic insights endpoint directly
      await fetchInsights(selectedProfile, selectedPeriod);
    } catch (error) {
      console.error('Error refreshing insights:', error);
    } finally {
      setRefreshing(false);
    }
  };

  const toggleCustomTime = () => {
    setUseCustomTime(!useCustomTime);
    if (!useCustomTime) {
      // Set default custom dates when enabling
      const today = new Date();
      const thirtyDaysAgo = new Date(today.getTime() - (30 * 24 * 60 * 60 * 1000));
      setCustomStartDate(thirtyDaysAgo.toISOString().split('T')[0]);
      setCustomEndDate(today.toISOString().split('T')[0]);
    }
  };

  const handleCustomTimeChange = () => {
    if (useCustomTime && customStartDate && customEndDate && selectedProfile) {
      fetchInsights(selectedProfile, selectedPeriod);
    }
  };

  const fetchAllMetrics = async () => {
    if (!selectedProfile) return;
    
    try {
      setRefreshing(true);
      
      // Extract account ID and location ID from the profile
      let accountId, locationId;
      
      if (selectedProfile.includes('/')) {
        const profileParts = selectedProfile.split('/');
        
        if (profileParts[0] === 'locations' && profileParts.length === 2) {
          locationId = profileParts[1];
          if (profiles.length > 0 && profiles[0].name) {
            const accountNameParts = profiles[0].name.split('/');
            accountId = accountNameParts[accountNameParts.length - 1];
          }
        } else if (profileParts.includes('accounts') && profileParts.includes('locations')) {
          const accountIndex = profileParts.findIndex(part => part === 'accounts');
          const locationIndex = profileParts.findIndex(part => part === 'locations');
          
          if (accountIndex !== -1 && locationIndex !== -1) {
            accountId = profileParts[accountIndex + 1];
            locationId = profileParts[locationIndex + 1];
          }
        }
      } else {
        locationId = selectedProfile;
        if (profiles.length > 0 && profiles[0].name) {
          const accountNameParts = profiles[0].name.split('/');
          accountId = accountNameParts[accountNameParts.length - 1];
        }
      }
      
      if (!accountId || !locationId) {
        console.error('❌ Failed to extract accountId or locationId from profile:', selectedProfile);
        return;
      }
      
      // Request ALL available metrics
      const allMetrics = [
        'VIEWS_MAPS', 'VIEWS_MAPS_DESKTOP', 'VIEWS_MAPS_MOBILE', 'VIEWS_SEARCH_DESKTOP', 'VIEWS_SEARCH_MOBILE',
        'ACTIONS_PHONE', 'ACTIONS_WEBSITE', 'ACTIONS_DRIVING_DIRECTIONS', 'BUSINESS_CONVERSATIONS', 'BUSINESS_BOOKINGS',
        'BUSINESS_FOOD_ORDERS', 'BUSINESS_FOOD_MENU_CLICKS'
      ];
      
      const requestData = {
        accessToken: localStorage.getItem('gmb_google_access_token'),
        accountId: accountId,
        locationId: locationId,
        metricRequests: allMetrics.map(metric => ({ metric })),
        timeRange: useCustomTime && customStartDate && customEndDate
          ? {
              startTime: new Date(customStartDate).toISOString(),
              endTime: new Date(customEndDate).toISOString()
            }
          : {
              startTime: new Date(Date.now() - (parseInt(selectedPeriod) * 24 * 60 * 60 * 1000)).toISOString(),
              endTime: new Date().toISOString()
            }
      };
      
      console.log('📤 Fetching ALL metrics with data:', requestData);
      
      const response = await axios.post('http://localhost:3001/api/insights/basic', requestData);
      
      if (response.data.success) {
        setInsights(response.data.data);
        console.log('✅ All metrics fetched successfully:', response.data.data);
      } else {
        console.error('❌ Failed to fetch all metrics:', response.data.error);
      }
    } catch (error) {
      console.error('Error fetching all metrics:', error);
    } finally {
      setRefreshing(false);
    }
  };

  const exportInsights = async (format = 'json') => {
    if (!selectedProfile) return;
    
    try {
      // Extract account ID and location ID from the profile
      let accountId, locationId;
      
      if (selectedProfile.includes('/')) {
        const profileParts = selectedProfile.split('/');
        
        if (profileParts[0] === 'locations' && profileParts.length === 2) {
          // Format: locations/{locationId}
          locationId = profileParts[1];
          // Get account ID from the first profile
          if (profiles.length > 0 && profiles[0].name) {
            const accountNameParts = profiles[0].name.split('/');
            accountId = accountNameParts[accountNameParts.length - 1];
          }
        } else if (profileParts.includes('accounts') && profileParts.includes('locations')) {
          // Format: accounts/{accountId}/locations/{locationId}
          const accountIndex = profileParts.findIndex(part => part === 'accounts');
          const locationIndex = profileParts.findIndex(part => part === 'locations');
          
          if (accountIndex !== -1 && locationIndex !== -1) {
            accountId = profileParts[accountIndex + 1];
            locationId = profileParts[locationIndex + 1];
          }
        }
      } else {
        // Handle simple ID format
        locationId = selectedProfile;
        // Try to get account ID from the first profile
        if (profiles.length > 0 && profiles[0].name) {
          const accountNameParts = profiles[0].name.split('/');
          accountId = accountNameParts[accountNameParts.length - 1];
        }
      }
      
      if (!accountId || !locationId) {
        console.error('❌ Failed to extract accountId or locationId from profile:', selectedProfile);
        return;
      }
      
      // Use the working export endpoint
      const requestData = {
        accessToken: localStorage.getItem('gmb_google_access_token'),
        accountId: accountId,
        locationId: locationId,
        format: format,
        startDate: useCustomTime && customStartDate && customEndDate
          ? customStartDate
          : new Date(Date.now() - (parseInt(selectedPeriod) * 24 * 60 * 60 * 1000)).toISOString().split('T')[0],
        endDate: useCustomTime && customStartDate && customEndDate
          ? customEndDate
          : new Date().toISOString().split('T')[0]
      };

      console.log('📤 Exporting insights with data:', requestData);
      
      const response = await axios.post('http://localhost:3001/api/insights/export', requestData, {
        responseType: format === 'csv' ? 'blob' : 'json'
      });
      
      if (format === 'csv') {
        const url = window.URL.createObjectURL(new Blob([response.data]));
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', `insights_${locationId}_${new Date().toISOString().split('T')[0]}.csv`);
        document.body.appendChild(link);
        link.click();
        link.remove();
      } else {
        const dataStr = JSON.stringify(response.data, null, 2);
        const dataBlob = new Blob([dataStr], { type: 'application/json' });
        const url = window.URL.createObjectURL(dataBlob);
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', `insights_${locationId}_${new Date().toISOString().split('T')[0]}.json`);
        document.body.appendChild(link);
        link.click();
        link.remove();
      }
      
      console.log('✅ Export completed successfully');
    } catch (error) {
      console.error('Error exporting insights:', error);
      alert('Failed to export insights. Please try again.');
    }
  };

  const getMetricIcon = (metricName) => {
    // Safety check for undefined/null metricName
    if (!metricName || typeof metricName !== 'string') {
      console.warn('⚠️ getMetricIcon called with invalid metricName:', metricName);
      return BarChart3; // Default icon
    }
    
    if (metricName.includes('VIEWS')) return Eye;
    if (metricName.includes('QUERIES')) return Users;
    if (metricName.includes('PHONE')) return Phone;
    if (metricName.includes('WEBSITE')) return Globe;
    return BarChart3;
  };

  const getMetricColor = (metricName) => {
    if (metricName.includes('VIEWS')) return 'text-blue-600';
    if (metricName.includes('QUERIES')) return 'text-green-600';
    if (metricName.includes('PHONE')) return 'text-purple-600';
    if (metricName.includes('WEBSITE')) return 'text-orange-600';
    return 'text-gray-600';
  };

  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <p className="text-gray-500">Please log in to view insights</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Insights & Analytics</h1>
          <p className="mt-1 text-sm text-gray-500">
            Track your business performance and customer engagement metrics
          </p>
        </div>
        <div className="flex space-x-3">
          <button
            onClick={refreshInsights}
            disabled={refreshing || !selectedProfile}
            className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            onClick={toggleCustomTime}
            className={`inline-flex items-center px-4 py-2 border text-sm font-medium rounded-md ${
              useCustomTime
                ? 'border-primary-600 text-primary-600 bg-primary-50'
                : 'border-gray-300 text-gray-700 bg-white hover:bg-gray-50'
            }`}
          >
            <Calendar className="h-4 w-4 mr-2" />
            Custom Time
          </button>
          {!useCustomTime && (
            <div className="relative">
              <select
                value={selectedPeriod}
                onChange={(e) => {
                  setSelectedPeriod(e.target.value);
                  fetchInsights(selectedProfile, e.target.value);
                }}
                className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
              >
                <option value="7">Last 7 days</option>
                <option value="30">Last 30 days</option>
                <option value="90">Last 90 days</option>
              </select>
            </div>
          )}
        </div>
      </div>

      {/* Profile Selector */}
      <div className="bg-white shadow rounded-lg p-6">
        <label htmlFor="profile-select" className="block text-sm font-medium text-gray-700 mb-2">
          Select Business Profile
        </label>
        <select
          id="profile-select"
          value={selectedProfile}
          onChange={(e) => {
            setSelectedProfile(e.target.value);
            fetchInsights(e.target.value, selectedPeriod);
          }}
          className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
        >
          <option value="">Select a profile...</option>
          {profiles.map((profile) =>
            profile.locations.map((location) => (
              <option key={location.name} value={location.name}>
                {profile.accountName} - {location.title || 'Untitled Location'}
              </option>
            ))
          )}
        </select>
      </div>

      {/* Custom Time Range Selector */}
      {useCustomTime && (
        <div className="bg-white shadow rounded-lg p-6">
          <label className="block text-sm font-medium text-gray-700 mb-4">
            Custom Time Range
          </label>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label htmlFor="start-date" className="block text-sm font-medium text-gray-700 mb-2">
                Start Date
              </label>
              <input
                type="date"
                id="start-date"
                value={customStartDate}
                onChange={(e) => setCustomStartDate(e.target.value)}
                className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
              />
            </div>
            <div>
              <label htmlFor="end-date" className="block text-sm font-medium text-gray-700 mb-2">
                End Date
              </label>
              <input
                type="date"
                id="end-date"
                value={customEndDate}
                onChange={(e) => setCustomEndDate(e.target.value)}
                className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
              />
            </div>
            <div className="flex items-end">
              <button
                onClick={handleCustomTimeChange}
                disabled={!customStartDate || !customEndDate || !selectedProfile}
                className="w-full inline-flex justify-center items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Apply Range
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Time Range Indicator */}
      {selectedProfile && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex items-center">
            <Calendar className="h-5 w-5 text-blue-600 mr-2" />
            <span className="text-sm font-medium text-blue-800">
              {useCustomTime && customStartDate && customEndDate
                ? `Custom Range: ${new Date(customStartDate).toLocaleDateString()} - ${new Date(customEndDate).toLocaleDateString()}`
                : `Last ${selectedPeriod} days: ${new Date(Date.now() - (parseInt(selectedPeriod) * 24 * 60 * 60 * 1000)).toLocaleDateString()} - ${new Date().toLocaleDateString()}`
              }
            </span>
          </div>
        </div>
      )}

      {/* Business Metrics Section */}
      {selectedProfile && (
        <div className="bg-white shadow rounded-lg">
          <div className="px-6 py-4 border-b border-gray-200">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-medium text-gray-900">Business Metrics</h2>
              <div className="flex space-x-2">
                <button
                  onClick={() => exportInsights('json')}
                  className="inline-flex items-center px-3 py-1 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                >
                  <Download className="h-4 w-4 mr-1" />
                  Export JSON
                </button>
                <button
                  onClick={() => exportInsights('csv')}
                  className="inline-flex items-center px-3 py-1 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                >
                  <Download className="h-4 w-4 mr-1" />
                  Export CSV
                </button>
                <button
                  onClick={() => setShowAllMetrics(!showAllMetrics)}
                  className="inline-flex items-center px-3 py-1 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                >
                  {showAllMetrics ? 'Hide Details' : 'Show Details'}
                  <ChevronDown className={`h-4 w-4 ml-1 transition-transform ${showAllMetrics ? 'rotate-180' : ''}`} />
                </button>
                <button
                  onClick={fetchAllMetrics}
                  disabled={refreshing}
                  className="inline-flex items-center px-3 py-1 border border-green-300 text-sm font-medium rounded-md text-green-700 bg-green-50 hover:bg-green-100 disabled:opacity-50"
                >
                  <RefreshCw className={`h-4 w-4 mr-1 ${refreshing ? 'animate-spin' : ''}`} />
                  Fetch All Metrics
                </button>
              </div>
            </div>
          </div>
          <div className="p-6">
            {/* Metric Categories */}
            <div className="space-y-6">
              {/* Views & Impressions */}
              <div>
                <h3 className="text-md font-medium text-gray-900 mb-3 flex items-center">
                  <Eye className="h-5 w-5 text-blue-600 mr-2" />
                  Views & Impressions
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {[
                    { metric: 'VIEWS_MAPS', description: 'Total Maps views (desktop + mobile)', color: 'bg-blue-100 text-blue-800' },
                    { metric: 'VIEWS_SEARCH', description: 'Total Search views (desktop + mobile)', color: 'bg-blue-100 text-blue-800' },
                    { metric: 'VIEWS_MAPS_DESKTOP', description: 'Maps views on desktop only', color: 'bg-blue-50 text-blue-700' },
                    { metric: 'VIEWS_MAPS_MOBILE', description: 'Maps views on mobile only', color: 'bg-blue-50 text-blue-700' },
                    { metric: 'VIEWS_SEARCH_DESKTOP', description: 'Search views on desktop only', color: 'bg-blue-50 text-blue-700' },
                    { metric: 'VIEWS_SEARCH_MOBILE', description: 'Search views on mobile only', color: 'bg-blue-50 text-blue-700' }
                  ].map((item, index) => {
                    const metricData = insights?.locationMetrics?.find(m => m.metric === item.metric);
                    const value = metricData?.metricValues?.[0]?.value || '0';
                    return (
                      <div key={index} className="bg-gray-50 rounded-lg p-3 border-l-4 border-blue-400">
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="text-sm font-medium text-gray-900">{item.metric.replace(/_/g, ' ')}</div>
                            <div className="text-xs text-gray-600 mt-1">{item.description}</div>
                          </div>
                          <div className="text-lg font-semibold text-blue-600">{value}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Actions */}
              <div>
                <h3 className="text-md font-medium text-gray-900 mb-3 flex items-center">
                  <MousePointer className="h-5 w-5 text-green-600 mr-2" />
                  Customer Actions
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {[
                    { metric: 'ACTIONS_PHONE', description: 'Phone number clicks', color: 'bg-green-100 text-green-800' },
                    { metric: 'ACTIONS_WEBSITE', description: 'Website button clicks', color: 'bg-green-100 text-green-800' },
                    { metric: 'ACTIONS_DRIVING_DIRECTIONS', description: 'Direction requests', color: 'bg-green-100 text-green-800' }
                  ].map((item, index) => {
                    const metricData = insights?.locationMetrics?.find(m => m.metric === item.metric);
                    const value = metricData?.metricValues?.[0]?.value || '0';
                    return (
                      <div key={index} className="bg-gray-50 rounded-lg p-3 border-l-4 border-green-400">
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="text-sm font-medium text-gray-900">{item.metric.replace(/_/g, ' ')}</div>
                            <div className="text-xs text-gray-600 mt-1">{item.description}</div>
                          </div>
                          <div className="text-lg font-semibold text-green-600">{value}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Communication */}
              {showAllMetrics && (
                <div>
                  <h3 className="text-md font-medium text-gray-900 mb-3 flex items-center">
                    <MessageSquare className="h-5 w-5 text-purple-600 mr-2" />
                    Communication
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                    {[
                      { metric: 'BUSINESS_CONVERSATIONS', description: 'Message conversations received', color: 'bg-purple-100 text-purple-800' }
                    ].map((item, index) => {
                      const metricData = insights?.locationMetrics?.find(m => m.metric === item.metric);
                      const value = metricData?.metricValues?.[0]?.value || '0';
                      return (
                        <div key={index} className="bg-gray-50 rounded-lg p-3 border-l-4 border-purple-400">
                          <div className="flex items-center justify-between">
                            <div>
                              <div className="text-sm font-medium text-gray-900">{item.metric.replace(/_/g, ' ')}</div>
                              <div className="text-xs text-gray-600 mt-1">{item.description}</div>
                            </div>
                            <div className="text-lg font-semibold text-purple-600">{value}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Commerce */}
              {showAllMetrics && (
                <div>
                  <h3 className="text-md font-medium text-gray-900 mb-3 flex items-center">
                    <ShoppingCart className="h-5 w-5 text-orange-600 mr-2" />
                    Commerce & Bookings
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                    {[
                      { metric: 'BUSINESS_BOOKINGS', description: 'Reserve with Google bookings', color: 'bg-orange-100 text-orange-800' },
                      { metric: 'BUSINESS_FOOD_ORDERS', description: 'Food orders received', color: 'bg-orange-100 text-orange-800' },
                      { metric: 'BUSINESS_FOOD_MENU_CLICKS', description: 'Menu content interactions', color: 'bg-orange-100 text-orange-800' }
                    ].map((item, index) => {
                      const metricData = insights?.locationMetrics?.find(m => m.metric === item.metric);
                      const value = metricData?.metricValues?.[0]?.value || '0';
                      return (
                        <div key={index} className="bg-gray-50 rounded-lg p-3 border-l-4 border-orange-400">
                          <div className="flex items-center justify-between">
                            <div>
                              <div className="text-sm font-medium text-gray-900">{item.metric.replace(/_/g, ' ')}</div>
                              <div className="text-xs text-gray-600 mt-1">{item.description}</div>
                            </div>
                            <div className="text-lg font-semibold text-orange-600">{value}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Metric Selection Info */}
            <div className="mt-6 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
              <div className="flex">
                <Info className="h-5 w-5 text-yellow-600 mr-2 mt-0.5" />
                <div>
                  <h4 className="text-sm font-medium text-yellow-800">Metric Selection</h4>
                  <p className="text-sm text-yellow-700 mt-1">
                    Currently showing: <strong>{insights?.locationMetrics?.length || 0} selected metrics</strong>. 
                    {insights?.locationMetrics?.length === 0 ? (
                      <span> Click <strong>"Fetch All Metrics"</strong> to load data for all available metrics.</span>
                    ) : (
                      <span> Click <strong>"Fetch All Metrics"</strong> to load additional metrics, or use the regular refresh for the current selection.</span>
                    )}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Help Section */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-6">
        <div className="flex">
          <div className="flex-shrink-0">
            <svg className="h-5 w-5 text-blue-400" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
            </svg>
          </div>
          <div className="ml-3">
            <h3 className="text-sm font-medium text-blue-800">Understanding Your Insights</h3>
            <div className="mt-2 text-sm text-blue-700">
              <p>
                These metrics help you understand how customers are finding and interacting with your business. 
                Use this data to optimize your profile, improve customer engagement, and track the success of 
                your marketing efforts.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Insights;