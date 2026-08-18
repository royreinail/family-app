// The one shared data-fetching layer (frontend guardrail 3). Components
// never call fetch() directly — they import functions from here, so the API
// shape only has to be understood in one place.

async function request(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(message);
  }
  if (res.status === 204) return null;
  return res.json();
}

const json = (body) => JSON.stringify(body);

// -- auth / session --------------------------------------------------------
export function signInWithGoogleUrl() {
  return '/auth/google';
}
export const getSession = () => request('/auth/session');
export const logout = () => request('/auth/logout', { method: 'POST' });

// -- family -----------------------------------------------------------------
export const getFamily = () => request('/api/family');
export const getPalette = () => request('/api/family/palette');
export const setTimezone = (timezone) => request('/api/family/timezone', { method: 'PUT', body: json({ timezone }) });
export const setPin = (pin) => request('/api/family/pin', { method: 'POST', body: json({ pin }) });
export const verifyPin = (pin) => request('/api/family/pin/verify', { method: 'POST', body: json({ pin }) });
export const forgotPin = () => request('/api/family/pin/forgot', { method: 'POST' });

// -- family members -----------------------------------------------------------
export const getFamilyMembers = () => request('/api/family-members');
export const createFamilyMember = (member) => request('/api/family-members', { method: 'POST', body: json(member) });
export const updateFamilyMember = (id, patch) => request(`/api/family-members/${id}`, { method: 'PUT', body: json(patch) });
export const deleteFamilyMember = (id) => request(`/api/family-members/${id}`, { method: 'DELETE' });

// -- WhatsApp bot -------------------------------------------------------------
export const getBotConfig = () => request('/api/bot-config');
export const confirmBotConfig = (phoneNumber) =>
  request('/api/bot-config/confirm', { method: 'POST', body: json({ phoneNumber }) });

// -- kid dashboard ------------------------------------------------------------
export const getTomorrow = () => request('/api/dashboard/tomorrow');

// -- calendar selection (backlog 2.1) -----------------------------------------
export const getCalendarList = () => request('/api/calendar/list');
export const setSelectedCalendar = (calendarId) =>
  request('/api/calendar/selected', { method: 'PUT', body: json({ calendarId }) });
