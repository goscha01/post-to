// Global API call tracker for debugging
class APITracker {
  constructor() {
    this.calls = [];
    this.startTime = Date.now();
    this.interceptorsSetup = false;
  }

  logCall(url, method = 'GET', component = 'Unknown', requestData = null, responseData = null) {
    const timestamp = Date.now() - this.startTime;
    const call = {
      timestamp,
      url,
      method,
      component,
      time: new Date().toLocaleTimeString(),
      requestData: requestData ? JSON.stringify(requestData).substring(0, 200) : null,
      responseData: responseData ? JSON.stringify(responseData).substring(0, 200) : null
    };

    this.calls.push(call);

    // Simple API call log
    console.log(`🌐 ${method} ${url} (${component})`);

    // Keep only last 100 calls to prevent memory issues
    if (this.calls.length > 100) {
      this.calls = this.calls.slice(-100);
    }
  }

  getStats() {
    const callsByComponent = {};
    const callsByUrl = {};
    
    this.calls.forEach(call => {
      callsByComponent[call.component] = (callsByComponent[call.component] || 0) + 1;
      callsByUrl[call.url] = (callsByUrl[call.url] || 0) + 1;
    });

    return {
      totalCalls: this.calls.length,
      callsByComponent,
      callsByUrl,
      recentCalls: this.calls.slice(-10)
    };
  }

  printStats() {
    const stats = this.getStats();
    console.log('📊 API Call Statistics:', stats);
    return stats;
  }

  clear() {
    this.calls = [];
    this.startTime = Date.now();
    console.log('🗑️ API call tracker cleared');
  }

  // Setup axios interceptors to automatically log all API calls
  setupAxiosInterceptors(axiosInstance) {
    if (this.interceptorsSetup) return;

    try {
      const axios = axiosInstance;
      if (!axios) {
        console.warn('⚠️ Axios instance not provided for interceptors');
        return;
      }

      // Request interceptor
      axios.interceptors.request.use(
        (config) => {
          const component = config.component || 'axios-interceptor';
          this.logCall(config.url, config.method?.toUpperCase(), component, config.data);
          return config;
        },
        (error) => {
          console.error('🔥 API Request Error:', error);
          return Promise.reject(error);
        }
      );

      // Response interceptor
      axios.interceptors.response.use(
        (response) => {
          // Log successful response
          const call = this.calls[this.calls.length - 1];
          if (call && call.url === response.config.url) {
            call.responseData = response.data ? JSON.stringify(response.data).substring(0, 200) : null;
            call.status = response.status;
            console.log(`✅ Response [${response.status}]:`, response.data);
          }
          return response;
        },
        (error) => {
          // Log error response
          const call = this.calls[this.calls.length - 1];
          if (call && error.config && call.url === error.config.url) {
            call.error = error.message;
            call.status = error.response?.status || 'Network Error';
            console.error(`❌ Error Response [${call.status}]:`, error.message);
          }
          return Promise.reject(error);
        }
      );

      this.interceptorsSetup = true;
      console.log('🔧 Axios interceptors setup for API logging');
    } catch (error) {
      console.warn('⚠️ Could not setup axios interceptors:', error.message);
    }
  }

  // Setup fetch interceptor for non-axios requests
  setupFetchInterceptor() {
    if (typeof window === 'undefined') return;

    const originalFetch = window.fetch;
    const self = this;

    window.fetch = function(...args) {
      const [url, options = {}] = args;
      const method = options.method || 'GET';
      const component = 'fetch';

      self.logCall(url, method, component, options.body);

      return originalFetch.apply(this, args);
    };
  }
}

// Export singleton instance
const apiTracker = new APITracker();

// Auto-setup disabled to prevent verbose logging

export default apiTracker;
