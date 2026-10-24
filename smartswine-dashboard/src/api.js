export const API_URL = import.meta.env.VITE_AI_API_URL || "http://127.0.0.1:8000";

export async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_URL}${path}`, options);
  const contentType = response.headers.get("content-type") || "";
  const result = contentType.includes("application/json")
    ? await response.json()
    : null;

  if (!response.ok) {
    throw new Error(result?.detail || `Request failed (${response.status}).`);
  }

  return result;
}
