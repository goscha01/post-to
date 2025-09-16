import axios from 'axios';
import apiTracker from './apiTracker';

// Create a configured axios instance
const axiosInstance = axios.create({
  baseURL: 'http://localhost:3001',
  timeout: 10000,
});

// Setup request interceptor for logging
axiosInstance.interceptors.request.use(
  (config) => {
    console.log(`🌐 ${config.method?.toUpperCase()} ${config.url}`);
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

export default axiosInstance;