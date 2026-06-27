import { useState, useEffect } from "react";
import { api, UnauthorizedError } from "../api.js";

export function useAuth() {
  // null = still checking session via /api/auth/me
  // true = authenticated (cookie valid or auth disabled)
  // false = not authenticated, show login
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);

  useEffect(() => {
    api.me()
      .then(() => setLoggedIn(true))
      .catch((err) => {
        // 401 = valid auth-enabled server, not logged in
        // anything else (network, 5xx) = fail safe to login page
        setLoggedIn(err instanceof UnauthorizedError ? false : false);
      });
  }, []);

  function login() {
    setLoggedIn(true);
  }

  async function logout() {
    try {
      await api.logout();
    } catch {
      // Best-effort; clear local state regardless
    }
    setLoggedIn(false);
  }

  return { loggedIn, login, logout };
}
