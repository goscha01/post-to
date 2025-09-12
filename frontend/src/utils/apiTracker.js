// Global API call tracker for debugging
class APITracker {
  constructor() {
    this.calls = [];
    this.startTime = Date.now();
  }

  logCall(url, method = 'GET', component = 'Unknown') {
    const timestamp = Date.now() - this.startTime;
    const call = {
      timestamp,
      url,
      method,
      component,
      time: new Date().toLocaleTimeString()
    };
    
    this.calls.push(call);
    
    console.log(`🌐 [API CALL #${this.calls.length}] ${method} ${url} (from ${component}) at ${call.time}`);
    
    // Keep only last 50 calls to prevent memory issues
    if (this.calls.length > 50) {
      this.calls = this.calls.slice(-50);
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
}

// Export singleton instance
export default new APITracker();
