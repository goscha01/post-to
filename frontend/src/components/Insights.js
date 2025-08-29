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
  RefreshCw
} from 'lucide-react';

const Insights = () => {
  const { isAuthenticated } = useAuth();
  const [insights, setInsights] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedProfile, setSelectedProfile] = useState('');
  const [selectedPeriod, setSelectedPeriod] = useState('30');
  const [refreshing, setRefreshing] = useState(false);

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
          setSelectedProfile(profilesWithLocations[0].locations[0].name);
        }
      }
    } catch (error) {
      console.error('Error fetching data:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchInsights = async (profileId, period) => {
    if (!profileId) return;
    
    try {
      const response = await axios.get(`http://localhost:3001/api/insights/profile/${profileId}/summary`, {
        params: { period }
      });
      setInsights(response.data);
    } catch (error) {
      console.error('Error fetching insights:', error);
    }
  };

  const refreshInsights = async () => {
    if (!selectedProfile) return;
    
    setRefreshing(true);
    try {
      // Fetch fresh insights from Google API
      await axios.get(`http://localhost:3001/api/insights/google/${selectedProfile}`);
      await fetchInsights(selectedProfile, selectedPeriod);
    } catch (error) {
      console.error('Error refreshing insights:', error);
    } finally {
      setRefreshing(false);
    }
  };

  const exportInsights = async (format = 'json') => {
    if (!selectedProfile) return;
    
    try {
      const response = await axios.get(`http://localhost:3001/api/insights/profile/${selectedProfile}/export`, {
        params: { format },
        responseType: format === 'csv' ? 'blob' : 'json'
      });
      
      if (format === 'csv') {
        const url = window.URL.createObjectURL(new Blob([response.data]));
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', `insights_${selectedProfile}_${new Date().toISOString().split('T')[0]}.csv`);
        document.body.appendChild(link);
        link.click();
        link.remove();
      } else {
        const dataStr = JSON.stringify(response.data, null, 2);
        const dataBlob = new Blob([dataStr], { type: 'application/json' });
        const url = window.URL.createObjectURL(dataBlob);
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', `insights_${selectedProfile}_${new Date().toISOString().split('T')[0]}.json`);
        document.body.appendChild(link);
        link.click();
        link.remove();
      }
    } catch (error) {
      console.error('Error exporting insights:', error);
      alert('Failed to export insights. Please try again.');
    }
  };

  const getMetricIcon = (metricName) => {
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

      {/* Insights Overview */}
      {selectedProfile && insights && insights.locationMetrics && (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <div className="bg-blue-500 rounded-md p-3">
                    <Eye className="h-6 w-6 text-white" />
                  </div>
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">Total Views</dt>
                    <dd className="text-lg font-medium text-gray-900">
                      {insights.locationMetrics?.find(m => m.metric === 'VIEWS_MAPS')?.metricValues?.[0]?.value || '0'}
                    </dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <div className="bg-green-500 rounded-md p-3">
                    <Users className="h-6 w-6 text-white" />
                  </div>
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">Total Queries</dt>
                    <dd className="text-lg font-medium text-gray-900">
                      {insights.locationMetrics?.find(m => m.metric === 'QUERIES_DIRECT')?.metricValues?.[0]?.value || '0'}
                    </dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <div className="bg-purple-500 rounded-md p-3">
                    <Phone className="h-6 w-6 text-white" />
                  </div>
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">Phone Actions</dt>
                    <dd className="text-lg font-medium text-gray-900">
                      {insights.locationMetrics?.find(m => m.metric === 'ACTIONS_PHONE')?.metricValues?.[0]?.value || '0'}
                    </dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <div className="bg-yellow-500 rounded-md p-3">
                    <BarChart3 className="h-6 w-1 text-white" />
                  </div>
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">Website Clicks</dt>
                    <dd className="text-lg font-medium text-gray-900">
                      {insights.locationMetrics?.find(m => m.metric === 'ACTIONS_WEBSITE')?.metricValues?.[0]?.value || '0'}
                    </dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Detailed Metrics */}
      {selectedProfile && (
        <div className="bg-white shadow rounded-lg">
          <div className="px-6 py-4 border-b border-gray-200">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-medium text-gray-900">Detailed Metrics</h2>
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
              </div>
            </div>
          </div>
          <div className="p-6">
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
                             {/* Real Google API metrics */}
               {insights.locationMetrics?.map((metric, index) => (
                 <div key={index} className="bg-gray-50 rounded-lg p-4">
                   <div className="flex items-center justify-between">
                     <div className="flex items-center">
                       {getMetricIcon(metric.metric)}
                       <span className="text-sm font-medium text-gray-900 ml-2">
                         {metric.metric.replace(/_/g, ' ').replace(/([A-Z])/g, ' $1').trim()}
                       </span>
                     </div>
                     <span className="text-lg font-semibold text-gray-900">
                       {metric.metricValues?.[0]?.value || '0'}
                     </span>
                   </div>
                   <div className="mt-2 flex items-center text-sm">
                     <TrendingUp className="h-4 w-4 text-green-500 mr-1" />
                     <span className="text-green-600">Real-time data</span>
                   </div>
                 </div>
               ))}


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
