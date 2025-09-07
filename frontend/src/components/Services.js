import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';
import {
  Building2,
  Search,
  Filter,
  CheckCircle,
  AlertCircle,
  RefreshCw,
  Star,
  MapPin,
  Phone,
  Globe,
  Clock,
  Tag,
  ChevronDown,
  ChevronUp,
  ExternalLink
} from 'lucide-react';

const Services = () => {
  const { isAuthenticated } = useAuth();
  const [profiles, setProfiles] = useState([]);
  const [selectedProfile, setSelectedProfile] = useState(null);
  const [businessCategories, setBusinessCategories] = useState([]);
  const [selectedCategory, setSelectedCategory] = useState('');
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [expandedServices, setExpandedServices] = useState(new Set());

  useEffect(() => {
    if (isAuthenticated) {
      fetchProfiles();
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (selectedProfile) {
      fetchBusinessCategories();
    }
  }, [selectedProfile]);

  useEffect(() => {
    if (selectedCategory) {
      fetchServicesForCategory(selectedCategory);
    }
  }, [selectedCategory]);

  const fetchProfiles = async () => {
    try {
      setLoading(true);
      const response = await axios.get('http://localhost:3001/api/gmb/accounts');
      
      if (response.data.accounts) {
        const profilesWithLocations = await Promise.all(
          response.data.accounts.map(async (account) => {
            try {
              const accountId = account.name.split('/').pop();
              const locationsResponse = await axios.get(
                `http://localhost:3001/api/gmb/accounts/${accountId}/locations`
              );
              
              const locationsWithAccount = (locationsResponse.data.locations || []).map(location => ({
                ...location,
                accountId: accountId,
                fullPath: `accounts/${accountId}/locations/${location.name.split('/').pop()}`
              }));
              
              return {
                ...account,
                locations: locationsWithAccount
              };
            } catch (error) {
              return { ...account, locations: [] };
            }
          })
        );
        setProfiles(profilesWithLocations);
      }
    } catch (error) {
      console.error('Error fetching profiles:', error);
      setError('Failed to load business profiles');
    } finally {
      setLoading(false);
    }
  };

  const fetchBusinessCategories = async () => {
    try {
      setLoading(true);
      setError(null);
      
      // First try to get categories from the selected profile's location data
      if (selectedProfile) {
        const accountId = selectedProfile.accountId;
        const locationId = selectedProfile.name.split('/').pop();
        
        try {
          const locationResponse = await axios.get(
            `http://localhost:3001/api/gmb/accounts/${accountId}/locations`
          );
          
          if (locationResponse.data.success && locationResponse.data.locations.length > 0) {
            const location = locationResponse.data.locations[0];
            if (location.categories) {
              const categories = [];
              
              // Add primary category
              if (location.categories.primaryCategory) {
                categories.push({
                  id: location.categories.primaryCategory.categoryId || location.categories.primaryCategory.id,
                  name: location.categories.primaryCategory.displayName || location.categories.primaryCategory.name,
                  displayName: location.categories.primaryCategory.displayName || location.categories.primaryCategory.name
                });
              }
              
              // Add additional categories
              if (location.categories.additionalCategories && Array.isArray(location.categories.additionalCategories)) {
                location.categories.additionalCategories.forEach(cat => {
                  categories.push({
                    id: cat.categoryId || cat.id,
                    name: cat.displayName || cat.name,
                    displayName: cat.displayName || cat.name
                  });
                });
              }
              
              if (categories.length > 0) {
                setBusinessCategories(categories);
                return;
              }
            }
          }
        } catch (profileError) {
          console.log('Could not get categories from profile, using fallback');
        }
      }
      
      // No categories available
      setBusinessCategories([]);
    } catch (error) {
      console.error('Error fetching business categories:', error);
      // No categories available
      setBusinessCategories([]);
    } finally {
      setLoading(false);
    }
  };

  const fetchServicesForCategory = async (categoryId) => {
    // Since we're now using real business categories from the profile,
    // we don't have predefined services for them
    // This could be extended in the future to fetch services from another API
    setServices([]);
  };



  const toggleServiceExpansion = (serviceId) => {
    const newExpanded = new Set(expandedServices);
    if (newExpanded.has(serviceId)) {
      newExpanded.delete(serviceId);
    } else {
      newExpanded.add(serviceId);
    }
    setExpandedServices(newExpanded);
  };

  const filteredServices = services.filter(service =>
    service.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    service.description.toLowerCase().includes(searchTerm.toLowerCase())
  );

  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <p className="text-gray-500">Please log in to view services</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Services</h1>
          <p className="mt-1 text-sm text-gray-500">
            Manage and filter services based on your business category
          </p>
        </div>
        <button
          onClick={fetchProfiles}
          disabled={loading}
          className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Profile Selection */}
      <div className="bg-white shadow rounded-lg p-6">
        <label htmlFor="profile-select" className="block text-sm font-medium text-gray-700 mb-2">
          Select Business Profile
        </label>
        <select
          id="profile-select"
          value={selectedProfile?.fullPath || ''}
          onChange={(e) => {
            const profilePath = e.target.value;
            const profile = profiles
              .flatMap(p => p.locations)
              .find(loc => loc.fullPath === profilePath);
            setSelectedProfile(profile);
            setSelectedCategory('');
            setServices([]);
          }}
          className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
        >
          <option value="">Select a business profile...</option>
          {profiles.map((profile) =>
            profile.locations.map((location) => (
              <option key={location.fullPath} value={location.fullPath}>
                {profile.accountName} - {location.title || 'Untitled Location'}
              </option>
            ))
          )}
        </select>
      </div>

      {/* Business Category Selection */}
      {selectedProfile && (
        <div className="bg-white shadow rounded-lg p-6">
          <label htmlFor="category-select" className="block text-sm font-medium text-gray-700 mb-2">
            Select Business Category
          </label>
          <select
            id="category-select"
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value)}
            className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
          >
            <option value="">Select a business category...</option>
            {businessCategories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.displayName || category.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Services Search and Filter */}
      {selectedCategory && (
        <div className="bg-white shadow rounded-lg p-6">
          <div className="flex items-center space-x-4 mb-4">
            <div className="flex-1">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search services..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10 pr-4 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 w-full"
                />
              </div>
            </div>
            <div className="flex items-center space-x-2">
              <Filter className="h-4 w-4 text-gray-400" />
              <span className="text-sm text-gray-500">
                {filteredServices.length} service{filteredServices.length !== 1 ? 's' : ''}
              </span>
            </div>
          </div>

          {/* Services List */}
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
              <span className="ml-3 text-gray-600">Loading services...</span>
            </div>
          ) : error ? (
            <div className="text-center py-8">
              <AlertCircle className="h-12 w-12 text-red-400 mx-auto mb-4" />
              <p className="text-red-600">{error}</p>
            </div>
          ) : filteredServices.length > 0 ? (
            <div className="space-y-3">
              {filteredServices.map((service) => (
                <div
                  key={service.id}
                  className="border border-gray-200 rounded-lg p-4 hover:shadow-md transition-shadow"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <h3 className="text-lg font-semibold text-gray-900 flex items-center">
                        <CheckCircle className="h-5 w-5 text-green-500 mr-2" />
                        {service.name}
                      </h3>
                      <p className="text-gray-600 mt-1">{service.description}</p>
                    </div>
                    <button
                      onClick={() => toggleServiceExpansion(service.id)}
                      className="p-2 hover:bg-gray-100 rounded-full transition-colors"
                    >
                      {expandedServices.has(service.id) ? (
                        <ChevronUp className="h-4 w-4 text-gray-500" />
                      ) : (
                        <ChevronDown className="h-4 w-4 text-gray-500" />
                      )}
                    </button>
                  </div>
                  
                  {expandedServices.has(service.id) && (
                    <div className="mt-4 pt-4 border-t border-gray-200">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <h4 className="text-sm font-medium text-gray-700 mb-2">Service Details</h4>
                          <div className="space-y-2">
                            <div className="flex items-center text-sm text-gray-600">
                              <Tag className="h-4 w-4 mr-2" />
                              Service ID: {service.id}
                            </div>
                            <div className="flex items-center text-sm text-gray-600">
                              <Building2 className="h-4 w-4 mr-2" />
                              Category: {selectedCategory}
                            </div>
                          </div>
                        </div>
                        <div>
                          <h4 className="text-sm font-medium text-gray-700 mb-2">Actions</h4>
                          <div className="space-y-2">
                            <button className="w-full px-3 py-2 bg-primary-600 text-white text-sm rounded-md hover:bg-primary-700 transition-colors">
                              Add to Business Profile
                            </button>
                            <button className="w-full px-3 py-2 border border-gray-300 text-gray-700 text-sm rounded-md hover:bg-gray-50 transition-colors">
                              View Details
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8">
              <Building2 className="h-12 w-12 text-gray-400 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">No services found</h3>
              <p className="text-gray-500">
                {searchTerm ? 'Try adjusting your search terms' : 'Select a business category to view available services'}
              </p>
            </div>
          )}
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
            <h3 className="text-sm font-medium text-blue-800">How to use Services</h3>
            <div className="mt-2 text-sm text-blue-700">
              <p>
                1. Select your business profile to load available categories<br/>
                2. Choose a business category to see relevant services<br/>
                3. Search and filter services to find what you need<br/>
                4. Click on services to view details and add them to your business profile
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Services;
