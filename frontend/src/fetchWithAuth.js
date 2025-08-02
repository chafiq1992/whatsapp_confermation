export default async function fetchWithAuth(url, options = {}) {
  const response = await fetch(url, options);
  if (response.status === 401) {
    window.location.href = '/login';
    return response;
  }
  try {
    const data = await response.clone().json();
    if (data?.detail === 'Merchant login required') {
      window.location.href = '/login';
    }
  } catch (e) {
    // ignore JSON parse errors
  }
  return response;
}
