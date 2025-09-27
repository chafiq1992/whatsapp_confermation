import axios from 'axios';

// Use .env, fallback to localhost for dev
const baseUrl =
  process.env.REACT_APP_API_BASE ||
  process.env.REACT_APP_API_URL || // Accept either for portability
  process.env.REACT_APP_BACKEND_URL ||
  "";

const api = axios.create({
  baseURL: baseUrl
});

// Avoid stale caches for GETs and attach auth token
api.interceptors.request.use((config) => {
  try {
    // Attach Authorization header if token exists
    try {
      const token = localStorage.getItem('agent_token');
      if (token) {
        config.headers = {
          ...(config.headers || {}),
          Authorization: `Bearer ${token}`,
        };
      }
    } catch {}

    if ((config.method || 'get').toLowerCase() === 'get') {
      // Add cache-buster param
      const ts = Date.now();
      if (typeof config.url === 'string') {
        if (config.url.includes('?')) config.url += `&__ts=${ts}`; else config.url += `?__ts=${ts}`;
      }
      // And explicit no-cache headers
      config.headers = {
        ...(config.headers || {}),
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      };
    }
  } catch {}
  return config;
});

// Do not redirect on auth errors; allow app to continue (temporary auth disabled mode)
api.interceptors.response.use(
  (response) => response,
  (error) => {
    return Promise.reject(error);
  }
);

// expose axios utility helpers on the instance
api.isCancel = axios.isCancel;

export default api;
