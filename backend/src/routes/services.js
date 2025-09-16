const express = require('express');
const { body, validationResult } = require('express-validator');
const authMiddleware = require('../middleware/authMiddleware');
const requireBusinessAuth = require('../middleware/businessAuth');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const router = express.Router();

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Apply both middlewares to all service routes
router.use(authMiddleware); // First authenticate the user
router.use(requireBusinessAuth); // Then check business authentication

// Helper function to get cached services for a location
async function getCachedServices(locationId, userId) {
  try {
    console.log(`🗃️ Looking for cached services for location: ${locationId}, user: ${userId}`);

    // Since the services table doesn't have user_id or location_id columns,
    // we'll return an empty array for now. The services are fetched from GMB API
    // and the predefined services come from the categories API.
    console.log(`📦 No cached services table structure - returning empty array`);
    return [];
  } catch (error) {
    console.error('Error in getCachedServices:', error);
    return [];
  }
}

// Helper function to save service to database
const saveServiceToDatabase = async (userId, serviceData) => {
  try {
    const insertData = {
      business_profile_id: serviceData.businessProfileId || null,
      gmb_service_id: serviceData.gmbServiceId || serviceData.serviceId || null,
      service_name: serviceData.serviceName,
      price_range: serviceData.priceRange || null,
      description: serviceData.description || serviceData.serviceDescription || null,
      is_active: serviceData.isActive !== undefined ? serviceData.isActive : true
    };

    const { data, error } = await supabase
      .from('services')
      .insert(insertData)
      .select()
      .single();

    if (error) {
      console.error('Error saving service to database:', error);
      return null;
    }

    return data;
  } catch (error) {
    console.error('Error in saveServiceToDatabase:', error);
    return null;
  }
};

// Helper function to save existing services from API to database
const saveExistingServicesToDatabase = async (userId, services, platform = 'google') => {
  try {
    const savedServices = [];
    
    for (const service of services) {
      // Extract service information from different service item types
      let serviceInfo = {};
      
      if (service.structuredServiceItem) {
        // Handle structured service items
        serviceInfo = {
          gmbServiceId: service.structuredServiceItem.serviceTypeId || `structured-${Date.now()}-${Math.random()}`,
          serviceName: service.structuredServiceItem.displayName || 'Structured Service',
          description: service.structuredServiceItem.description || 'Structured service from GMB',
          priceRange: service.structuredServiceItem.priceRange || null,
          isActive: true
        };
      } else if (service.freeFormServiceItem) {
        // Handle free-form service items
        const category = service.freeFormServiceItem.category || '';
        const label = service.freeFormServiceItem.label || '';
        
        // Check if label is actually a JSON string
        let serviceName = 'Free Form Service';
        let description = `Free form service: ${category}`;
        
        if (typeof label === 'object' && label !== null) {
          // Label is already an object, extract directly
          serviceName = label.displayName || label.name || 'Free Form Service';
          description = label.description || `Free form service: ${category}`;
        } else if (typeof label === 'string' && label.length > 0) {
          // Try to parse as JSON first
          if (label.startsWith('{') && label.endsWith('}')) {
            try {
              const parsed = JSON.parse(label);
              serviceName = parsed.displayName || parsed.name || 'Free Form Service';
              description = parsed.description || `Free form service: ${category}`;
            } catch (e) {
              // Fall back to regex extraction
              const nameMatch = label.match(/"displayName":"([^"]+)"/);
              const descMatch = label.match(/"description":"([^"]+)"/);
              serviceName = nameMatch ? nameMatch[1] : 'Free Form Service';
              description = descMatch ? descMatch[1] : `Free form service: ${category}`;
            }
          } else {
            // Use regex extraction for non-JSON strings
            const nameMatch = label.match(/"displayName":"([^"]+)"/);
            const descMatch = label.match(/"description":"([^"]+)"/);
            serviceName = nameMatch ? nameMatch[1] : 'Free Form Service';
            description = descMatch ? descMatch[1] : `Free form service: ${category}`;
          }
        } else if (category) {
          // Extract service name from category path
          const categoryParts = category.split('/');
          const lastPart = categoryParts[categoryParts.length - 1];
          serviceName = lastPart.replace(/gcid:|_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
          description = `Free form service: ${category}`;
        }
        
        serviceInfo = {
          gmbServiceId: `freeform-${Date.now()}-${Math.random()}`,
          serviceName: serviceName || 'Free Form Service',
          description: description,
          priceRange: null,
          isActive: true
        };
      } else {
        // Handle other service types
        serviceInfo = {
          gmbServiceId: service.serviceId || service.id || `service-${Date.now()}-${Math.random()}`,
          serviceName: service.serviceName || service.displayName || service.name || 'Unknown Service',
          description: service.description || service.serviceDescription || 'Service from GMB',
          priceRange: service.priceRange || service.price || null,
          isActive: service.isActive !== undefined ? service.isActive : true
        };
      }

      // Check if service already exists in database
      const { data: existingService } = await supabase
        .from('services')
        .select('id')
        .eq('gmb_service_id', serviceInfo.gmbServiceId)
        .single();

      if (existingService) {
        continue;
      }

      // Save to database
      const savedService = await saveServiceToDatabase(userId, serviceInfo);
      if (savedService) {
        savedServices.push(savedService);
      }
    }

    return savedServices;
  } catch (error) {
    console.error('Error saving existing services to database:', error);
    return [];
  }
};

// Get predefined services by category name
router.get('/categories', async (req, res) => {
  try {
    const { regionCode = 'US', languageCode = 'en', filter, view = 'FULL' } = req.query;
    
    const gmbClient = google.mybusinessbusinessinformation({
      version: 'v1',
      auth: req.businessOAuth2Client
    });
    
    const params = {
      regionCode,
      languageCode,
      view
    };
    
    if (filter) {
      params.filter = filter;
    }
    
    const response = await gmbClient.categories.list(params);
    
    res.json({
      success: true,
      categories: response.data.categories || []
    });
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch categories',
      details: error.message
    });
  }
});

// Get predefined services by category ID
router.get('/categories/batchGet', async (req, res) => {
  try {
    const { regionCode = 'US', languageCode = 'en', names, view = 'FULL' } = req.query;
    
    if (!names) {
      return res.status(400).json({
        success: false,
        error: 'Category names are required'
      });
    }
    
    const gmbClient = google.mybusinessbusinessinformation({
      version: 'v1',
      auth: req.businessOAuth2Client
    });
    
    // Convert category IDs to proper format (categories/gcid:category_id)
    const formattedNames = Array.isArray(names) ? names : [names];
    const properNames = formattedNames.map(name => {
      if (name.startsWith('gcid:')) {
        return `categories/${name}`;
      } else if (name.startsWith('categories/')) {
        return name;
      } else {
        return `categories/gcid:${name}`;
      }
    });
    
    const response = await gmbClient.categories.batchGet({
      regionCode,
      languageCode,
      names: properNames,
      view
    });
    
    if (response.data.categories && response.data.categories.length > 0) {
      const category = response.data.categories[0];
      
      if (category.serviceTypes && category.serviceTypes.length > 0) {
        // Check if service types have actual data
        const hasValidServices = category.serviceTypes.some(service => 
          service.displayName || service.serviceTypeId
        );
        
        if (!hasValidServices) {
          // Provide fallback services for house cleaning (as free-form services)
          const fallbackServices = [
            { displayName: 'Deep Cleaning', description: 'Comprehensive deep cleaning service' },
            { displayName: 'Regular Cleaning', description: 'Standard house cleaning service' },
            { displayName: 'Move-in/Move-out Cleaning', description: 'Cleaning for moving situations' },
            { displayName: 'Office Cleaning', description: 'Commercial office cleaning' },
            { displayName: 'Post-Construction Cleaning', description: 'Cleaning after construction work' },
            { displayName: 'Upholstery Cleaning', description: 'Furniture and upholstery cleaning' },
            { displayName: 'Mattress Cleaning', description: 'Specialized mattress cleaning' },
            { displayName: 'Window Cleaning', description: 'Interior and exterior window cleaning' }
          ];
          
          category.serviceTypes = fallbackServices;
        }
      }
    }
    
    res.json({
      success: true,
      categories: response.data.categories || []
    });
  } catch (error) {
    console.error('Error fetching categories by ID:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch categories by ID',
      details: error.message
    });
  }
});

// Get existing services for a location
router.get('/locations/:locationId/services', async (req, res) => {
  try {
    const { locationId } = req.params;
    const userId = req.user?.userId;
    const { cached_only } = req.query;

    // If cached_only=true, return only cached data
    if (cached_only === 'true') {
      const cachedServices = await getCachedServices(locationId, userId);
      return res.json({
        success: true,
        serviceItems: cachedServices,
        cached: true,
        message: `Found ${cachedServices.length} cached services`
      });
    }

    const gmbClient = google.mybusinessbusinessinformation({
      version: 'v1',
      auth: req.businessOAuth2Client
    });

    const response = await gmbClient.locations.get({
      name: `locations/${locationId}`,
      readMask: 'serviceItems'
    });

    // Save services to database
    const savedServices = await saveExistingServicesToDatabase(req.user.userId, response.data.serviceItems || [], 'google');

    res.json({
      success: true,
      serviceItems: response.data.serviceItems || [],
      savedToDatabase: savedServices.length
    });
  } catch (error) {
    console.error('Error fetching location services:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch location services',
      details: error.message
    });
  }
});

// Update services for a location
router.patch('/locations/:locationId/services', [
  body('serviceItems').isArray().withMessage('Service items must be an array')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      errors: errors.array()
    });
  }

  try {
    const { locationId } = req.params;
    const { serviceItems } = req.body;
    
    if (!serviceItems || !Array.isArray(serviceItems)) {
      return res.status(400).json({
        success: false,
        error: 'Service items array is required'
      });
    }
    
    const gmbClient = google.mybusinessbusinessinformation({
      version: 'v1',
      auth: req.businessOAuth2Client
    });
    
    const response = await gmbClient.locations.patch({
      name: `locations/${locationId}`,
      updateMask: 'serviceItems',
      requestBody: {
        serviceItems: serviceItems
      }
    });
    
    res.json({
      success: true,
      location: response.data
    });
  } catch (error) {
    console.error('Error updating location services:', error);
    
    res.status(500).json({
      success: false,
      error: 'Failed to update location services',
      details: error.message,
      googleError: error.response?.data
    });
  }
});

module.exports = router;
