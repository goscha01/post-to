import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';
import {
  Building2,
  CheckCircle,
  AlertCircle,
  RefreshCw,
  Star
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


const BusinessProfiles = () => {
  const { isAuthenticated } = useAuth();
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

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

      {/* Business Profiles List */}
      <div className="space-y-6">
        {profiles.length > 0 ? (
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
                  </div>
                </div>
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
