import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';
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

const Reviews = () => {
  const { isAuthenticated } = useAuth();
  const [reviews, setReviews] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedProfile, setSelectedProfile] = useState('');
  const [replyText, setReplyText] = useState('');
  const [replyingTo, setReplyingTo] = useState(null);

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

  const fetchReviews = async (locationId) => {
    if (!locationId) return;
    
    try {
      const response = await axios.get(`http://localhost:3001/api/reviews/location/${locationId}`);
      setReviews(response.data);
    } catch (error) {
      console.error('Error fetching reviews:', error);
    }
  };

  const handleReply = async (reviewId) => {
    if (!replyText.trim()) return;
    
    try {
      await axios.post(`http://localhost:3001/api/reviews/${reviewId}/reply`, {
        replyText: replyText.trim()
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
      await axios.put(`http://localhost:3001/api/reviews/${reviewId}/reply`, {
        replyText: replyText.trim()
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
      await axios.delete(`http://localhost:3001/api/reviews/${reviewId}/reply`);
      await fetchReviews(selectedProfile);
      alert('Reply deleted successfully!');
    } catch (error) {
      console.error('Error deleting reply:', error);
      alert('Failed to delete reply. Please try again.');
    }
  };

  const renderStars = (rating) => {
    return Array.from({ length: 5 }, (_, i) => (
      <Star
        key={i}
        className={`h-4 w-4 ${
          i < rating ? 'text-yellow-400 fill-current' : 'text-gray-300'
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
                <div key={review.id} className="px-6 py-4">
                  <div className="flex items-start space-x-4">
                    <div className="flex-shrink-0">
                      <div className="h-10 w-10 bg-primary-100 rounded-full flex items-center justify-center">
                        <User className="h-6 w-6 text-primary-600" />
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center space-x-2">
                        <h3 className="text-sm font-medium text-gray-900">
                          {review.reviewer_name || 'Anonymous'}
                        </h3>
                        <div className="flex items-center space-x-1">
                          {renderStars(review.rating)}
                        </div>
                        <span className="text-sm text-gray-500">
                          {new Date(review.review_time).toLocaleDateString()}
                        </span>
                      </div>
                      
                      <p className="mt-1 text-sm text-gray-700">{review.comment}</p>
                      
                      {/* Reply Section */}
                      {review.reply_text ? (
                        <div className="mt-3 bg-gray-50 rounded-lg p-3">
                          <div className="flex items-center space-x-2 mb-2">
                            <CheckCircle className="h-4 w-4 text-green-500" />
                            <span className="text-sm font-medium text-gray-900">Your Reply</span>
                            <span className="text-sm text-gray-500">
                              {new Date(review.reply_time).toLocaleDateString()}
                            </span>
                          </div>
                          <p className="text-sm text-gray-700">{review.reply_text}</p>
                          <div className="mt-2 flex space-x-2">
                            <button
                              onClick={() => {
                                setReplyingTo(review.id);
                                setReplyText(review.reply_text);
                              }}
                              className="text-sm text-primary-600 hover:text-primary-500"
                            >
                              <Edit className="h-3 w-3 inline mr-1" />
                              Edit
                            </button>
                            <button
                              onClick={() => handleDeleteReply(review.id)}
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
                            onClick={() => setReplyingTo(review.id)}
                            className="inline-flex items-center px-3 py-1 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                          >
                            <Reply className="h-3 w-3 mr-1" />
                            Reply
                          </button>
                        </div>
                      )}
                      
                      {/* Reply Form */}
                      {replyingTo === review.id && (
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
                                if (review.reply_text) {
                                  handleUpdateReply(review.id);
                                } else {
                                  handleReply(review.id);
                                }
                              }}
                              className="inline-flex items-center px-3 py-1 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700"
                            >
                              {review.reply_text ? 'Update Reply' : 'Post Reply'}
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
