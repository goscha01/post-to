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
  const [existingServices, setExistingServices] = useState([]);
  const [isManagingServices, setIsManagingServices] = useState(false);
  const [categorySearchTerm, setCategorySearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [isSearchingCategories, setIsSearchingCategories] = useState(false);
  const [showAddServiceModal, setShowAddServiceModal] = useState(false);
  const [newServiceName, setNewServiceName] = useState('');
  const [newServiceDescription, setNewServiceDescription] = useState('');
  const [newServicePrice, setNewServicePrice] = useState('');
  const [newServiceCurrency, setNewServiceCurrency] = useState('USD');
  const [selectedPredefinedService, setSelectedPredefinedService] = useState('');
  const [showEditServiceModal, setShowEditServiceModal] = useState(false);
  const [editingService, setEditingService] = useState(null);
  const [editServiceName, setEditServiceName] = useState('');
  const [editServiceDescription, setEditServiceDescription] = useState('');
  const [editServicePrice, setEditServicePrice] = useState('');
  const [editServiceCurrency, setEditServiceCurrency] = useState('USD');
  const [isLoading, setIsLoading] = useState(false);
  const [lastApiCall, setLastApiCall] = useState(0);

  // Rate limiting function to prevent 429 errors
  const rateLimitDelay = async () => {
    const now = Date.now();
    const timeSinceLastCall = now - lastApiCall;
    const minDelay = 1000; // 1 second minimum between calls
    
    if (timeSinceLastCall < minDelay) {
      const delay = minDelay - timeSinceLastCall;
      console.log(`⏳ Rate limiting: waiting ${delay}ms before next API call`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    
    setLastApiCall(Date.now());
  };

  const testApiPermissions = async () => {
    if (!selectedProfile) return;
    
    try {
      const locationId = selectedProfile.name.split('/').pop();
      const accountId = selectedProfile.accountId;
      
      console.log('🧪 Testing API permissions...');
      
      // Test 1: Check location metadata
      try {
        const locationResponse = await axios.get(`http://localhost:3001/api/gmb/accounts/${accountId}/locations`);
        if (locationResponse.data.success && locationResponse.data.locations) {
          const location = locationResponse.data.locations.find(loc => 
            loc.name === `accounts/${accountId}/locations/${locationId}`
          );
          
          if (location && location.metadata) {
            console.log('✅ Location metadata retrieved:', {
              canModifyServiceList: location.metadata.canModifyServiceList,
              canDelete: location.metadata.canDelete,
              placeId: location.metadata.placeId
            });
          }
        }
      } catch (error) {
        console.log('❌ Failed to get location metadata:', error.message);
      }
      
      // Test 2: Try to get current services
      try {
        const servicesResponse = await axios.get(`http://localhost:3001/api/gmb/locations/${locationId}/services`);
        console.log('✅ Services fetch successful:', {
          success: servicesResponse.data.success,
          serviceCount: servicesResponse.data.serviceItems?.length || 0
        });
      } catch (error) {
        console.log('❌ Failed to get services:', error.message);
      }
      
      // Test 3: Try a minimal service update
      try {
        const testService = {
          freeFormServiceItem: {
            category: 'gcid:house_cleaning_service',
            label: {
              displayName: 'API Test Service',
              description: 'Testing if we can add services'
            }
          }
        };
        
        const testResponse = await axios.patch(`http://localhost:3001/api/gmb/locations/${locationId}/services`, {
          serviceItems: [testService]
        });
        
        console.log('✅ Service update test successful:', testResponse.data);
        
      } catch (error) {
        console.log('❌ Service update test failed:', {
          status: error.response?.status,
          message: error.response?.data?.error || error.message,
          data: error.response?.data
        });
      }
      
    } catch (error) {
      console.error('❌ API permission test failed:', error);
    }
  };

  useEffect(() => {
    if (isAuthenticated) {
      fetchProfiles();
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (selectedProfile) {
      fetchBusinessCategories();
      fetchExistingServices();
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
    // Convert category name to proper Google category ID format
    let googleCategoryId = categoryId;
    console.log('Original categoryId:', categoryId);
    
    if (!categoryId.startsWith('gcid:')) {
      // Convert display name to Google category ID
      const categoryMap = {
        'House cleaning service': 'gcid:house_cleaning_service',
        'House Cleaning Service': 'gcid:house_cleaning_service',
        'Cleaning Service': 'gcid:house_cleaning_service',
        'Restaurant': 'gcid:restaurant',
        'Hair Salon': 'gcid:hair_salon',
        'Electrician': 'gcid:electrician',
        'Plumber': 'gcid:plumber',
        'Auto Repair': 'gcid:auto_repair',
        'Dentist': 'gcid:dentist',
        'Lawyer': 'gcid:lawyer',
        'Accountant': 'gcid:accountant',
        'Gym': 'gcid:gym',
        'Hotel': 'gcid:hotel'
      };
      googleCategoryId = categoryMap[categoryId] || `gcid:${categoryId.toLowerCase().replace(/\s+/g, '_')}`;
    }
    
    console.log('Using Google category ID:', googleCategoryId);
    
    try {
      setLoading(true);
      setError(null);
      
      console.log('🔍 FETCHING SERVICES for category:', categoryId);
      console.log('Google category ID:', googleCategoryId);
      
      // Convert to proper format for Google API
      const properCategoryId = googleCategoryId.startsWith('categories/') 
        ? googleCategoryId 
        : `categories/${googleCategoryId}`;
      
      console.log('Proper category ID for API:', properCategoryId);
      console.log('Making API call to backend...');
      
      const response = await axios.get(`http://localhost:3001/api/gmb/categories/batchGet`, {
        params: {
          names: properCategoryId,
          regionCode: 'US',
          languageCode: 'en',
          view: 'FULL'
        }
      });
      
      console.log('✅ API call successful, response received');
      
      if (response.data.success && response.data.categories.length > 0) {
        const category = response.data.categories[0];
        
        if (category.serviceTypes && Array.isArray(category.serviceTypes) && category.serviceTypes.length > 0) {
          // Check if services have valid data
          const hasValidServices = category.serviceTypes.some(service => 
            service.displayName || service.serviceTypeId
          );
          
          if (hasValidServices) {
            const services = category.serviceTypes.map(service => {
              // Handle both structured and free-form services
              if (service.serviceTypeId) {
                // Structured service
                let serviceName = service.displayName;
                if (!serviceName && service.serviceTypeId) {
                  serviceName = service.serviceTypeId
                    .split(':').pop() // Remove 'job_type_id:' prefix
                    .split('_')
                    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                    .join(' ');
                }
                
                return {
                  id: service.serviceTypeId || `service_${Date.now()}_${Math.random()}`,
                  name: serviceName || generateServiceName(service.serviceTypeId),
                  description: service.description || `Predefined service: ${serviceName || generateServiceName(service.serviceTypeId)}`,
                  type: 'structured',
                  serviceTypeId: service.serviceTypeId || ''
                };
              } else {
                // Free-form service (fallback) - treat as predefined for display
                return {
                  id: `fallback_${Date.now()}_${Math.random()}`,
                  name: service.displayName || 'Unnamed Service',
                  description: service.description || `Professional ${service.displayName?.toLowerCase() || 'cleaning'} service`,
                  type: 'predefined', // Mark as predefined for UI display
                  serviceTypeId: ''
                };
              }
            });
            setServices(services);
          } else {
            // Use fallback services if API returns empty service objects
            console.log('API returned empty service objects, using fallback services');
            const fallbackServices = [
              { id: 'deep_cleaning', name: 'Deep Cleaning', description: 'Comprehensive deep cleaning service', type: 'predefined', serviceTypeId: '' },
              { id: 'regular_cleaning', name: 'Regular Cleaning', description: 'Regular house cleaning service', type: 'predefined', serviceTypeId: '' },
              { id: 'move_in_out', name: 'Move-in/Move-out Cleaning', description: 'Cleaning for moving in or out', type: 'predefined', serviceTypeId: '' },
              { id: 'post_construction', name: 'Post-Construction Cleaning', description: 'Cleaning after construction work', type: 'predefined', serviceTypeId: '' },
              { id: 'office_cleaning', name: 'Office Cleaning', description: 'Commercial office cleaning', type: 'predefined', serviceTypeId: '' },
              { id: 'upholstery_cleaning', name: 'Upholstery Cleaning', description: 'Furniture and upholstery cleaning', type: 'predefined', serviceTypeId: '' },
              { id: 'mattress_cleaning', name: 'Mattress Cleaning', description: 'Specialized mattress cleaning', type: 'predefined', serviceTypeId: '' },
              { id: 'window_cleaning', name: 'Window Cleaning', description: 'Interior and exterior window cleaning', type: 'predefined', serviceTypeId: '' }
            ];
            setServices(fallbackServices);
          }
        } else {
          // If no service types found, provide fallback services for house cleaning
          if (googleCategoryId.includes('house_cleaning') || googleCategoryId.includes('cleaning')) {
            const fallbackServices = [
              { id: 'deep_cleaning', name: 'Deep Cleaning', description: 'Comprehensive deep cleaning service', type: 'structured', serviceTypeId: 'job_type_id:deep_cleaning' },
              { id: 'regular_cleaning', name: 'Regular Cleaning', description: 'Regular house cleaning service', type: 'structured', serviceTypeId: 'job_type_id:regular_cleaning' },
              { id: 'move_in_out', name: 'Move-in/Move-out Cleaning', description: 'Cleaning for moving in or out', type: 'structured', serviceTypeId: 'job_type_id:move_in_out_cleaning' },
              { id: 'post_construction', name: 'Post-Construction Cleaning', description: 'Cleaning after construction work', type: 'structured', serviceTypeId: 'job_type_id:post_construction_cleaning' },
              { id: 'office_cleaning', name: 'Office Cleaning', description: 'Commercial office cleaning', type: 'structured', serviceTypeId: 'job_type_id:office_cleaning' }
            ];
            setServices(fallbackServices);
          } else {
            setServices([]);
          }
        }
      } else {
        // If API call fails, provide fallback services for house cleaning
        if (googleCategoryId.includes('house_cleaning') || googleCategoryId.includes('cleaning')) {
          const fallbackServices = [
            { id: 'deep_cleaning', name: 'Deep Cleaning', description: 'Comprehensive deep cleaning service', type: 'structured', serviceTypeId: 'job_type_id:deep_cleaning' },
            { id: 'regular_cleaning', name: 'Regular Cleaning', description: 'Regular house cleaning service', type: 'structured', serviceTypeId: 'job_type_id:regular_cleaning' },
            { id: 'move_in_out', name: 'Move-in/Move-out Cleaning', description: 'Cleaning for moving in or out', type: 'structured', serviceTypeId: 'job_type_id:move_in_out_cleaning' },
            { id: 'post_construction', name: 'Post-Construction Cleaning', description: 'Cleaning after construction work', type: 'structured', serviceTypeId: 'job_type_id:post_construction_cleaning' },
            { id: 'office_cleaning', name: 'Office Cleaning', description: 'Commercial office cleaning', type: 'structured', serviceTypeId: 'job_type_id:office_cleaning' }
          ];
          setServices(fallbackServices);
        } else {
          setServices([]);
        }
      }
    } catch (error) {
      console.error('Error fetching services for category:', error);
      console.log('Using fallback services due to API error');
      setError('Failed to fetch services for this category. The category might not be supported by Google My Business API.');
      
      // Use fallback services even on error for house cleaning
      if (googleCategoryId.includes('house_cleaning') || googleCategoryId.includes('cleaning')) {
        const fallbackServices = [
          { id: 'deep_cleaning', name: 'Deep Cleaning', description: 'Comprehensive deep cleaning service', type: 'structured', serviceTypeId: 'job_type_id:deep_cleaning' },
          { id: 'regular_cleaning', name: 'Regular Cleaning', description: 'Regular house cleaning service', type: 'structured', serviceTypeId: 'job_type_id:regular_cleaning' },
          { id: 'move_in_out', name: 'Move-in/Move-out Cleaning', description: 'Cleaning for moving in or out', type: 'structured', serviceTypeId: 'job_type_id:move_in_out_cleaning' },
          { id: 'post_construction', name: 'Post-Construction Cleaning', description: 'Cleaning after construction work', type: 'structured', serviceTypeId: 'job_type_id:post_construction_cleaning' },
          { id: 'office_cleaning', name: 'Office Cleaning', description: 'Commercial office cleaning', type: 'structured', serviceTypeId: 'job_type_id:office_cleaning' }
        ];
        console.log('Using fallback services due to error:', fallbackServices);
        setServices(fallbackServices);
        setError(null); // Clear error since we have fallback services
      } else {
        setServices([]);
      }
    } finally {
      setLoading(false);
    }
  };

  const fetchExistingServices = async () => {
    if (!selectedProfile) return;
    
    try {
      setIsLoading(true);
      await rateLimitDelay(); // Add rate limiting
      
      const locationId = selectedProfile.name.split('/').pop();
      const response = await axios.get(`http://localhost:3001/api/gmb/locations/${locationId}/services`);
      
      if (response.data.success) {
        const serviceItems = response.data.serviceItems || [];
        
        const formattedServices = serviceItems.map((item, index) => {
          
          if (item.structuredServiceItem) {
            // Convert structured service to display format
            return {
              id: item.structuredServiceItem.serviceTypeId || `service_${Date.now()}_${Math.random()}`,
              name: item.structuredServiceItem.serviceTypeId ? 
                item.structuredServiceItem.serviceTypeId.split(':').pop().replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) : 
                'Unnamed Service',
              description: item.structuredServiceItem.description || '',
              type: 'predefined', // Show as predefined in UI
              serviceTypeId: item.structuredServiceItem.serviceTypeId || '',
              isOffered: item.isOffered !== false
            };
          } else if (item.freeFormServiceItem) {
            // Determine if this is a predefined service converted to free-form or truly custom
            const isPredefined = item.freeFormServiceItem.category === 'gcid:house_cleaning_service' && 
                                 item.freeFormServiceItem.label?.displayName && 
                                 !item.freeFormServiceItem.label?.displayName.includes('Custom');
            
            // Check for description in multiple possible locations
            let description = '';
            if (item.freeFormServiceItem.label?.description) {
              description = item.freeFormServiceItem.label.description;
            } else if (item.freeFormServiceItem.description) {
              description = item.freeFormServiceItem.description;
            } else if (item.description) {
              description = item.description;
            }
            
            // Extract price information
            let price = null;
            if (item.price) {
              const units = item.price.units || '0';
              const nanos = item.price.nanos || 0;
              const currencyCode = item.price.currencyCode || 'USD';
              
              // Convert to decimal format
              const totalAmount = parseFloat(units) + (nanos / 1000000000);
              price = {
                amount: totalAmount,
                currency: currencyCode,
                display: `${currencyCode} ${totalAmount.toFixed(2)}`
              };
            }
            
            return {
              id: `service_${Date.now()}_${Math.random()}`,
              name: item.freeFormServiceItem.label?.displayName || 'Custom Service',
              description: description,
              price: price,
              type: isPredefined ? 'predefined' : 'custom', // Show as predefined or custom based on content
              categoryId: item.freeFormServiceItem.category || item.freeFormServiceItem.categoryId || '',
              isOffered: item.isOffered !== false,
              originalItem: item // Keep reference to original data for updates
            };
          }
          return null;
        }).filter(Boolean);
        
        
        setExistingServices(formattedServices);
      }
    } catch (error) {
      console.error('Error fetching existing services:', error);
      
      if (error.response?.status === 429) {
        setError('Rate limit exceeded. Please wait a moment before trying again.');
        // Wait 5 seconds before allowing retry
        setTimeout(() => {
          setError(null);
        }, 5000);
      } else {
        setError('Failed to fetch existing services');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const addServiceToLocation = async (service) => {
    if (!selectedProfile) return;
    
    try {
      setIsLoading(true);
      await rateLimitDelay(); // Add rate limiting
      
      const locationId = selectedProfile.name.split('/').pop();
      
      // First, check if the location supports service management
      console.log('🔍 Checking location permissions...');
      
      try {
        const accountId = selectedProfile.accountId;
        const locationResponse = await axios.get(`http://localhost:3001/api/gmb/accounts/${accountId}/locations`);
        
        if (locationResponse.data.success && locationResponse.data.locations) {
          const location = locationResponse.data.locations.find(loc => 
            loc.name === `accounts/${accountId}/locations/${locationId}`
          );
          
          if (location && location.metadata) {
            console.log('📍 Location metadata:', {
              canModifyServiceList: location.metadata.canModifyServiceList,
              canDelete: location.metadata.canDelete,
              placeId: location.metadata.placeId
            });
            
            if (location.metadata.canModifyServiceList === false) {
              setError('❌ This business location does not support service management. The canModifyServiceList flag is false.');
              return;
            }
          }
        }
      } catch (metadataError) {
        console.log('Could not check location metadata:', metadataError.message);
      }
      
      // Get current services to preserve them
      const currentServicesResponse = await axios.get(`http://localhost:3001/api/gmb/locations/${locationId}/services`);
      let currentServiceItems = [];
      
      if (currentServicesResponse.data.success && currentServicesResponse.data.serviceItems) {
        currentServiceItems = currentServicesResponse.data.serviceItems;
      }
      
      // Always use free-form service to avoid Google API validation issues
      const newServiceItem = {
        freeFormServiceItem: {
          category: 'gcid:house_cleaning_service',
          label: {
            displayName: service.name,
            description: service.description || `Professional ${service.name.toLowerCase()} service`
          }
        }
      };
      
      // Add the new service to existing services
      const allServiceItems = [...currentServiceItems, newServiceItem];
      
      console.log('Adding service to location:', {
        locationId,
        service,
        newServiceItem,
        currentCount: currentServiceItems.length,
        newCount: allServiceItems.length
      });
      
      // Send all services (existing + new) to preserve existing ones
      const response = await axios.patch(`http://localhost:3001/api/gmb/locations/${locationId}/services`, {
        serviceItems: allServiceItems
      });
      
      if (response.data.success) {
        await fetchExistingServices(); // Refresh the list
        setError(null);
      }
    } catch (error) {
      console.error('Error adding service:', error);
      console.error('Full error details:', {
        message: error.message,
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        config: {
          url: error.config?.url,
          method: error.config?.method,
          data: error.config?.data
        }
      });
      
      // Show more specific error message
      if (error.response?.status === 429) {
        setError('Rate limit exceeded. Please wait a moment before trying again.');
        // Wait 5 seconds before allowing retry
        setTimeout(() => {
          setError(null);
        }, 5000);
      } else if (error.response?.status === 500) {
        setError(`Server error (500): ${error.response?.data?.error || error.message}. This might be a Google API issue or permission problem.`);
      } else if (error.response?.status === 403) {
        setError('Permission denied (403): Your account may not have permission to modify services for this business location.');
      } else if (error.response?.status === 400) {
        setError(`Bad request (400): ${error.response?.data?.error || error.message}. The request format might be invalid.`);
      } else {
        setError(`Failed to add service: ${error.message}`);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const removeServiceFromLocation = async (serviceId) => {
    if (!selectedProfile) return;
    
    try {
      const locationId = selectedProfile.name.split('/').pop();
      const remainingServices = existingServices.filter(service => service.id !== serviceId);
      
      // Convert remaining services to Google API format (always use free-form)
      const currentServices = remainingServices.map(service => {
        return {
          freeFormServiceItem: {
            category: 'gcid:house_cleaning_service',
            label: {
              displayName: service.name,
              description: service.description || ''
            }
          }
        };
      });
      
      const response = await axios.patch(`http://localhost:3001/api/gmb/locations/${locationId}/services`, {
        serviceItems: currentServices
      });
      
      if (response.data.success) {
        await fetchExistingServices(); // Refresh the list
        setError(null);
      }
    } catch (error) {
      console.error('Error removing service:', error);
      setError('Failed to remove service');
    }
  };

  const searchCategories = async (searchTerm) => {
    if (!searchTerm.trim()) {
      setSearchResults([]);
      return;
    }
    
    try {
      setIsSearchingCategories(true);
      const response = await axios.get(`http://localhost:3001/api/gmb/categories`, {
        params: {
          filter: `displayname=${searchTerm}`,
          regionCode: 'US',
          languageCode: 'en',
          view: 'FULL'
        }
      });
      
      if (response.data.success) {
        setSearchResults(response.data.categories || []);
      }
    } catch (error) {
      console.error('Error searching categories:', error);
      setSearchResults([]);
    } finally {
      setIsSearchingCategories(false);
    }
  };

  const addCategoryToBusiness = (category) => {
    const newCategory = {
      id: category.name,
      name: category.displayName,
      displayName: category.displayName
    };
    
    // Add to business categories if not already present
    if (!businessCategories.some(cat => cat.id === category.name)) {
      setBusinessCategories([...businessCategories, newCategory]);
    }
    
    // Select the new category
    setSelectedCategory(category.name);
    setCategorySearchTerm('');
    setSearchResults([]);
  };

  const generateServiceName = (serviceId) => {
    if (!serviceId) return 'Unnamed Service';
    
    // Handle different ID formats
    if (serviceId.startsWith('job_type_id:')) {
      return serviceId
        .replace('job_type_id:', '')
        .split('_')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
    }
    
    if (serviceId.startsWith('service_')) {
      // This is a generated ID, provide a generic name
      return 'Predefined Service';
    }
    
    // Try to extract meaningful name from any other format
    return serviceId
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  };

  const handleAddService = () => {
    if (selectedPredefinedService) {
      // Find the selected service from filteredServices
      const selectedService = (filteredServices || []).find(service => service.id === selectedPredefinedService);
      if (selectedService) {
        addServiceToLocation(selectedService);
      }
    } else if (newServiceName.trim()) {
      // Add custom service
      addCustomServiceToLocation(newServiceName.trim(), newServiceDescription.trim(), newServicePrice, newServiceCurrency);
    }
    setShowAddServiceModal(false);
    setNewServiceName('');
    setNewServiceDescription('');
    setNewServicePrice('');
    setNewServiceCurrency('USD');
    setSelectedPredefinedService('');
  };

  const handleEditService = (service) => {
    setEditingService(service);
    setEditServiceName(service.name);
    setEditServiceDescription(service.description || '');
    setEditServicePrice(service.price ? service.price.amount.toString() : '');
    setEditServiceCurrency(service.price ? service.price.currency : 'USD');
    setShowEditServiceModal(true);
  };

  const handleUpdateService = async () => {
    if (!editingService || !selectedProfile) return;
    
    try {
      setIsLoading(true);
      await rateLimitDelay(); // Add rate limiting
      
      const locationId = selectedProfile.name.split('/').pop();
      
      // Get current services
      const currentServicesResponse = await axios.get(`http://localhost:3001/api/gmb/locations/${locationId}/services`);
      let currentServiceItems = [];
      
      if (currentServicesResponse.data.success && currentServicesResponse.data.serviceItems) {
        currentServiceItems = currentServicesResponse.data.serviceItems;
      }
      
      // Find and update the specific service
      const updatedServiceItems = currentServiceItems.map(item => {
        if (item.freeFormServiceItem?.label?.displayName === editingService.name) {
          // Update the service
          const updatedItem = {
            ...item,
            freeFormServiceItem: {
              ...item.freeFormServiceItem,
              label: {
                ...item.freeFormServiceItem.label,
                displayName: editServiceName,
                description: editServiceDescription
              }
            }
          };
          
          // Add price if provided
          if (editServicePrice && editServicePrice.trim()) {
            const priceAmount = parseFloat(editServicePrice);
            if (!isNaN(priceAmount)) {
              const units = Math.floor(priceAmount).toString();
              const nanos = Math.round((priceAmount - Math.floor(priceAmount)) * 1000000000);
              
              updatedItem.price = {
                currencyCode: editServiceCurrency,
                units: units,
                nanos: nanos
              };
            }
          } else {
            // Remove price if empty
            delete updatedItem.price;
          }
          
          return updatedItem;
        }
        return item;
      });
      
      // Send updated services to Google
      const response = await axios.patch(`http://localhost:3001/api/gmb/locations/${locationId}/services`, {
        serviceItems: updatedServiceItems
      });
      
      if (response.data.success) {
        await fetchExistingServices(); // Refresh the list
        setShowEditServiceModal(false);
        setEditingService(null);
        setError(null);
      }
    } catch (error) {
      console.error('Error updating service:', error);
      
      if (error.response?.status === 429) {
        setError('Rate limit exceeded. Please wait a moment before trying again.');
        // Wait 5 seconds before allowing retry
        setTimeout(() => {
          setError(null);
        }, 5000);
      } else {
        setError('Failed to update service');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const addCustomServiceToLocation = async (serviceName, serviceDescription, servicePrice, serviceCurrency) => {
    if (!selectedProfile) return;
    
    try {
      setIsLoading(true);
      await rateLimitDelay(); // Add rate limiting
      
      const locationId = selectedProfile.name.split('/').pop();
      
      // First, get current services to preserve them
      const currentServicesResponse = await axios.get(`http://localhost:3001/api/gmb/locations/${locationId}/services`);
      let currentServiceItems = [];
      
      if (currentServicesResponse.data.success && currentServicesResponse.data.serviceItems) {
        currentServiceItems = currentServicesResponse.data.serviceItems;
      }
      
      // Create new custom service item
      const newServiceItem = {
        freeFormServiceItem: {
          category: 'gcid:house_cleaning_service',
          label: {
            displayName: serviceName,
            description: serviceDescription
          }
        }
      };
      
      // Add price if provided
      if (servicePrice && servicePrice.trim()) {
        const priceAmount = parseFloat(servicePrice);
        if (!isNaN(priceAmount)) {
          const units = Math.floor(priceAmount).toString();
          const nanos = Math.round((priceAmount - Math.floor(priceAmount)) * 1000000000);
          
          newServiceItem.price = {
            currencyCode: serviceCurrency,
            units: units,
            nanos: nanos
          };
        }
      }
      
      // Add the new service to existing services
      const allServiceItems = [...currentServiceItems, newServiceItem];
      
      console.log('Adding custom service to location:', {
        locationId,
        serviceName,
        serviceDescription,
        currentCount: currentServiceItems.length,
        newCount: allServiceItems.length
      });
      
      // Send all services (existing + new) to preserve existing ones
      const response = await axios.patch(`http://localhost:3001/api/gmb/locations/${locationId}/services`, {
        serviceItems: allServiceItems
      });
      
      if (response.data.success) {
        // Refresh existing services
        await fetchExistingServices();
        setError(null);
      }
    } catch (error) {
      console.error('Error adding custom service:', error);
      setError('Failed to add custom service');
    }
  };

  const restoreAllServices = async () => {
    if (!selectedProfile) return;
    
    try {
      const locationId = selectedProfile.name.split('/').pop();
      
      // First, let's check if the location supports service management
      console.log('🔍 Checking if location supports service management...');
      
      try {
        // Try to get the location details to check metadata
        const accountId = selectedProfile.accountId;
        const locationResponse = await axios.get(`http://localhost:3001/api/gmb/accounts/${accountId}/locations`);
        
        if (locationResponse.data.success && locationResponse.data.locations) {
          const location = locationResponse.data.locations.find(loc => 
            loc.name === `accounts/${accountId}/locations/${locationId}`
          );
          
          if (location && location.metadata) {
            console.log('📍 Location metadata:', {
              canModifyServiceList: location.metadata.canModifyServiceList,
              canDelete: location.metadata.canDelete,
              placeId: location.metadata.placeId
            });
            
            if (location.metadata.canModifyServiceList === false) {
              setError('This business location does not support service management. The canModifyServiceList flag is false.');
              return;
            }
          }
        }
      } catch (metadataError) {
        console.log('Could not check location metadata:', metadataError.message);
      }
      
      // Get current services and convert any structured services to free-form
      const currentServicesResponse = await axios.get(`http://localhost:3001/api/gmb/locations/${locationId}/services`);
      let currentServiceItems = [];
      
      if (currentServicesResponse.data.success && currentServicesResponse.data.serviceItems) {
        // Convert all existing services to free-form to avoid invalid structured service IDs
        currentServiceItems = currentServicesResponse.data.serviceItems.map(item => {
          if (item.structuredServiceItem) {
            // Convert structured service to free-form
            const serviceName = item.structuredServiceItem.serviceTypeId 
              ? item.structuredServiceItem.serviceTypeId.split(':').pop().replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
              : 'Cleaning Service';
            
            return {
              freeFormServiceItem: {
                category: 'gcid:house_cleaning_service',
                label: {
                  displayName: serviceName,
                  description: item.structuredServiceItem.description || `Professional ${serviceName.toLowerCase()} service`
                }
              }
            };
          } else {
            // Keep free-form services as-is but ensure they have the category field
            return {
              freeFormServiceItem: {
                category: item.freeFormServiceItem?.category || 'gcid:house_cleaning_service',
                label: {
                  displayName: item.freeFormServiceItem?.label?.displayName || 'Service',
                  description: item.freeFormServiceItem?.label?.description || ''
                }
              }
            };
          }
        });
      }
      
      // Try adding just ONE service first to test
      const testService = {
        freeFormServiceItem: {
          category: 'gcid:house_cleaning_service',
          label: {
            displayName: 'Test Service',
            description: 'This is a test service to check if the API works'
          }
        }
      };
      
      console.log('🧪 Testing with single service first...');
      
      try {
        const testResponse = await axios.patch(`http://localhost:3001/api/gmb/locations/${locationId}/services`, {
          serviceItems: [testService]
        });
        
        if (testResponse.data.success) {
          console.log('✅ Single service test successful! The API works.');
          
          // If single service works, try adding more
          const essentialServices = [
            { name: 'Deep Cleaning', description: 'Comprehensive deep cleaning service' },
            { name: 'Regular Cleaning', description: 'Regular house cleaning service' },
            { name: 'Move-in/Move-out Cleaning', description: 'Cleaning for moving situations' },
            { name: 'Office Cleaning', description: 'Commercial office cleaning' },
            { name: 'General Housekeeping', description: 'General housekeeping services' }
          ];
          
          // Convert to Google API format
          const newServiceItems = essentialServices.map(service => ({
            freeFormServiceItem: {
              category: 'gcid:house_cleaning_service',
              label: {
                displayName: service.name,
                description: service.description
              }
            }
          }));
          
          // Remove duplicates
          const existingServiceNames = currentServiceItems.map(item => 
            item.freeFormServiceItem?.label?.displayName || 
            item.structuredServiceItem?.serviceTypeId || 
            'unknown'
          );
          
          const uniqueNewServices = newServiceItems.filter(newService => 
            !existingServiceNames.includes(newService.freeFormServiceItem.label.displayName)
          );
          
          // Combine existing + new services
          const allServiceItems = [...currentServiceItems, ...uniqueNewServices];
          
          console.log('🔄 Adding remaining services...');
          
          const response = await axios.patch(`http://localhost:3001/api/gmb/locations/${locationId}/services`, {
            serviceItems: allServiceItems
          });
          
          if (response.data.success) {
            console.log('✅ All services restored successfully!');
            await fetchExistingServices();
            setError(null);
            alert(`Successfully restored ${uniqueNewServices.length} new services! (${currentServiceItems.length} existing + ${uniqueNewServices.length} new = ${allServiceItems.length} total)`);
          } else {
            console.error('❌ Failed to restore services:', response.data);
            setError('Failed to restore services after successful test.');
          }
          
        } else {
          console.error('❌ Single service test failed:', testResponse.data);
          setError('Failed to add even a single service. The business location may not support service management.');
        }
        
      } catch (testError) {
        console.error('❌ Single service test error:', testError);
        console.error('Error details:', {
          message: testError.message,
          status: testError.response?.status,
          data: testError.response?.data
        });
        setError(`Failed to add services. Error: ${testError.response?.data?.error || testError.message}`);
      }
      
    } catch (error) {
      console.error('Error restoring services:', error);
      setError('Failed to restore services');
    }
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

  const filteredServices = services.filter(service => {
    if (!searchTerm.trim()) return true;
    return (
      (service.name && service.name.toLowerCase().includes(searchTerm.toLowerCase())) ||
      (service.description && service.description.toLowerCase().includes(searchTerm.toLowerCase()))
    );
  });

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
          {profiles.flatMap((profile) =>
            (profile.locations || []).map((location) => (
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
          <div className="mb-4">
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
              {(businessCategories || []).map((category) => (
                <option key={category.id || category.name || `category_${Math.random()}`} value={category.id}>
                  {category.displayName || category.name}
                </option>
              ))}
            </select>
          </div>
          
          {/* Category Search */}
          <div>
            <label htmlFor="category-search" className="block text-sm font-medium text-gray-700 mb-2">
              Search for Additional Categories
            </label>
            <div className="relative">
              <input
                id="category-search"
                type="text"
                value={categorySearchTerm}
                onChange={(e) => {
                  setCategorySearchTerm(e.target.value);
                  searchCategories(e.target.value);
                }}
                placeholder="Search for categories (e.g., 'cleaning', 'restaurant')"
                className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm pr-10"
              />
              {isSearchingCategories && (
                <div className="absolute inset-y-0 right-0 pr-3 flex items-center">
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary-600"></div>
                </div>
              )}
            </div>
            
            {/* Search Results */}
            {searchResults.length > 0 && (
              <div className="mt-2 border border-gray-200 rounded-md shadow-lg bg-white max-h-60 overflow-y-auto">
                {(searchResults || []).map((category) => (
                  <div
                    key={category.name || `search_${Math.random()}`}
                    className="px-4 py-3 hover:bg-gray-50 cursor-pointer border-b border-gray-100 last:border-b-0"
                    onClick={() => addCategoryToBusiness(category)}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-sm font-medium text-gray-900">
                          {category.displayName}
                        </div>
                        <div className="text-xs text-gray-500">
                          {category.name}
                        </div>
                      </div>
                      <button className="text-primary-600 hover:text-primary-800 text-sm font-medium">
                        Add
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
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

          {/* Management Toggle */}
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-medium text-gray-900">Services Management</h3>
            <div className="flex gap-2">
              <button
                onClick={testApiPermissions}
                className="inline-flex items-center px-3 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-orange-600 hover:bg-orange-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-orange-500"
              >
                Test API
              </button>
              <button
                onClick={restoreAllServices}
                className="inline-flex items-center px-3 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-purple-600 hover:bg-purple-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-purple-500"
              >
                Restore All Services
              </button>
              <button
                onClick={() => setShowAddServiceModal(true)}
                className="inline-flex items-center px-3 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-green-600 hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500"
              >
                Add Service
              </button>
              <button
                onClick={() => setIsManagingServices(!isManagingServices)}
                className="inline-flex items-center px-3 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
              >
                {isManagingServices ? 'View Only' : 'Manage Services'}
              </button>
            </div>
          </div>

          {/* Existing Services */}
          {isLoading && (
            <div className="mb-6">
              <div className="flex items-center justify-center p-6 bg-white rounded-lg shadow">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
                <span className="ml-2 text-gray-600">Loading services...</span>
              </div>
            </div>
          )}
          
          {!isLoading && existingServices.length > 0 && (
            <div className="mb-6">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-md font-medium text-gray-900">Services Currently on Your Google Business Profile</h4>
                <span className="text-sm text-gray-500 bg-gray-100 px-2 py-1 rounded-full">
                  {existingServices.length} service{existingServices.length !== 1 ? 's' : ''}
                </span>
              </div>
              <div className="space-y-2">
                {(existingServices || []).map((service) => (
                  <div
                    key={service.id || `existing_${Math.random()}`}
                    className="flex items-center justify-between p-3 bg-green-50 border border-green-200 rounded-lg"
                  >
                    <div className="flex items-center">
                      <CheckCircle className="h-5 w-5 text-green-500 mr-3" />
                      <div className="flex-1">
                        <div className="flex items-center">
                          <span className="font-medium text-gray-900">{service.name}</span>
                          <span className="ml-2 text-sm text-gray-500">
                            ({service.type === 'predefined' ? 'Predefined' : 'Custom'})
                          </span>
                        </div>
                        {service.description && (
                          <p className="text-sm text-gray-600 mt-1" style={{ 
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden'
                          }}>
                            {service.description}
                          </p>
                        )}
                        {service.price && (
                          <p className="text-sm font-medium text-green-600 mt-1">
                            {service.price.display}
                          </p>
                        )}
                      </div>
                    </div>
                    {isManagingServices && (
                      <div className="flex space-x-2">
                        <button
                          onClick={() => handleEditService(service)}
                          className="text-blue-600 hover:text-blue-800 text-sm font-medium"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => removeServiceFromLocation(service.id)}
                          className="text-red-600 hover:text-red-800 text-sm font-medium"
                        >
                          Remove
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Available Services */}
          {selectedCategory && (
            <div className="mb-6">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-md font-medium text-gray-900">Predefined Services You Can Add</h4>
                <span className="text-sm text-gray-500 bg-blue-100 px-2 py-1 rounded-full">
                  {filteredServices.length} available
                </span>
              </div>
              <p className="text-sm text-gray-600 mb-4">
                These are Google's predefined services for your business category. Click "Add Service" to add them to your Google Business Profile.
              </p>
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
              {(filteredServices || []).map((service) => {
                const isAlreadyAdded = (existingServices || []).some(existing => existing.serviceTypeId === service.serviceTypeId);
                return (
                  <div
                    key={service.id || `filtered_${Math.random()}`}
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
                      <div className="flex items-center space-x-2">
                        {isManagingServices && (
                          <button
                            onClick={() => addServiceToLocation(service)}
                            disabled={isAlreadyAdded}
                            className={`px-3 py-1 text-sm font-medium rounded-md ${
                              isAlreadyAdded
                                ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                                : 'bg-blue-600 text-white hover:bg-blue-700'
                            }`}
                          >
                            {isAlreadyAdded ? 'Added' : 'Add Service'}
                          </button>
                        )}
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
                              {isManagingServices && !isAlreadyAdded && (
                                <button 
                                  onClick={() => addServiceToLocation(service)}
                                  className="w-full px-3 py-2 bg-primary-600 text-white text-sm rounded-md hover:bg-primary-700 transition-colors"
                                >
                                  Add to Business Profile
                                </button>
                              )}
                              <button className="w-full px-3 py-2 border border-gray-300 text-gray-700 text-sm rounded-md hover:bg-gray-50 transition-colors">
                                View Details
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
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

      {/* Add Service Modal */}
      {showAddServiceModal && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-96 shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">
                  Add Service
                </h3>
                <button
                  onClick={() => setShowAddServiceModal(false)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Business Category
                </label>
                <div className="text-sm text-gray-600 bg-gray-50 p-2 rounded">
                  {selectedCategory || 'House cleaning service'} (Primary category)
                </div>
              </div>

              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Add services you offer and get discovered by customers
                </label>
                <p className="text-sm text-gray-500 mb-3">
                  Don't see a service you offer? Create your own and add all the available for the category services to dropdown
                </p>
              </div>

              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Choose from Available Services ({filteredServices?.length || 0} available)
                </label>
                <select
                  value={selectedPredefinedService}
                  onChange={(e) => {
                    setSelectedPredefinedService(e.target.value);
                    if (e.target.value) {
                      setNewServiceName('');
                      setNewServiceDescription('');
                    }
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Select a predefined service...</option>
                  {(filteredServices || []).map((service) => (
                    <option key={service.id} value={service.id}>
                      {service.name}
                    </option>
                  ))}
                </select>
                {filteredServices?.length === 0 && (
                  <p className="text-sm text-gray-500 mt-1">
                    No predefined services available. Create a custom service instead.
                  </p>
                )}
              </div>

              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Or Create Custom Service
                </label>
                <input
                  type="text"
                  value={newServiceName}
                  onChange={(e) => {
                    setNewServiceName(e.target.value);
                    if (e.target.value) {
                      setSelectedPredefinedService('');
                    }
                  }}
                  placeholder="Enter service name..."
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Service Description (Optional)
                </label>
                <textarea
                  value={newServiceDescription}
                  onChange={(e) => setNewServiceDescription(e.target.value)}
                  placeholder="Describe what this service includes..."
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  maxLength={300}
                />
                <p className="text-xs text-gray-500 mt-1">
                  {newServiceDescription.length}/300 characters
                </p>
              </div>

              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Service Price (Optional)
                </label>
                <div className="flex space-x-2">
                  <select
                    value={newServiceCurrency}
                    onChange={(e) => setNewServiceCurrency(e.target.value)}
                    className="px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="USD">USD</option>
                    <option value="EUR">EUR</option>
                    <option value="GBP">GBP</option>
                    <option value="CAD">CAD</option>
                    <option value="AUD">AUD</option>
                  </select>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={newServicePrice}
                    onChange={(e) => setNewServicePrice(e.target.value)}
                    placeholder="0.00"
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  Leave empty for no price
                </p>
              </div>

              <div className="flex justify-end space-x-3">
                <button
                  onClick={() => setShowAddServiceModal(false)}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 border border-gray-300 rounded-md hover:bg-gray-200 focus:outline-none focus:ring-2 focus:ring-gray-500"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAddService}
                  disabled={!selectedPredefinedService && !newServiceName.trim()}
                  className="px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Add Service
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Edit Service Modal */}
      {showEditServiceModal && editingService && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-96 shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">
                  Edit Service
                </h3>
                <button
                  onClick={() => setShowEditServiceModal(false)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Service Name
                </label>
                <input
                  type="text"
                  value={editServiceName}
                  onChange={(e) => setEditServiceName(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  maxLength={120}
                />
                <p className="text-xs text-gray-500 mt-1">
                  {editServiceName.length}/120 characters
                </p>
              </div>

              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Service Description
                </label>
                <textarea
                  value={editServiceDescription}
                  onChange={(e) => setEditServiceDescription(e.target.value)}
                  placeholder="Describe what this service includes..."
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  maxLength={300}
                />
                <p className="text-xs text-gray-500 mt-1">
                  {editServiceDescription.length}/300 characters
                </p>
              </div>

              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Service Price
                </label>
                <div className="flex space-x-2">
                  <select
                    value={editServiceCurrency}
                    onChange={(e) => setEditServiceCurrency(e.target.value)}
                    className="px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="USD">USD</option>
                    <option value="EUR">EUR</option>
                    <option value="GBP">GBP</option>
                    <option value="CAD">CAD</option>
                    <option value="AUD">AUD</option>
                  </select>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={editServicePrice}
                    onChange={(e) => setEditServicePrice(e.target.value)}
                    placeholder="0.00"
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  Leave empty for no price
                </p>
              </div>

              <div className="flex justify-end space-x-3">
                <button
                  onClick={() => setShowEditServiceModal(false)}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 border border-gray-300 rounded-md hover:bg-gray-200 focus:outline-none focus:ring-2 focus:ring-gray-500"
                >
                  Cancel
                </button>
                <button
                  onClick={handleUpdateService}
                  disabled={isLoading}
                  className="px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isLoading ? 'Updating...' : 'Update Service'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Services;
