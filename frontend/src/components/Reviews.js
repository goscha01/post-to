import React, { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';
import imageService from '../services/imageService';
import businessProfileService from '../services/businessProfileService';
import {
  MessageSquare,
  Star,
  Reply,
  Edit,
  Trash2,
  Clock,
  User,
  CheckCircle
} from 'lucide-react';

// Profile Image Component
const ProfileImage = ({ profilePhotoUrl, displayName }) => {
  const [imageSrc, setImageSrc] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    const fetchImage = async () => {
      if (!profilePhotoUrl) {
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        setError(false);
        
        const result = await imageService.getImage(profilePhotoUrl);
        
        if (result.success) {
          setImageSrc(result.dataUrl);
        } else {
          setError(true);
        }
      } catch (err) {
        console.error('Error fetching profile image:', err);
        setError(true);
      } finally {
        setLoading(false);
      }
    };

    fetchImage();
  }, [profilePhotoUrl]);

  if (loading) {
    return (
      <div className="h-10 w-10 bg-gray-200 rounded-full flex items-center justify-center animate-pulse">
        <div className="h-4 w-4 bg-gray-400 rounded"></div>
      </div>
    );
  }

  if (error || !imageSrc) {
    return (
      <div className="h-10 w-10 bg-primary-100 rounded-full flex items-center justify-center">
        <User className="h-6 w-6 text-primary-600" />
      </div>
    );
  }

  return (
    <img 
      src={imageSrc}
      alt={`${displayName || 'Reviewer'}'s profile`}
      className="h-10 w-10 rounded-full object-cover"
    />
  );
};

const Reviews = () => {
  const { isAuthenticated, isDisconnected } = useAuth();
  const [reviews, setReviews] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedProfile, setSelectedProfile] = useState('');
  const [replyText, setReplyText] = useState('');
  const [replyingTo, setReplyingTo] = useState(null);

  useEffect(() => {
    if (isAuthenticated && !isDisconnected) {
      // Check if business profiles are connected
      const businessConnected = localStorage.getItem('gmb_business_connected') === 'true';
      if (businessConnected) {
        fetchData();
      } else {
        // User is authenticated but business profiles not connected
        setReviews([]);
        setProfiles([]);
        setLoading(false);
      }
    } else if (isDisconnected) {
      // Clear data when disconnected
      setReviews([]);
      setProfiles([]);
      setLoading(false);
    }
  }, [isAuthenticated, isDisconnected]);

  // Fetch reviews when selectedProfile changes
  useEffect(() => {
    if (selectedProfile && !isDisconnected) {
      fetchReviews(selectedProfile);
    }
  }, [selectedProfile, isDisconnected]);

  const fetchData = async () => {
    try {
      setLoading(true);
      // Use centralized business profile service with caching
      const profilesWithLocations = await businessProfileService.getAccounts();
      setProfiles(profilesWithLocations);
      console.log('Profiles with locations loaded:', profilesWithLocations);
      
      if (profilesWithLocations.length > 0 && profilesWithLocations[0].locations.length > 0) {
        const firstLocation = profilesWithLocations[0].locations[0].name;
        console.log('Setting selected profile to:', firstLocation);
        setSelectedProfile(firstLocation);
      } else {
        console.log('No profiles or locations found');
      }
    } catch (error) {
      console.error('Error fetching data:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchReviews = async (locationName) => {
    if (!locationName) return;
    
    console.log('Fetching reviews for location:', locationName);
    
    try {
      // Extract account and location IDs from the location name
      // Format: locations/2141374650782668963 (we need to get the account ID from the profile)
      let accountId = null;
      let locationId = null;
      
      if (locationName.startsWith('locations/')) {
        // We have just the location ID, need to find the account ID from profiles
        locationId = locationName.replace('locations/', '');
        
        // Find the profile that contains this location
        const profile = profiles.find(p => 
          p.locations && p.locations.some(loc => loc.name === locationName)
        );
        
        if (profile) {
          accountId = profile.name.split('/').pop(); // Extract account ID from profile name
          console.log('Found profile for location:', profile.accountName, 'Account ID:', accountId);
        }
      } else if (locationName.includes('/locations/')) {
        // Format: accounts/accountId/locations/locationId
        const parts = locationName.split('/');
        accountId = parts[1];
        locationId = parts[3];
      }
      
      if (!accountId || !locationId) {
        console.error('Could not extract account or location ID from:', locationName);
        setReviews([]);
        return;
      }
      
      console.log('Extracted IDs - Account:', accountId, 'Location:', locationId);
      
      // Use centralized service for reviews with caching
      const response = await businessProfileService.getReviewsForLocation(accountId, locationId);
      console.log('Reviews API response:', response);
      
      if (response.success) {
        setReviews(response.reviews || []);
        console.log('Reviews set:', response.reviews || []);
        console.log('Total reviews received:', response.reviews?.length || 0);
        
        // Debug: Log the first review structure if available
        if (response.reviews && response.reviews.length > 0) {
          console.log('First review structure:', response.reviews[0]);
          console.log('First review has profilePhotoUrl:', !!response.reviews[0].reviewer?.profilePhotoUrl);
          if (response.reviews[0].reviewer?.profilePhotoUrl) {
            console.log('Profile photo URL:', response.reviews[0].reviewer.profilePhotoUrl);
          }
        }
      } else {
        setReviews([]);
        console.log('No reviews found or API error');
      }
    } catch (error) {
      console.error('Error fetching reviews:', error);
      setReviews([]);
    }
  };

  const handleReply = async (reviewId) => {
    if (!replyText.trim()) return;
    
    try {
      // Extract account and location IDs using the same logic as fetchReviews
      let accountId = null;
      let locationId = null;
      
      if (selectedProfile.startsWith('locations/')) {
        locationId = selectedProfile.replace('locations/', '');
        const profile = profiles.find(p => 
          p.locations && p.locations.some(loc => loc.name === selectedProfile)
        );
        if (profile) {
          accountId = profile.name.split('/').pop();
        }
      } else if (selectedProfile.includes('/locations/')) {
        const parts = selectedProfile.split('/');
        accountId = parts[1];
        locationId = parts[3];
      }
      
      if (!accountId || !locationId) {
        alert('Could not determine account or location ID');
        return;
      }
      
      await axios.put(`http://localhost:3001/api/gmb/accounts/${accountId}/locations/${locationId}/reviews/${reviewId}/reply`, {
        comment: replyText.trim()
      });
      
      // Refresh reviews
      await fetchReviews(selectedProfile);
      
      // Reset form
      setReplyText('');
      setReplyingTo(null);
      
      alert('Reply posted successfully!');
    } catch (error) {
      console.error('Error posting reply:', error);
      alert('Failed to post reply. Please try again.');
    }
  };

  const handleUpdateReply = async (reviewId) => {
    if (!replyText.trim()) return;
    
    try {
      // Extract account and location IDs using the same logic as fetchReviews
      let accountId = null;
      let locationId = null;
      
      if (selectedProfile.startsWith('locations/')) {
        locationId = selectedProfile.replace('locations/', '');
        const profile = profiles.find(p => 
          p.locations && p.locations.some(loc => loc.name === selectedProfile)
        );
        if (profile) {
          accountId = profile.name.split('/').pop();
        }
      } else if (selectedProfile.includes('/locations/')) {
        const parts = selectedProfile.split('/');
        accountId = parts[1];
        locationId = parts[3];
      }
      
      if (!accountId || !locationId) {
        alert('Could not determine account or location ID');
        return;
      }
      
      await axios.put(`http://localhost:3001/api/gmb/accounts/${accountId}/locations/${locationId}/reviews/${reviewId}/reply`, {
        comment: replyText.trim()
      });
      
      await fetchReviews(selectedProfile);
      setReplyText('');
      setReplyingTo(null);
      
      alert('Reply updated successfully!');
    } catch (error) {
      console.error('Error updating reply:', error);
      alert('Failed to update reply. Please try again.');
    }
  };

  const handleDeleteReply = async (reviewId) => {
    if (!window.confirm('Are you sure you want to delete this reply?')) return;
    
    try {
      // Extract account and location IDs using the same logic as fetchReviews
      let accountId = null;
      let locationId = null;
      
      if (selectedProfile.startsWith('locations/')) {
        locationId = selectedProfile.replace('locations/', '');
        const profile = profiles.find(p => 
          p.locations && p.locations.some(loc => loc.name === selectedProfile)
        );
        if (profile) {
          accountId = profile.name.split('/').pop();
        }
      } else if (selectedProfile.includes('/locations/')) {
        const parts = selectedProfile.split('/');
        accountId = parts[1];
        locationId = parts[3];
      }
      
      if (!accountId || !locationId) {
        alert('Could not determine account or location ID');
        return;
      }
      
      await axios.delete(`http://localhost:3001/api/gmb/accounts/${accountId}/locations/${locationId}/reviews/${reviewId}/reply`);
      await fetchReviews(selectedProfile);
      alert('Reply deleted successfully!');
    } catch (editError) {
      console.error('Error deleting reply:', editError);
      alert('Failed to delete reply. Please try again.');
    }
  };

    // Helper function to format date as relative time with weeks, months, and years
  const formatRelativeTime = (dateString) => {
    const date = new Date(dateString);
    
    if (isNaN(date.getTime())) {
      return dateString;
    }
    
    const now = new Date();
    const diffInMs = now - date;
    const diffInSeconds = Math.floor(diffInMs / 1000);
    const diffInMinutes = Math.floor(diffInSeconds / 60);
    const diffInHours = Math.floor(diffInMinutes / 60);
    const diffInDays = Math.floor(diffInHours / 24);
    const diffInWeeks = Math.floor(diffInDays / 7);
    const diffInMonths = Math.floor(diffInDays / 30.44); // Average days per month
    const diffInYears = Math.floor(diffInDays / 365.25); // Average days per year

    if (diffInYears > 0) {
      const remainingMonths = Math.floor((diffInDays % 365.25) / 30.44);
      if (remainingMonths > 0) {
        return `${diffInYears} year${diffInYears === 1 ? '' : 's'} and ${remainingMonths} month${remainingMonths === 1 ? '' : 's'} ago`;
      } else {
        return `${diffInYears} year${diffInYears === 1 ? '' : 's'} ago`;
      }
    } else if (diffInMonths > 0) {
      const remainingWeeks = Math.floor((diffInDays % 30.44) / 7);
      if (remainingWeeks > 0) {
        return `${diffInMonths} month${diffInMonths === 1 ? '' : 's'} and ${remainingWeeks} week${remainingWeeks === 1 ? '' : 's'} ago`;
      } else {
        return `${diffInMonths} month${diffInMonths === 1 ? '' : 's'} ago`;
      }
    } else if (diffInWeeks > 0) {
      const remainingDays = diffInDays % 7;
      if (remainingDays > 0) {
        return `${diffInWeeks} week${diffInWeeks === 1 ? '' : 's'} and ${remainingDays} day${remainingDays === 1 ? '' : 's'} ago`;
      } else {
        return `${diffInWeeks} week${diffInWeeks === 1 ? '' : 's'} ago`;
      }
    } else if (diffInDays > 0) {
      return `${diffInDays} day${diffInDays === 1 ? '' : 's'} ago`;
    } else if (diffInHours > 0) {
      return `${diffInHours} hour${diffInHours === 1 ? '' : 's'} ago`;
    } else if (diffInMinutes > 0) {
      return `${diffInMinutes} minute${diffInMinutes === 1 ? '' : 's'} ago`;
    } else {
      return `${diffInSeconds} second${diffInSeconds === 1 ? '' : 's'} ago`;
    }
  };

  const renderStars = (rating) => {
    // Convert rating to number and handle edge cases
    let numRating = 0;
    
    if (typeof rating === 'string') {
      // Handle GMB API string ratings like 'FIVE', 'FOUR', etc.
      const ratingMap = {
        'ONE': 1,
        'TWO': 2,
        'THREE': 3,
        'FOUR': 4,
        'FIVE': 5
      };
      numRating = ratingMap[rating] || 0;
    } else {
      numRating = Number(rating);
    }
    
    if (isNaN(numRating) || numRating < 0 || numRating > 5) {
      return Array.from({ length: 5 }, (_, i) => (
        <Star
          key={i}
          className="h-4 w-4 text-gray-300"
        />
      ));
    }
    
    return Array.from({ length: 5 }, (_, i) => (
      <Star
        key={i}
        className={`h-4 w-4 ${
          i < numRating ? 'text-yellow-400 fill-current' : 'text-gray-300'
        }`}
      />
    ));
  };

  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <p className="text-gray-500">Please log in to view reviews</p>
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
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Reviews</h1>
        <p className="mt-1 text-sm text-gray-500">
          Monitor and respond to customer reviews for your business profiles
        </p>
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
            fetchReviews(e.target.value);
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

      {/* Reviews List */}
      {selectedProfile && (
        <div className="bg-white shadow rounded-lg">
          <div className="px-6 py-4 border-b border-gray-200">
            <h2 className="text-lg font-medium text-gray-900">Customer Reviews</h2>
          </div>
          <div className="divide-y divide-gray-200">
            {reviews.length > 0 ? (
              reviews.map((review) => (
                <div key={review.reviewId || review.name} className="px-6 py-4">
                  <div className="flex items-start space-x-4">
                    <div className="flex-shrink-0">
                      {review.reviewer?.profilePhotoUrl ? (
                        <ProfileImage 
                          profilePhotoUrl={review.reviewer.profilePhotoUrl}
                          displayName={review.reviewer.displayName}
                        />
                      ) : (
                        <div>
                          {console.log('No profile photo URL for:', review.reviewer?.displayName)}
                          {null}
                        </div>
                      )}
                      <div className={`fallback-icon h-10 w-10 bg-primary-100 rounded-full flex items-center justify-center ${review.reviewer?.profilePhotoUrl ? 'hidden' : ''}`}>
                        <User className="h-6 w-6 text-primary-600" />
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center space-x-2">
                        <h3 className="text-sm font-medium text-gray-900">
                          {review.reviewer?.displayName || 'Anonymous'}
                        </h3>
                        <div className="flex items-center space-x-1">
                          {renderStars(review.starRating || review.rating)}
                        </div>
                        <span className="text-sm text-gray-500">
                          {formatRelativeTime(review.createTime)}
                        </span>
                      </div>
                      
                      {/* Review Comment - Show message if no comment */}
                      {review.comment && review.comment.trim() ? (
                        <p className="mt-1 text-sm text-gray-700">{review.comment}</p>
                      ) : (
                        <p className="mt-1 text-sm text-gray-500 italic">
                          No written comment - rating only review
                        </p>
                      )}
                      

                      

                      
                      {/* Reply Section */}
                      {review.reviewReply ? (
                        <div className="mt-3 bg-green-50 border border-green-200 rounded-lg p-3">
                          <div className="flex items-center space-x-2 mb-2">
                            <CheckCircle className="h-4 w-4 text-green-600" />
                            <span className="text-sm font-medium text-green-800">Your Business Reply</span>
                            <span className="text-sm text-green-600">
                              {formatRelativeTime(review.reviewReply.updateTime)}
                            </span>
                          </div>
                          <p className="text-sm text-green-800 whitespace-pre-line">{review.reviewReply.comment}</p>
                          <div className="mt-2 flex space-x-2">
                            <button
                              onClick={() => {
                                setReplyingTo(review.reviewId || review.name);
                                setReplyText(review.reviewReply.comment);
                              }}
                              className="text-sm text-green-600 hover:text-green-500"
                            >
                              <Edit className="h-3 w-3 inline mr-1" />
                              Edit
                            </button>
                            <button
                              onClick={() => handleDeleteReply(review.reviewId || review.name)}
                              className="text-sm text-red-600 hover:text-red-500"
                            >
                              <Trash2 className="h-3 w-3 inline mr-1" />
                              Delete
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="mt-3">
                          <button
                            onClick={() => setReplyingTo(review.reviewId || review.name)}
                            className="inline-flex items-center px-3 py-1 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                          >
                            <Reply className="h-3 w-3 mr-1" />
                            Reply
                          </button>
                        </div>
                      )}
                      
                      {/* Reply Form */}
                      {replyingTo === (review.reviewId || review.name) && (
                        <div className="mt-3">
                          <textarea
                            value={replyText}
                            onChange={(e) => setReplyText(e.target.value)}
                            rows={3}
                            className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                            placeholder="Write your reply..."
                          />
                          <div className="mt-2 flex space-x-2">
                            <button
                              onClick={() => {
                                if (review.reviewReply) {
                                  handleUpdateReply(review.reviewId || review.name);
                                } else {
                                  handleReply(review.reviewId || review.name);
                                }
                              }}
                              className="inline-flex items-center px-3 py-1 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700"
                            >
                              {review.reviewReply ? 'Update Reply' : 'Post Reply'}
                            </button>
                            <button
                              onClick={() => {
                                setReplyingTo(null);
                                setReplyText('');
                              }}
                              className="inline-flex items-center px-3 py-1 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <div className="px-6 py-8 text-center">
                <MessageSquare className="mx-auto h-12 w-12 text-gray-400" />
                <h3 className="mt-2 text-sm font-medium text-gray-900">No reviews yet</h3>
                <p className="mt-1 text-sm text-gray-500">
                  Customer reviews will appear here once they start coming in.
                </p>
              </div>
            )}
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
            <h3 className="text-sm font-medium text-blue-800">Managing Reviews</h3>
            <div className="mt-2 text-sm text-blue-700">
              <p>
                Respond to customer reviews to show that you value their feedback. 
                Timely and helpful responses can improve your business reputation and 
                encourage more customers to leave reviews.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Reviews;
