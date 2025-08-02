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

// Redirect to login on auth errors
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error?.response?.status;
    const detail = error?.response?.data?.detail;
    if (status === 401 || detail === 'Merchant login required') {
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

// expose axios utility helpers on the instance
api.isCancel = axios.isCancel;

export default api;
