import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';
import {
  Building2,
  MapPin,
  Phone,
  Globe,
  CheckCircle,
  AlertCircle,
  RefreshCw,
  Plus,
  Image
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

// Location Profile Image Component
const LocationProfileImage = ({ profilePicture, locationName }) => {
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
        console.error('Error fetching location profile image:', err);
        setError(true);
      } finally {
        setLoading(false);
      }
    };

    fetchImage();
  }, [profilePicture]);

  if (loading) {
    return (
      <div className="h-8 w-8 bg-gray-100 rounded-full flex items-center justify-center">
        <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  if (error || !imageSrc) {
    return (
      <div className="h-8 w-8 bg-gray-100 rounded-full flex items-center justify-center">
        <Image className="h-4 w-4 text-gray-400" />
      </div>
    );
  }

  return (
    <img 
      src={imageSrc}
      alt={`${locationName || 'Location'} logo`}
      className="h-8 w-8 rounded-full object-cover border border-gray-200"
    />
  );
};

const BusinessProfiles = () => {
  const { isAuthenticated } = useAuth();
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [mediaLoading, setMediaLoading] = useState({});

  useEffect(() => {
    if (isAuthenticated) {
      fetchProfiles();
    }
  }, [isAuthenticated]);

  const fetchProfiles = async () => {
    try {
      setLoading(true);
      const response = await axios.get('http://localhost:3001/api/gmb/accounts');
      
      if (response.data.accounts) {
        // Fetch locations for each account
        const profilesWithLocations = await Promise.all(
          response.data.accounts.map(async (account) => {
            try {
              // Extract account ID from the full name (e.g., "accounts/123456789" -> "123456789")
              const accountId = account.name.split('/').pop();
              const locationsResponse = await axios.get(
                `http://localhost:3001/api/gmb/accounts/${accountId}/locations`
              );
              
              // Fetch account-level media (for account icon)
              let accountProfilePicture = null;
              try {
                // Try to get account media from the first location's media endpoint
                if (locationsResponse.data.locations && locationsResponse.data.locations.length > 0) {
                  const firstLocationId = locationsResponse.data.locations[0].name.split('/').pop();
                  const accountMediaResponse = await axios.get(
                    `http://localhost:3001/api/gmb/accounts/${accountId}/locations/${firstLocationId}/media`
                  );
                  
                  if (accountMediaResponse.data.success) {
                    if (accountMediaResponse.data.logos && accountMediaResponse.data.logos.length > 0) {
                      accountProfilePicture = accountMediaResponse.data.logos[0];
                    } else if (accountMediaResponse.data.profilePicture) {
                      accountProfilePicture = accountMediaResponse.data.profilePicture;
                    }
                  }
                }
              } catch (accountMediaError) {
                console.error(`Error fetching account media for ${account.name}:`, accountMediaError);
              }
              
              // Fetch profile pictures for each location
              const locationsWithMedia = await Promise.all(
                (locationsResponse.data.locations || []).map(async (location) => {
                  try {
                    setMediaLoading(prev => ({ ...prev, [location.name]: true }));
                    const locationId = location.name.split('/').pop();
                    const mediaResponse = await axios.get(
                      `http://localhost:3001/api/gmb/accounts/${accountId}/locations/${locationId}/media`
                    );
                    
                    // Get the first profile picture/logo
                    let profilePicture = null;
                    if (mediaResponse.data.success && mediaResponse.data.logos && mediaResponse.data.logos.length > 0) {
                      profilePicture = mediaResponse.data.logos[0];
                    } else if (mediaResponse.data.success && mediaResponse.data.profilePicture) {
                      // Fallback to profilePicture if available
                      profilePicture = mediaResponse.data.profilePicture;
                    }
                    
                    setMediaLoading(prev => ({ ...prev, [location.name]: false }));
                    return {
                      ...location,
                      profilePicture
                    };
                  } catch (mediaError) {
                    console.error(`Error fetching media for location ${location.name}:`, mediaError);
                    setMediaLoading(prev => ({ ...prev, [location.name]: false }));
                    return {
                      ...location,
                      profilePicture: null
                    };
                  }
                })
              );
              
              return {
                ...account,
                accountProfilePicture,
                locations: locationsWithMedia
              };
            } catch (error) {
              console.error(`Error fetching locations for ${account.name}:`, error);
              return {
                ...account,
                accountProfilePicture: null,
                locations: []
              };
            }
          })
        );
        
        setProfiles(profilesWithLocations);
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

  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <p className="text-gray-500">Please log in to view business profiles</p>
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

      {/* Profiles List */}
      <div className="space-y-6">
        {profiles.length > 0 ? (
          profiles.map((profile) => (
            <div key={profile.name} className="bg-white shadow rounded-lg">
              {/* Account Header */}
              <div className="px-6 py-4 border-b border-gray-200">
                <div className="flex items-center justify-between">
                  <div className="flex items-center">
                    <div className="flex-shrink-0">
                      {/* Account Profile Picture - Use account-level media */}
                      <AccountProfileImage 
                        profilePicture={profile.accountProfilePicture}
                        accountName={profile.accountName}
                      />
                    </div>
                    <div className="ml-4">
                      <h3 className="text-lg font-medium text-gray-900">
                        {profile.accountName}
                      </h3>
                      <p className="text-sm text-gray-500">
                        Account ID: {profile.name.split('/').pop()}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center space-x-2">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(profile.state)}`}>
                      {profile.state}
                    </span>
                  </div>
                </div>
              </div>

              {/* Locations */}
              <div className="divide-y divide-gray-200">
                {profile.locations && profile.locations.length > 0 ? (
                  profile.locations.map((location) => (
                    <div key={location.name} className="px-6 py-4">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center space-x-3">
                            {/* Location Profile Picture */}
                            <div className="flex-shrink-0">
                              {mediaLoading[location.name] ? (
                                <div className="h-8 w-8 bg-gray-100 rounded-full flex items-center justify-center">
                                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary-600"></div>
                                </div>
                              ) : (
                                <LocationProfileImage 
                                  profilePicture={location.profilePicture}
                                  locationName={location.title}
                                />
                              )}
                            </div>
                            
                            <div className="flex items-center space-x-2">
                              <h4 className="text-md font-medium text-gray-900">
                                {location.title || 'Untitled Location'}
                              </h4>
                              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getVerificationStatusColor(location.locationState?.verificationStatus)}`}>
                                {location.locationState?.verificationStatus || 'UNKNOWN'}
                              </span>
                            </div>
                          </div>
                          
                          {location.storefrontAddress && (
                            <div className="mt-2 flex items-center text-sm text-gray-500">
                              <MapPin className="h-4 w-4 mr-1" />
                              {location.storefrontAddress.addressLines?.join(', ')}
                            </div>
                          )}
                          
                          {location.phoneNumbers && location.phoneNumbers.length > 0 && (
                            <div className="mt-1 flex items-center text-sm text-gray-500">
                              <Phone className="h-4 w-4 mr-1" />
                              {location.phoneNumbers[0].primaryPhone}
                            </div>
                          )}
                          
                          {location.websiteUri && (
                            <div className="mt-1 flex items-center text-sm text-gray-500">
                              <Globe className="h-4 w-4 mr-1" />
                              <a 
                                href={location.websiteUri} 
                                target="_blank" 
                                rel="noopener noreferrer"
                                className="text-primary-600 hover:text-primary-500"
                              >
                                {location.websiteUri}
                              </a>
                            </div>
                          )}
                          
                          {location.categories && location.categories.length > 0 && (
                            <div className="mt-2">
                              <span className="text-xs text-gray-500">Category: </span>
                              <span className="text-xs font-medium text-gray-700">
                                {location.categories[0].displayName}
                              </span>
                            </div>
                          )}
                        </div>
                        
                        <div className="ml-4 flex-shrink-0">
                          <div className="flex items-center space-x-2">
                            {location.locationState?.status === 'VERIFIED' && (
                              <CheckCircle className="h-5 w-5 text-green-500" />
                            )}
                            {location.locationState?.status === 'UNVERIFIED' && (
                              <AlertCircle className="h-5 w-5 text-yellow-500" />
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="px-6 py-8 text-center">
                    <Building2 className="mx-auto h-12 w-12 text-gray-400" />
                    <h3 className="mt-2 text-sm font-medium text-gray-900">No locations found</h3>
                    <p className="mt-1 text-sm text-gray-500">
                      This account doesn't have any locations yet.
                    </p>
                  </div>
                )}
              </div>
            </div>
          ))
        ) : (
          <div className="bg-white shadow rounded-lg px-6 py-8 text-center">
            <Building2 className="mx-auto h-12 w-12 text-gray-400" />
            <h3 className="mt-2 text-sm font-medium text-gray-900">No business profiles found</h3>
            <p className="mt-1 text-sm text-gray-500">
              Connect your Google My Business account to get started.
            </p>
            <div className="mt-6">
              <button
                onClick={refreshProfiles}
                className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700"
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
    </div>
  );
};

export default BusinessProfiles;
