import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import {
  Building2,
  CheckCircle,
  AlertCircle,
  RefreshCw,
  Star,
  X,
  MapPin,
  Phone,
  Globe,
  Clock,
  Mail,
  ExternalLink,
  Eye,
  Tag,
  Navigation,
  LogOut
} from 'lucide-react';

// Account Profile Image Component
const AccountProfileImage = ({ profilePicture, accountName }) => {
  const [imageSrc, setImageSrc] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    const fetchImage = async () => {
      if (!profilePicture) return;
      
      try {
        setLoading(true);
        setError(false);
        
        const response = await axios.get(`http://localhost:3001/api/gmb/proxy-image?url=${encodeURIComponent(profilePicture.googleUrl)}`);
        
        if (response.data.success && response.data.dataUrl) {
          setImageSrc(response.data.dataUrl);
        } else {
          setError(true);
        }
      } catch (err) {
        console.error('Error fetching account profile image:', err);
        setError(true);
      } finally {
        setLoading(false);
      }
    };

    fetchImage();
  }, [profilePicture]);

  if (loading) {
    return (
      <div className="h-10 w-10 bg-gray-100 rounded-full flex items-center justify-center">
        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  if (error || !imageSrc) {
    return (
      <div className="h-10 w-10 bg-primary-100 rounded-full flex items-center justify-center">
        <Building2 className="h-6 w-6 text-primary-600" />
      </div>
    );
  }

  return (
    <img 
      src={imageSrc}
      alt={`${accountName} logo`}
      className="h-10 w-10 rounded-full object-cover border-2 border-gray-200"
    />
  );
};

// Business Profile Popup Component
const BusinessProfilePopup = ({ isOpen, onClose, profile, accountId }) => {
  const [detailedData, setDetailedData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (isOpen && accountId) {
      fetchDetailedProfileData();
    }
  }, [isOpen, accountId]);

  const fetchDetailedProfileData = async () => {
    try {
      setLoading(true);
      setError(null);
      
      // Get the first location for detailed data
      const locationsResponse = await axios.get(
        `http://localhost:3001/api/gmb/accounts/${accountId}/locations`
      );
      
      if (locationsResponse.data.success && locationsResponse.data.locations.length > 0) {
        const location = locationsResponse.data.locations[0];
        setDetailedData(location);
      }
    } catch (err) {
      console.error('Error fetching detailed profile data:', err);
      setError('Failed to load detailed profile data');
    } finally {
      setLoading(false);
    }
  };

  const formatAddress = (address) => {
    if (!address || typeof address !== 'object') return 'Not available';
    
    const parts = [];
    if (address.addressLines && Array.isArray(address.addressLines)) {
      parts.push(...address.addressLines);
    }
    if (address.locality) parts.push(address.locality);
    if (address.administrativeArea) parts.push(address.administrativeArea);
    if (address.postalCode) parts.push(address.postalCode);
    if (address.regionCode) parts.push(address.regionCode);
    
    return parts.join(', ') || 'Not available';
  };

  const formatPhoneNumbers = (phoneNumbers) => {
    if (!phoneNumbers) return 'Not available';
    
    // Handle the actual phone structure: { primaryPhone: "...", additionalPhones: [...] }
    if (typeof phoneNumbers === 'object' && phoneNumbers.primaryPhone) {
      const phones = [phoneNumbers.primaryPhone];
      if (phoneNumbers.additionalPhones && Array.isArray(phoneNumbers.additionalPhones)) {
        phones.push(...phoneNumbers.additionalPhones);
      }
      return phones.join(', ');
    }
    
    // Handle array format (fallback)
    if (Array.isArray(phoneNumbers)) {
      if (phoneNumbers.length === 0) return 'Not available';
      return phoneNumbers.map(phone => phone.number || phone).join(', ');
    }
    
    // Handle single phone number object
    if (typeof phoneNumbers === 'object') {
      return phoneNumbers.number || phoneNumbers.toString();
    }
    
    // Handle string or other types
    return phoneNumbers.toString();
  };

  const formatHours = (regularHours) => {
    if (!regularHours) return 'Not available';
    
    // Handle weekdayDescriptions format
    if (regularHours.weekdayDescriptions && Array.isArray(regularHours.weekdayDescriptions)) {
      return regularHours.weekdayDescriptions.join('\n');
    }
    
    // Handle periods format (like the 24-hour example)
    if (regularHours.periods && Array.isArray(regularHours.periods)) {
      return regularHours.periods.map(period => {
        const openDay = period.openDay || 'Unknown';
        const closeDay = period.closeDay || 'Unknown';
        const openTime = period.openTime?.hours || 'Unknown';
        const closeTime = period.closeTime?.hours || 'Unknown';
        
        // Handle 24-hour format
        if (openTime === 24 || closeTime === 24) {
          return `${openDay}: 24 Hours`;
        }
        
        // Handle regular hours
        if (openTime !== 'Unknown' && closeTime !== 'Unknown') {
          return `${openDay}: ${openTime}:00 - ${closeTime}:00`;
        }
        
        return `${openDay}: ${openTime} - ${closeTime}`;
      }).join('\n');
    }
    
    return 'Not available';
  };

  const formatCoordinates = (latlng) => {
    if (!latlng || typeof latlng !== 'object') return 'Not available';
    if (latlng.latitude !== undefined && latlng.longitude !== undefined) {
      return `${latlng.latitude}, ${latlng.longitude}`;
    }
    return 'Not available';
  };

  const formatOpenStatus = (openInfo) => {
    if (!openInfo) return 'Not available';
    
    const status = openInfo.status || 'Unknown';
    const canReopen = openInfo.canReopen || false;
    
    let statusText = status;
    if (canReopen) {
      statusText += ' (Can Reopen)';
    }
    
    return statusText;
  };

  const formatServiceArea = (serviceArea, detailedData = null) => {
    if (!serviceArea) return 'Not available';
    
    // Handle ServiceAreaBusiness object structure
    if (typeof serviceArea === 'object') {
      const areas = [];
      
      // Check for places with placeInfos (the actual location data)
      if (serviceArea.places && serviceArea.places.placeInfos && Array.isArray(serviceArea.places.placeInfos)) {
        const placeNames = serviceArea.places.placeInfos.map(place => place.placeName).filter(Boolean);
        if (placeNames.length > 0) {
          areas.push(`Areas served: ${placeNames.join(', ')}`);
        }
      }
      
      // Check for postal codes
      if (serviceArea.postalCodes && Array.isArray(serviceArea.postalCodes)) {
        areas.push(`Postal Codes: ${serviceArea.postalCodes.join(', ')}`);
      }
      
      // Check for regions/cities
      if (serviceArea.regions && Array.isArray(serviceArea.regions)) {
        areas.push(`Regions: ${serviceArea.regions.join(', ')}`);
      }
      
      // Check for cities
      if (serviceArea.cities && Array.isArray(serviceArea.cities)) {
        areas.push(`Cities: ${serviceArea.cities.join(', ')}`);
      }
      
      // Check for free-form text description
      if (serviceArea.description) {
        areas.push(`Description: ${serviceArea.description}`);
      }
      
      // Check for service area name
      if (serviceArea.name) {
        areas.push(`Service Area: ${serviceArea.name}`);
      }
      
      // Check for areas array (fallback)
      if (serviceArea.areas && Array.isArray(serviceArea.areas)) {
        areas.push(`Areas: ${serviceArea.areas.join(', ')}`);
      }
      
      // Check for single area string
      if (serviceArea.area && typeof serviceArea.area === 'string') {
        areas.push(serviceArea.area);
      }
      
      // Check for business type (service area business indicator) - but don't show it as it's not useful
      // if (serviceArea.businessType) {
      //   areas.push(`Business Type: ${serviceArea.businessType}`);
      // }
      
      if (areas.length > 0) {
        return (
          <div className="space-y-1">
            {areas.map((area, index) => (
              <div key={index} className="text-sm">
                {area}
              </div>
            ))}
          </div>
        );
      }
      
      // If no specific area data but we have businessType, show a generic message
      if (serviceArea.businessType === 'CUSTOMER_LOCATION_ONLY' && areas.length === 0) {
        return 'Service area business - serves customer locations';
      }
    }
    
    // Handle string format (fallback)
    if (typeof serviceArea === 'string') {
      return `Areas served: ${serviceArea}`;
    }
    
    return 'Service area not specified';
  };

  const formatCategories = (categories) => {
    if (!categories) return 'Not available';
    
    if (typeof categories === 'object') {
      const categoryInfo = [];
      
      // Primary category
      if (categories.primaryCategory) {
        const primary = categories.primaryCategory;
        categoryInfo.push({
          type: 'Primary',
          name: primary.displayName || primary.name || 'Unknown',
          id: primary.categoryId || primary.id || ''
        });
      }
      
      // Additional categories
      if (categories.additionalCategories && Array.isArray(categories.additionalCategories)) {
        categories.additionalCategories.forEach(category => {
          categoryInfo.push({
            type: 'Additional',
            name: category.displayName || category.name || 'Unknown',
            id: category.categoryId || category.id || ''
          });
        });
      }
      
      if (categoryInfo.length > 0) {
        return (
          <div className="space-y-2">
            {categoryInfo.map((category, index) => (
              <div key={index} className="flex items-center space-x-2">
                <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                  category.type === 'Primary' 
                    ? 'bg-blue-100 text-blue-800' 
                    : 'bg-gray-100 text-gray-800'
                }`}>
                  {category.type}
                </span>
                <span className="text-sm font-medium">{category.name}</span>
                {category.id && (
                  <span className="text-xs text-gray-500 font-mono">{category.id}</span>
                )}
              </div>
            ))}
          </div>
        );
      }
    }
    
    return 'No categories available';
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <div className="flex items-center space-x-3">
            <AccountProfileImage 
              profilePicture={profile?.accountProfilePicture}
              accountName={profile?.businessName}
            />
            <div>
              <h2 className="text-xl font-semibold text-gray-900">
                {profile?.businessName || 'Business Profile'}
              </h2>
              <p className="text-sm text-gray-500">Detailed Information</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 rounded-full transition-colors"
          >
            <X className="h-5 w-5 text-gray-500" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto max-h-[calc(90vh-120px)]">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
              <span className="ml-3 text-gray-600">Loading detailed data...</span>
            </div>
          ) : error ? (
            <div className="text-center py-8">
              <AlertCircle className="h-12 w-12 text-red-400 mx-auto mb-4" />
              <p className="text-red-600">{error}</p>
              <button
                onClick={fetchDetailedProfileData}
                className="mt-4 px-4 py-2 bg-primary-600 text-white rounded-md hover:bg-primary-700"
              >
                Retry
              </button>
            </div>
          ) : detailedData ? (
            <div className="space-y-6">
              {/* Basic Information */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-4">
                  <h3 className="text-lg font-semibold text-gray-900 flex items-center">
                    <Building2 className="h-5 w-5 mr-2 text-primary-600" />
                    Basic Information
                  </h3>
                  
                  <div className="space-y-3">
                    <div>
                      <label className="text-sm font-medium text-gray-500">Business Name</label>
                      <p className="text-gray-900">{detailedData.locationName || detailedData.title || 'Not available'}</p>
                    </div>
                    
                    <div>
                      <label className="text-sm font-medium text-gray-500">Store Code</label>
                      <p className="text-gray-900">{detailedData.storeCode || 'Not available'}</p>
                    </div>
                    
                    <div>
                      <label className="text-sm font-medium text-gray-500">Business Categories</label>
                      <div className="text-gray-900">
                        {formatCategories(detailedData.categories)}
                      </div>
                    </div>
                    
                    <div>
                      <label className="text-sm font-medium text-gray-500">Business Labels</label>
                      <p className="text-gray-900">
                        {detailedData.labels && Array.isArray(detailedData.labels) 
                          ? detailedData.labels.join(', ') 
                          : 'Not available'
                        }
                      </p>
                    </div>
                    
                    <div>
                      <label className="text-sm font-medium text-gray-500">Location ID</label>
                      <p className="text-gray-900 font-mono text-sm">{detailedData.name?.split('/').pop() || 'Not available'}</p>
                    </div>
                  </div>
                </div>

                <div className="space-y-4">
                  <h3 className="text-lg font-semibold text-gray-900 flex items-center">
                    <MapPin className="h-5 w-5 mr-2 text-primary-600" />
                    Location Details
                  </h3>
                  
                  <div className="space-y-3">
                    <div>
                      <label className="text-sm font-medium text-gray-500">Address</label>
                      <p className="text-gray-900">
                        {detailedData.address && typeof detailedData.address === 'object' 
                          ? formatAddress(detailedData.address) 
                          : detailedData.serviceArea 
                            ? 'Service-based business (no physical address)'
                            : 'Not available'
                        }
                      </p>
                    </div>
                    
                    {detailedData.serviceArea && (
                      <div>
                        <label className="text-sm font-medium text-gray-500">Service Area</label>
                        <div className="text-gray-900">
                          {formatServiceArea(detailedData.serviceArea, detailedData)}
                        </div>
                      </div>
                    )}
                    
                    <div>
                      <label className="text-sm font-medium text-gray-500">Coordinates</label>
                      <p className="text-gray-900 font-mono text-sm">{formatCoordinates(detailedData.latlng)}</p>
                    </div>
                    
                    <div>
                      <label className="text-sm font-medium text-gray-500">Phone Numbers</label>
                      <p className="text-gray-900">{formatPhoneNumbers(detailedData.phoneNumbers)}</p>
                    </div>
                    
                    <div>
                      <label className="text-sm font-medium text-gray-500">Website</label>
                      {detailedData.websiteUri ? (
                        <a 
                          href={detailedData.websiteUri} 
                          target="_blank" 
                          rel="noopener noreferrer"
                          className="text-primary-600 hover:text-primary-700 flex items-center"
                        >
                          {detailedData.websiteUri}
                          <ExternalLink className="h-4 w-4 ml-1" />
                        </a>
                      ) : (
                        <p className="text-gray-900">Not available</p>
                      )}
                    </div>
                    
                    <div>
                      <label className="text-sm font-medium text-gray-500">Open Status</label>
                      <div className="flex items-center space-x-2">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                          detailedData.openInfo?.status === 'OPEN' 
                            ? 'bg-green-100 text-green-800' 
                            : 'bg-red-100 text-red-800'
                        }`}>
                          {detailedData.openInfo?.status === 'OPEN' ? '🟢' : '🔴'} {formatOpenStatus(detailedData.openInfo)}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Business Hours */}
              {detailedData.regularHours && (
                <div className="space-y-4">
                  <h3 className="text-lg font-semibold text-gray-900 flex items-center">
                    <Clock className="h-5 w-5 mr-2 text-primary-600" />
                    Business Hours
                  </h3>
                  <div className="bg-gray-50 p-4 rounded-lg">
                    <pre className="text-sm text-gray-700 whitespace-pre-line">
                      {formatHours(detailedData.regularHours)}
                    </pre>
                  </div>
                </div>
              )}

              {/* Profile Information */}
              {detailedData.profile && (
                <div className="space-y-4">
                  <h3 className="text-lg font-semibold text-gray-900 flex items-center">
                    <Eye className="h-5 w-5 mr-2 text-primary-600" />
                    Profile Information
                  </h3>
                  <div className="bg-gray-50 p-4 rounded-lg space-y-3">
                    {detailedData.profile.profileImageUri && (
                      <div>
                        <label className="text-sm font-medium text-gray-500">Profile Image</label>
                        <div className="mt-2">
                          <img 
                            src={detailedData.profile.profileImageUri} 
                            alt="Profile" 
                            className="h-20 w-20 rounded-lg object-cover"
                          />
                        </div>
                      </div>
                    )}
                    
                    {detailedData.profile.description && (
                      <div>
                        <label className="text-sm font-medium text-gray-500">Description</label>
                        <p className="text-gray-900 mt-1">{detailedData.profile.description}</p>
                      </div>
                    )}
                  </div>
                </div>
              )}



              {/* Labels */}
              {detailedData.labels && Array.isArray(detailedData.labels) && detailedData.labels.length > 0 && (
                <div className="space-y-4">
                  <h3 className="text-lg font-semibold text-gray-900 flex items-center">
                    <Tag className="h-5 w-5 mr-2 text-primary-600" />
                    Labels
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {detailedData.labels.map((label, index) => (
                      <span 
                        key={index}
                        className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-primary-100 text-primary-800"
                      >
                        {label}
                      </span>
                    ))}
                  </div>
                </div>
              )}


              {/* Raw Data (for debugging) */}
              <details className="space-y-4">
                <summary className="text-lg font-semibold text-gray-900 cursor-pointer hover:text-primary-600">
                  Raw API Data (Click to expand)
                </summary>
                <div className="bg-gray-50 p-4 rounded-lg">
                  <pre className="text-xs text-gray-700 overflow-x-auto">
                    {JSON.stringify(detailedData, null, 2)}
                  </pre>
                </div>
              </details>
            </div>
          ) : (
            <div className="text-center py-8">
              <AlertCircle className="h-12 w-12 text-gray-400 mx-auto mb-4" />
              <p className="text-gray-600">No detailed data available</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end space-x-3 p-6 border-t border-gray-200">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};


const BusinessProfiles = () => {
  const { isAuthenticated, logout, loginForBusiness, softDisconnect, reconnect, isDisconnected: authDisconnected } = useAuth();
  const navigate = useNavigate();
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedProfile, setSelectedProfile] = useState(null);
  const [isPopupOpen, setIsPopupOpen] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');
  const [isDisconnected, setIsDisconnected] = useState(false);

  useEffect(() => {
    // Check for error parameters in URL
    const urlParams = new URLSearchParams(window.location.search);
    const error = urlParams.get('error');
    if (error) {
      if (error === 'user_not_authenticated') {
        setConnectError('Please sign in first before connecting business profiles.');
      } else if (error === 'missing_tokens') {
        setConnectError('Authentication failed. Please try again.');
      } else {
        setConnectError('An error occurred during business profile connection.');
      }
      // Clean up URL
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    if (authDisconnected) {
      // If user is disconnected globally, set the local state and don't fetch profiles
      setIsDisconnected(true);
      setProfiles([]);
      setLoading(false);
    } else if (isAuthenticated && !authDisconnected) {
      // Check if business profiles are connected
      const businessConnected = localStorage.getItem('gmb_business_connected') === 'true';
      
      if (businessConnected) {
        // Business profiles are connected, fetch them
        setIsDisconnected(false);
        fetchProfiles();
      } else {
        // User is authenticated but business profiles are not connected yet
        // Don't automatically fetch profiles - wait for user to connect
        setIsDisconnected(false);
        setLoading(false);
      }
    } else {
      // If not authenticated, stop loading
      setLoading(false);
    }
  }, [isAuthenticated, authDisconnected]);

  const fetchProfiles = async () => {
    try {
      setLoading(true);
      const response = await axios.get('http://localhost:3001/api/gmb/accounts');
      
      if (response.data.accounts) {
        // Fetch business data for each account (single card per business)
        const businessProfiles = await Promise.all(
          response.data.accounts.map(async (account) => {
            try {
              // Extract account ID from the full name (e.g., "accounts/123456789" -> "123456789")
              const accountId = account.name.split('/').pop();
              const locationsResponse = await axios.get(
                `http://localhost:3001/api/gmb/accounts/${accountId}/locations`
              );
              
              // Get the first location for business data
              const firstLocation = locationsResponse.data.locations?.[0];
              if (!firstLocation) {
                return {
                  ...account,
                  accountProfilePicture: null,
                  businessName: account.accountName,
                  totalReviews: 0,
                  averageRating: 0,
                  locationCount: 0
                };
              }
              
              const locationId = firstLocation.name.split('/').pop();
              
              // Extract the proper business name from location data
              let businessName = account.accountName; // fallback
              
              if (firstLocation.locationName) {
                businessName = firstLocation.locationName;
              } else if (firstLocation.title) {
                businessName = firstLocation.title;
              } else if (firstLocation.storefrontAddress?.addressLines?.[0]) {
                // Try to get business name from address if title is not available
                businessName = firstLocation.storefrontAddress.addressLines[0];
              }
              
              // Fetch account-level media (for business icon)
              let accountProfilePicture = null;
              try {
                const accountMediaResponse = await axios.get(
                  `http://localhost:3001/api/gmb/accounts/${accountId}/locations/${locationId}/media`
                );
                
                if (accountMediaResponse.data.success) {
                  if (accountMediaResponse.data.logos && accountMediaResponse.data.logos.length > 0) {
                    accountProfilePicture = accountMediaResponse.data.logos[0];
                  } else if (accountMediaResponse.data.profilePicture) {
                    accountProfilePicture = accountMediaResponse.data.profilePicture;
                  }
                }
              } catch (accountMediaError) {
                console.error(`Error fetching account media for ${account.name}:`, accountMediaError);
              }
              
              // Fetch review statistics
              const reviewStats = await fetchReviewStats(accountId, locationId);
              
              return {
                ...account,
                accountProfilePicture,
                businessName,
                totalReviews: reviewStats.totalReviews,
                averageRating: reviewStats.averageRating,
                locationCount: locationsResponse.data.locations?.length || 0
              };
            } catch (error) {
              console.error(`Error fetching business data for ${account.name}:`, error);
              return {
                ...account,
                accountProfilePicture: null,
                businessName: account.accountName,
                totalReviews: 0,
                averageRating: 0,
                locationCount: 0
              };
            }
          })
        );
        
        setProfiles(businessProfiles);
      }
    } catch (error) {
      console.error('Error fetching profiles:', error);
    } finally {
      setLoading(false);
    }
  };

  const refreshProfiles = async () => {
    setRefreshing(true);
    await fetchProfiles();
    setRefreshing(false);
  };

  const handleDisconnect = () => {
    // Use soft disconnect to clear tokens without affecting authentication state
    softDisconnect();
    
    // Clear business connection status
    localStorage.removeItem('gmb_business_connected');
    
    // Set local disconnected state
    setIsDisconnected(true);
    setProfiles([]);
  };

  const handleConnect = async () => {
    try {
      // Check if user is authenticated first
      if (!isAuthenticated) {
        setConnectError('Please sign in first before connecting business profiles.');
        return;
      }

      setIsConnecting(true);
      setConnectError('');
      setIsDisconnected(false);
      
      // Reset the disconnect state in AuthContext
      reconnect();
      
      // Redirect to Google OAuth specifically for business profile access
      await loginForBusiness();
    } catch (error) {
      setConnectError('Failed to connect to Google. Please try again.');
      setIsConnecting(false);
    }
  };

  // Function to handle successful business profile connection
  const handleBusinessConnectionSuccess = async () => {
    try {
      setLoading(true);
      await fetchProfiles();
    } catch (error) {
      console.error('Error fetching profiles after connection:', error);
    }
  };

  const fetchReviewStats = async (accountId, locationId) => {
    try {
      const response = await axios.get(`http://localhost:3001/api/gmb/accounts/${accountId}/locations/${locationId}/reviews`);
      
      if (response.data.success && response.data.reviews) {
        const reviews = response.data.reviews;
        const totalReviews = reviews.length;
        
        // Calculate average rating
        let totalRating = 0;
        let validRatings = 0;
        
        reviews.forEach(review => {
          let rating = 0;
          if (typeof review.starRating === 'string') {
            const ratingMap = {
              'ONE': 1, 'TWO': 2, 'THREE': 3, 'FOUR': 4, 'FIVE': 5
            };
            rating = ratingMap[review.starRating] || 0;
          } else {
            rating = Number(review.starRating || review.rating) || 0;
          }
          
          if (rating > 0 && rating <= 5) {
            totalRating += rating;
            validRatings++;
          }
        });
        
        const averageRating = validRatings > 0 ? (totalRating / validRatings).toFixed(1) : 0;
        
        return {
          totalReviews,
          averageRating: parseFloat(averageRating)
        };
      }
    } catch (error) {
      console.error('Error fetching review stats:', error);
    }
    
    return { totalReviews: 0, averageRating: 0 };
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'VERIFIED':
        return 'bg-green-100 text-green-800';
      case 'UNVERIFIED':
        return 'bg-yellow-100 text-yellow-800';
      case 'SUSPENDED':
        return 'bg-red-100 text-red-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const getVerificationStatusColor = (status) => {
    switch (status) {
      case 'VERIFIED':
        return 'bg-green-100 text-green-800';
      case 'PENDING':
        return 'bg-yellow-100 text-yellow-800';
      case 'UNVERIFIED':
        return 'bg-red-100 text-red-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const renderStars = (rating) => {
    const stars = [];
    const fullStars = Math.floor(rating);
    const hasHalfStar = rating % 1 !== 0;
    
    for (let i = 0; i < fullStars; i++) {
      stars.push(
        <Star key={i} className="h-4 w-4 text-yellow-400 fill-current" />
      );
    }
    
    if (hasHalfStar) {
      stars.push(
        <Star key="half" className="h-4 w-4 text-yellow-400 fill-current opacity-50" />
      );
    }
    
    const emptyStars = 5 - Math.ceil(rating);
    for (let i = 0; i < emptyStars; i++) {
      stars.push(
        <Star key={`empty-${i}`} className="h-4 w-4 text-gray-300" />
      );
    }
    
    return stars;
  };


  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <p className="text-gray-500">Please log in to view business profiles</p>
        </div>
      </div>
    );
  }

  if (loading && !authDisconnected) {
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
          <h1 className="text-2xl font-bold text-gray-900">Business Profiles</h1>
          <p className="mt-1 text-sm text-gray-500">
            Manage your Google My Business profiles and locations
          </p>
        </div>
        <button
          onClick={refreshProfiles}
          disabled={refreshing}
          className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Business Profiles List */}
      <div className="space-y-6">
        {profiles.length > 0 && !authDisconnected ? (
          profiles.map((profile) => (
            <div key={profile.name} className="bg-white shadow rounded-lg">
              <div className="px-6 py-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-center">
                    <div className="flex-shrink-0">
                      <AccountProfileImage 
                        profilePicture={profile.accountProfilePicture}
                        accountName={profile.businessName}
                      />
                    </div>
                    <div className="ml-4">
                      <h3 className="text-xl font-semibold text-gray-900">
                        {profile.businessName}
                      </h3>
                      <div className="flex items-center space-x-4 mt-2">
                        <div className="flex items-center space-x-1">
                          {renderStars(profile.averageRating)}
                          <span className="text-sm font-medium text-gray-700 ml-1">
                            {profile.averageRating > 0 ? profile.averageRating.toFixed(1) : 'No rating'}
                          </span>
                        </div>
                        <div className="text-sm text-gray-500">
                          {profile.totalReviews} review{profile.totalReviews !== 1 ? 's' : ''}
                        </div>
                        {profile.locationCount > 1 && (
                          <div className="text-sm text-gray-500">
                            {profile.locationCount} location{profile.locationCount !== 1 ? 's' : ''}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center space-x-2">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(profile.state)}`}>
                      {profile.state}
                    </span>
                    <button
                      onClick={() => {
                        setSelectedProfile(profile);
                        setIsPopupOpen(true);
                      }}
                      className="inline-flex items-center px-3 py-1.5 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
                    >
                      <Eye className="h-4 w-4 mr-1" />
                      View Details
                    </button>
                    <button
                      onClick={handleDisconnect}
                      className="inline-flex items-center px-3 py-1.5 border border-red-300 shadow-sm text-sm font-medium rounded-md text-red-700 bg-white hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
                    >
                      <LogOut className="h-4 w-4 mr-1" />
                      Disconnect
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))
        ) : (
          <div className="bg-white shadow rounded-lg px-6 py-8 text-center">
            <Building2 className="mx-auto h-12 w-12 text-gray-400" />
            <h3 className="mt-2 text-sm font-medium text-gray-900">
              {authDisconnected ? 'Disconnected from Google My Business' : 'No business profiles found'}
            </h3>
            <p className="mt-1 text-sm text-gray-500">
              {authDisconnected 
                ? 'You have been disconnected. Connect your Google My Business account to manage your profiles.'
                : 'Connect your Google My Business account to get started.'
              }
            </p>
            
            {connectError && (
              <div className="mt-4 bg-red-50 border border-red-200 rounded-md p-4">
                <div className="flex">
                  <div className="flex-shrink-0">
                    <svg className="h-5 w-5 text-red-400" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                    </svg>
                  </div>
                  <div className="ml-3">
                    <p className="text-sm text-red-800">{connectError}</p>
                  </div>
                </div>
              </div>
            )}
            
            <div className="mt-6 space-y-3">
              <button
                onClick={handleConnect}
                disabled={isConnecting}
                className="group relative w-full flex justify-center py-3 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-200"
              >
                {isConnecting ? (
                  <div className="flex items-center">
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white mr-3"></div>
                    {authDisconnected ? 'Reconnecting to Google...' : 'Connecting to Google...'}
                  </div>
                ) : (
                  <div className="flex items-center">
                    <svg className="w-5 h-5 mr-3" viewBox="0 0 24 24">
                      <path
                        fill="currentColor"
                        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                      />
                      <path
                        fill="currentColor"
                        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                      />
                      <path
                        fill="currentColor"
                        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                      />
                      <path
                        fill="currentColor"
                        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                      />
                    </svg>
                    {authDisconnected ? 'Reconnect with Google' : 'Connect Profile with Google'}
                  </div>
                )}
              </button>
              
              <button
                onClick={refreshProfiles}
                className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Refresh Profiles
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Help Section */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-6">
        <div className="flex">
          <div className="flex-shrink-0">
            <svg className="h-5 w-5 text-blue-400" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
            </svg>
          </div>
          <div className="ml-3">
            <h3 className="text-sm font-medium text-blue-800">Need help?</h3>
            <div className="mt-2 text-sm text-blue-700">
              <p>
                Make sure your Google My Business account is properly set up and verified. 
                If you're having trouble seeing your profiles, try refreshing the data or 
                check your Google account permissions.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Business Profile Popup */}
      <BusinessProfilePopup
        isOpen={isPopupOpen}
        onClose={() => {
          setIsPopupOpen(false);
          setSelectedProfile(null);
        }}
        profile={selectedProfile}
        accountId={selectedProfile?.name?.split('/').pop()}
      />
    </div>
  );
};

export default BusinessProfiles;
