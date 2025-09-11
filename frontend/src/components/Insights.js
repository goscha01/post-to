import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';
import {
  LineChart as RechartsLineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  AreaChart,
  Area
} from 'recharts';
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
  Info,
  LineChart,
  Activity
} from 'lucide-react';

const Insights = () => {
  const { isAuthenticated, isDisconnected } = useAuth();
  const [insights, setInsights] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedProfile, setSelectedProfile] = useState('');
  const [selectedPeriod, setSelectedPeriod] = useState('30d');
  const [refreshing, setRefreshing] = useState(false);
  const [useCustomTime, setUseCustomTime] = useState(false);
  const [customStartDate, setCustomStartDate] = useState('');
  const [customEndDate, setCustomEndDate] = useState('');
  const [showAllMetrics, setShowAllMetrics] = useState(false);
  const [showCustomTimeForm, setShowCustomTimeForm] = useState(false);
  const [timelineData, setTimelineData] = useState(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [showTimeline, setShowTimeline] = useState(true);
  const [selectedTimelineMetrics, setSelectedTimelineMetrics] = useState(['VIEWS_MAPS', 'VIEWS_SEARCH', 'ACTIONS_PHONE']);

  // Helper function to calculate time range start based on period
  const getTimeRangeStart = (period) => {
    const now = new Date();
    
    if (period === 'custom') {
      return new Date(customStartDate);
    }
    
    // Handle specific month selection (month_2024_04 format)
    if (period.startsWith('month_')) {
      const parts = period.split('_');
      const year = parseInt(parts[1]);
      const month = parseInt(parts[2]) - 1; // JavaScript months are 0-indexed
      return new Date(year, month, 1, 0, 0, 0, 0);
    }
    
    // Handle days
    if (period.endsWith('d')) {
      const days = parseInt(period);
      return new Date(now.getTime() - (days * 24 * 60 * 60 * 1000));
    }
    
    // Handle months - use actual calendar months
    if (period.endsWith('m')) {
      const months = parseInt(period);
      const result = new Date(now);
      result.setMonth(result.getMonth() - months);
      // Set to first day of the month for consistency
      result.setDate(1);
      result.setHours(0, 0, 0, 0);
      return result;
    }
    
    // Handle years - use actual calendar years
    if (period.endsWith('y')) {
      const years = parseInt(period);
      const result = new Date(now);
      result.setFullYear(result.getFullYear() - years);
      // Set to first day of the year for consistency
      result.setMonth(0);
      result.setDate(1);
      result.setHours(0, 0, 0, 0);
      return result;
    }
    
    // Default to days for backward compatibility
    const days = parseInt(period) || 30;
    return new Date(now.getTime() - (days * 24 * 60 * 60 * 1000));
  };

  // Helper function to calculate time range end based on period
  const getTimeRangeEnd = (period) => {
    const now = new Date();
    
    if (period === 'custom') {
      return new Date(customEndDate);
    }
    
    // Handle specific month selection - end of the selected month
    if (period.startsWith('month_')) {
      const parts = period.split('_');
      const year = parseInt(parts[1]);
      const month = parseInt(parts[2]) - 1; // JavaScript months are 0-indexed
      return new Date(year, month + 1, 0, 23, 59, 59, 999); // Last day of the month
    }
    
    // For other periods, use current time
    return now;
  };

  // Helper function to generate month options for dropdown
  const generateMonthOptions = () => {
    const options = [];
    const now = new Date();
    
    // Generate options for the last 12 months
    for (let i = 0; i < 12; i++) {
      const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthName = date.toLocaleDateString('en-US', { month: 'long' });
      const year = date.getFullYear();
      const value = `month_${year}_${String(date.getMonth() + 1).padStart(2, '0')}`;
      
      options.push({
        value: value,
        label: `${monthName} ${year}`,
        year: year,
        month: date.getMonth()
      });
    }
    
    return options;
  };

  // Helper function to get display name for period
  const getPeriodDisplayName = (period) => {
    if (period === 'custom') return 'Custom Range';
    
    // Handle specific month selection
    if (period.startsWith('month_')) {
      const startDate = getTimeRangeStart(period);
      const endDate = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 0); // Last day of the month
      return `${startDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`;
    }
    
    if (period.endsWith('d')) {
      const days = parseInt(period);
      return `Last ${days} day${days === 1 ? '' : 's'}`;
    }
    
    if (period.endsWith('m')) {
      const months = parseInt(period);
      const startDate = getTimeRangeStart(period);
      const endDate = new Date();
      
      if (months === 1) {
        return `${startDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`;
      } else {
        const startMonth = startDate.toLocaleDateString('en-US', { month: 'long' });
        const endMonth = endDate.toLocaleDateString('en-US', { month: 'long' });
        return `${startMonth} - ${endMonth} ${endDate.getFullYear()}`;
      }
    }
    
    if (period.endsWith('y')) {
      const years = parseInt(period);
      const startDate = getTimeRangeStart(period);
      const endDate = new Date();
      
      if (years === 1) {
        return `${startDate.getFullYear()}`;
      } else {
        return `${startDate.getFullYear()} - ${endDate.getFullYear()}`;
      }
    }
    
    // Default for backward compatibility
    return `Last ${period} days`;
  };

  // Timeline configuration
  const timelineMetricOptions = [
    { value: 'VIEWS_MAPS', label: 'Maps Views', color: '#3B82F6' },
    { value: 'VIEWS_SEARCH', label: 'Search Views', color: '#10B981' },
    { value: 'VIEWS_MAPS_DESKTOP', label: 'Maps (Desktop)', color: '#6366F1' },
    { value: 'VIEWS_MAPS_MOBILE', label: 'Maps (Mobile)', color: '#8B5CF6' },
    { value: 'VIEWS_SEARCH_DESKTOP', label: 'Search (Desktop)', color: '#06B6D4' },
    { value: 'VIEWS_SEARCH_MOBILE', label: 'Search (Mobile)', color: '#84CC16' },
    { value: 'ACTIONS_PHONE', label: 'Phone Clicks', color: '#F59E0B' },
    { value: 'ACTIONS_WEBSITE', label: 'Website Clicks', color: '#EF4444' },
    { value: 'ACTIONS_DRIVING_DIRECTIONS', label: 'Directions', color: '#EC4899' },
    { value: 'BUSINESS_CONVERSATIONS', label: 'Conversations', color: '#14B8A6' },
    { value: 'BUSINESS_BOOKINGS', label: 'Bookings', color: '#F97316' },
    { value: 'BUSINESS_FOOD_ORDERS', label: 'Food Orders', color: '#DC2626' }
  ];

// Replace your fetchTimelineData function with this version that uses the working date range

const fetchTimelineData = async (profileId, period) => {
  if (!profileId) return;
  
  try {
    console.log('🔍 Fetching timeline for profile:', profileId);
    
    // Extract locationId (same logic as above)
    let locationId;
    if (profileId.includes('/')) {
      const profileParts = profileId.split('/');
      if (profileParts[0] === 'locations' && profileParts.length === 2) {
        locationId = profileParts[1];
      } else if (profileParts.includes('locations')) {
        const locationIndex = profileParts.findIndex(part => part === 'locations');
        if (locationIndex !== -1) {
          locationId = profileParts[locationIndex + 1];
        }
      }
    } else {
      locationId = profileId;
    }
    
    if (!locationId) {
      console.error('❌ Failed to extract locationId from profile:', profileId);
      return;
    }
    
    const requestData = {
      startDate: useCustomTime && customStartDate ? new Date(customStartDate).toISOString() : getTimeRangeStart(period).toISOString(),
      endDate: useCustomTime && customEndDate ? new Date(customEndDate).toISOString() : getTimeRangeEnd(period).toISOString(),
      metrics: ['BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH', 'CALL_CLICKS']
    };
    
    console.log('📤 Fetching timeline data with:', requestData);
    
    // FIXED: Use backticks and JWT headers  
    const response = await axios.post(
      `http://localhost:3001/api/gmb/locations/${locationId}/insights/timeline`,
      requestData,
      { headers: getAuthHeaders() }
    );
    
    if (response.data.success) {
      setTimelineData(response.data.data);
      console.log('✅ Timeline data fetched successfully:', response.data.data);
    } else {
      console.error('❌ Failed to fetch timeline data:', response.data.error);
    }
  } catch (error) {
    console.error('Error fetching timeline data:', error);
    if (error.response?.status === 401) {
      console.error('❌ Authentication failed - please reconnect your GMB account');
    }
  }
};

  // Transform timeline data for chart
// Add this debug code to your transformTimelineDataForChart function
const transformTimelineDataForChart = () => {
  console.log('🔍 DEBUG: Starting timeline transform');
  console.log('🔍 DEBUG: timelineData:', timelineData);
  
  if (!timelineData || !timelineData.metrics) {
    console.log('❌ DEBUG: No timeline data or metrics found');
    return [];
  }
  
  console.log('🔍 DEBUG: Found metrics:', timelineData.metrics.length);
  
  // Get all unique dates from all metrics
  const allDates = new Set();
  timelineData.metrics.forEach(metric => {
    console.log('🔍 DEBUG: Processing metric:', metric.metric);
    console.log('🔍 DEBUG: Time series data length:', metric.timeSeriesData?.length || 0);
    
    if (metric.timeSeriesData) {
      metric.timeSeriesData.forEach(dataPoint => {
        console.log('🔍 DEBUG: Found data point:', dataPoint);
        allDates.add(dataPoint.date);
      });
    }
  });
  
  console.log('🔍 DEBUG: All unique dates:', Array.from(allDates));
  
  // Sort dates
  const sortedDates = Array.from(allDates).sort();
  console.log('🔍 DEBUG: Sorted dates:', sortedDates);
  
  // Transform data into chart format
  const chartData = sortedDates.map(date => {
    const dataPoint = { 
      date: new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) 
    };
    
    timelineData.metrics.forEach(metric => {
      const dayData = metric.timeSeriesData.find(d => d.date === date);
      dataPoint[metric.metric] = dayData ? dayData.value : 0;
    });
    
    return dataPoint;
  });
  
  console.log('🔍 DEBUG: Final chart data:', chartData);
  console.log('🔍 DEBUG: Chart data length:', chartData.length);
  
  // ADD THIS NEW DEBUG CODE
  console.log('🔍 DEBUG: Sample chart data points (first 3):');
  chartData.slice(0, 3).forEach((point, index) => {
    console.log(`🔍 DEBUG: Point ${index}:`, point);
  });
  
  // Check for ACTIONS_PHONE specifically
  const hasPhoneData = chartData.some(point => point.ACTIONS_PHONE > 0);
  console.log('🔍 DEBUG: Has phone data:', hasPhoneData);
  
  // Show metric totals
  const metricTotals = {};
  timelineData.metrics.forEach(metric => {
    const total = metric.timeSeriesData.reduce((sum, point) => sum + point.value, 0);
    metricTotals[metric.metric] = total;
  });
  console.log('🔍 DEBUG: Metric totals:', metricTotals);
  
  return chartData;
};

  // Handle timeline metric selection
  const handleTimelineMetricToggle = (metric) => {
    const newSelection = selectedTimelineMetrics.includes(metric)
      ? selectedTimelineMetrics.filter(m => m !== metric)
      : [...selectedTimelineMetrics, metric];
    
    setSelectedTimelineMetrics(newSelection);
    
    // Pass the new selection explicitly to avoid state timing issues
    if (selectedProfile && newSelection.length > 0) {
      setTimeout(() => fetchTimelineData(selectedProfile, selectedPeriod, profiles, newSelection), 100);
    }
  };

  useEffect(() => {
    if (isAuthenticated && !isDisconnected) {
      // Check if business profiles are connected
      const businessConnected = localStorage.getItem('gmb_business_connected') === 'true';
      if (businessConnected) {
        fetchData();
      } else {
        // User is authenticated but business profiles not connected
        setInsights([]);
        setProfiles([]);
        setLoading(false);
      }
    } else if (isDisconnected) {
      // Clear data when disconnected
      setInsights([]);
      setProfiles([]);
      setLoading(false);
    }
  }, [isAuthenticated, isDisconnected]);

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
          // Also fetch timeline data
          await fetchTimelineData(firstLocation, selectedPeriod, profilesWithLocations);
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
      
      // FIXED: Correct request structure for your backend
      const requestData = {
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
              startTime: getTimeRangeStart(period).toISOString(),
              endTime: getTimeRangeEnd(period).toISOString()
            }
        // REMOVED: accessToken, accountId, locationId - these come from JWT and URL
      };
  
      console.log('📤 Fetching insights with data:', requestData);
      
      // FIXED: Use backticks for template string and JWT headers
      const response = await axios.post(
        `http://localhost:3001/api/gmb/locations/${locationId}/insights`, 
        requestData,
        { headers: getAuthHeaders() }
      );
      
      if (response.data.success) {
        setInsights(response.data.insights); // Note: changed from .data to .insights
        console.log('✅ Insights fetched successfully:', response.data.insights);
      } else {
        console.error('❌ Failed to fetch insights:', response.data.error);
      }
    } catch (error) {
      console.error('Error fetching insights:', error);
      if (error.response?.status === 401) {
        console.error('❌ Authentication failed - please reconnect your GMB account');
      }
    }
  };

  const fetchInsights = async (profileId, period) => {
    if (!profileId) return;
    
    try {
      console.log('🔍 Profile ID received:', profileId);
      
      // Extract account ID and location ID from the profile
      let accountId, locationId;
      
      if (profileId.includes('/')) {
        const profileParts = profileId.split('/');
        console.log('🔍 Profile parts:', profileParts);
        
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
        locationId = profileId;
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
      
      // FIXED: Correct request structure
      const requestData = {
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
              startTime: getTimeRangeStart(period).toISOString(),
              endTime: getTimeRangeEnd(period).toISOString()
            }
      };
  
      console.log('📤 Fetching insights with data:', requestData);
      
      // FIXED: Use backticks and JWT headers
      const response = await axios.post(
        `http://localhost:3001/api/gmb/locations/${locationId}/insights`, 
        requestData,
        { headers: getAuthHeaders() }
      );
      
      if (response.data.success) {
        setInsights(response.data.insights);
        console.log('✅ Insights fetched successfully:', response.data.insights);
      } else {
        console.error('❌ Failed to fetch insights:', response.data.error);
      }
    } catch (error) {
      console.error('Error fetching insights:', error);
      if (error.response?.status === 401) {
        console.error('❌ Authentication failed - please reconnect your GMB account');
      }
    }
  };

  const refreshInsights = async () => {
    if (!selectedProfile) return;
    
    setRefreshing(true);
    try {
      // Use the working basic insights endpoint directly
      await fetchInsights(selectedProfile, selectedPeriod);
      // Also refresh timeline data
      await fetchTimelineData(selectedProfile, selectedPeriod);
    } catch (error) {
      console.error('Error refreshing insights:', error);
    } finally {
      setRefreshing(false);
    }
  };


  const handleCustomTimeChange = () => {
    if (useCustomTime && customStartDate && customEndDate && selectedProfile) {
      fetchInsights(selectedProfile, 'custom');
      fetchTimelineData(selectedProfile, 'custom');
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
      
      // FIXED: Correct request structure
      const requestData = {
        metricRequests: allMetrics.map(metric => ({ metric })),
        timeRange: useCustomTime && customStartDate && customEndDate
          ? {
              startTime: new Date(customStartDate).toISOString(),
              endTime: new Date(customEndDate).toISOString()
            }
          : {
              startTime: getTimeRangeStart(selectedPeriod).toISOString(),
              endTime: getTimeRangeEnd(selectedPeriod).toISOString()
            }
      };
      
      console.log('📤 Fetching ALL metrics with data:', requestData);
      
      // FIXED: Use backticks and JWT headers
      const response = await axios.post(
        `http://localhost:3001/api/gmb/locations/${locationId}/insights`, 
        requestData,
        { headers: getAuthHeaders() }
      );
      
      if (response.data.success) {
        setInsights(response.data.insights);
        console.log('✅ All metrics fetched successfully:', response.data.insights);
      } else {
        console.error('❌ Failed to fetch all metrics:', response.data.error);
      }
    } catch (error) {
      console.error('Error fetching all metrics:', error);
      if (error.response?.status === 401) {
        console.error('❌ Authentication failed - please reconnect your GMB account');
      }
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

  // Get JWT token for authentication
const getAuthHeaders = () => {
  const jwtToken = localStorage.getItem('gmb_jwt_token');
  return {
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json'
  };
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
                const value = e.target.value;
                setSelectedPeriod(value);
                if (value === 'custom') {
                  setUseCustomTime(true);
                  setShowCustomTimeForm(true);
                  // Set default custom dates when enabling
                  const today = new Date();
                  const thirtyDaysAgo = new Date(today.getTime() - (30 * 24 * 60 * 60 * 1000));
                  setCustomStartDate(thirtyDaysAgo.toISOString().split('T')[0]);
                  setCustomEndDate(today.toISOString().split('T')[0]);
                } else {
                  setUseCustomTime(false);
                  setShowCustomTimeForm(false);
                  fetchInsights(selectedProfile, value);
                  fetchTimelineData(selectedProfile, value);
                }
              }}
              className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
            >
              <optgroup label="Days">
                <option value="7d">Last 7 days</option>
                <option value="30d">Last 30 days</option>
                <option value="90d">Last 90 days</option>
              </optgroup>
              <optgroup label="Specific Months">
                {generateMonthOptions().map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Calendar Months">
                <option value="1m">Last 1 calendar month</option>
                <option value="3m">Last 3 calendar months</option>
                <option value="6m">Last 6 calendar months</option>
                <option value="12m">Last 12 calendar months</option>
              </optgroup>
              <optgroup label="Years">
                <option value="1y">Last 1 year</option>
                <option value="2y">Last 2 years</option>
              </optgroup>
              <optgroup label="Custom">
                <option value="custom">Custom time range</option>
              </optgroup>
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
            fetchTimelineData(e.target.value, selectedPeriod);
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
      {showCustomTimeForm && (
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
                : `${getPeriodDisplayName(selectedPeriod)}: ${getTimeRangeStart(selectedPeriod).toLocaleDateString()} - ${new Date().toLocaleDateString()}`
              }
            </span>
          </div>
        </div>
      )}

      {/* Timeline Graph Section */}
      {selectedProfile && (
        <div className="bg-white shadow rounded-lg">
          <div className="px-6 py-4 border-b border-gray-200">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-medium text-gray-900 flex items-center">
                <Activity className="h-5 w-5 text-blue-600 mr-2" />
                Performance Timeline
              </h2>
              <div className="flex space-x-2">
                <button
                  onClick={() => setShowTimeline(!showTimeline)}
                  className="inline-flex items-center px-3 py-1 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                >
                  <LineChart className="h-4 w-4 mr-1" />
                  {showTimeline ? 'Hide Timeline' : 'Show Timeline'}
                </button>
                <button
                  onClick={() => fetchTimelineData(selectedProfile, selectedPeriod)}
                  disabled={timelineLoading}
                  className="inline-flex items-center px-3 py-1 border border-blue-300 text-sm font-medium rounded-md text-blue-700 bg-blue-50 hover:bg-blue-100 disabled:opacity-50"
                >
                  <RefreshCw className={`h-4 w-4 mr-1 ${timelineLoading ? 'animate-spin' : ''}`} />
                  Refresh Timeline
                </button>
              </div>
            </div>
          </div>
          
          {showTimeline && (
            <div className="p-6">
              {/* Metric Selection */}
              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-700 mb-3">
                  Select Metrics for Timeline
                </label>
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                  {timelineMetricOptions.map((option) => (
                    <label key={option.value} className="flex items-center space-x-2 p-2 border rounded-md hover:bg-gray-50 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedTimelineMetrics.includes(option.value)}
                        onChange={() => handleTimelineMetricToggle(option.value)}
                        className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                      <div className="flex items-center space-x-1">
                        <div 
                          className="w-3 h-3 rounded"
                          style={{ backgroundColor: option.color }}
                        ></div>
                        <span className="text-sm text-gray-700">{option.label}</span>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

{/* Timeline Chart */}
{timelineLoading ? (
  <div className="flex items-center justify-center h-64">
    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
  </div>
) : (() => {
  const chartData = transformTimelineDataForChart();
  console.log('🔍 DEBUG: About to render chart with data:', chartData);
  console.log('🔍 DEBUG: Selected timeline metrics:', selectedTimelineMetrics);
  
  return chartData.length > 0 ? (
    <div className="h-96">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis 
            dataKey="date" 
            tick={{ fontSize: 12 }}
            angle={-45}
            textAnchor="end"
            height={60}
          />
          <YAxis tick={{ fontSize: 12 }} />
          <Tooltip 
            contentStyle={{
              backgroundColor: 'rgba(255, 255, 255, 0.95)',
              border: '1px solid #e5e7eb',
              borderRadius: '6px'
            }}
          />
          <Legend />
          {selectedTimelineMetrics.map((metric) => {
            const option = timelineMetricOptions.find(opt => opt.value === metric);
            console.log('🔍 DEBUG: Rendering area for metric:', metric, 'with color:', option?.color);
            return (
              <Area
                key={metric}
                type="monotone"
                dataKey={metric}
                stackId="1"
                stroke={option?.color || '#3B82F6'}
                fill={option?.color || '#3B82F6'}
                fillOpacity={0.6}
                name={option?.label || metric}
              />
            );
          })}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  ) : (
    <div className="flex flex-col items-center justify-center h-64 text-gray-500">
      <LineChart className="h-12 w-12 mb-2 text-gray-400" />
      <p className="text-lg font-medium">No timeline data available</p>
      <p className="text-sm">Chart data length: {chartData.length}</p>
      <p className="text-sm">Timeline data exists: {timelineData ? 'Yes' : 'No'}</p>
      <p className="text-sm">Metrics count: {timelineData?.metrics?.length || 0}</p>
    </div>
  );
})()}

              {/* Timeline Stats */}
              {timelineData && timelineData.metrics && (
                <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
                  {timelineData.metrics.map((metric) => {
                    const option = timelineMetricOptions.find(opt => opt.value === metric.metric);
                    const totalValue = metric.totalValue || 0;
                    const avgValue = metric.timeSeriesData.length > 0 
                      ? Math.round(totalValue / metric.timeSeriesData.length) 
                      : 0;
                    const maxValue = Math.max(...metric.timeSeriesData.map(d => d.value));
                    
                    return (
                      <div key={metric.metric} className="bg-gray-50 rounded-lg p-4">
                        <div className="flex items-center justify-between mb-2">
                          <h4 className="text-sm font-medium text-gray-900">{option?.label || metric.metric}</h4>
                          <div 
                            className="w-3 h-3 rounded"
                            style={{ backgroundColor: option?.color || '#3B82F6' }}
                          ></div>
                        </div>
                        <div className="space-y-1">
                          <div className="flex justify-between text-xs text-gray-600">
                            <span>Total:</span>
                            <span className="font-medium">{totalValue.toLocaleString()}</span>
                          </div>
                          <div className="flex justify-between text-xs text-gray-600">
                            <span>Daily Avg:</span>
                            <span className="font-medium">{avgValue.toLocaleString()}</span>
                          </div>
                          <div className="flex justify-between text-xs text-gray-600">
                            <span>Peak Day:</span>
                            <span className="font-medium">{maxValue.toLocaleString()}</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
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