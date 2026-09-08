import React, { useEffect, useState } from "react";

export default function LoginGate({ children }) {
  const [checking, setChecking] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [password, setPassword] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    checkSession();
  }, []);

  async function checkSession() {
    try {
      const response = await fetch("/api/session", {
        method: "GET",
        credentials: "include",
      });

      const data = await response.json();

      setAuthenticated(Boolean(data.authenticated));
    } catch (err) {
      console.error("Session check failed:", err);
      setAuthenticated(false);
    } finally {
      setChecking(false);
    }
  }

  async function handleLogin(event) {
    event.preventDefault();

    if (!password) return;

    setLoggingIn(true);
    setError("");

    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({
          password,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Inloggningen misslyckades");
      }

      setAuthenticated(true);
      setPassword("");
    } catch (err) {
      setError(err.message || "Fel lösenord");
    } finally {
      setLoggingIn(false);
    }
  }

  if (checking) {
    return (
      <div className="min-h-screen bg-black text-cyan-400 flex items-center justify-center font-mono">
        KONTROLLERAR SESSION...
      </div>
    );
  }

  if (authenticated) {
    return children;
  }

  return (
    <div className="min-h-screen bg-black text-cyan-400 flex items-center justify-center p-6 font-mono">
      <div className="w-full max-w-md border border-cyan-500 p-6">
        <div className="text-xs tracking-widest text-orange-500 mb-2">
          SECURE ACCESS // v1.0
        </div>

        <h1 className="text-2xl font-bold mb-8">
          SANNOLIKHETSTERMINAL
        </h1>

        <form onSubmit={handleLogin}>
          <label className="block text-xs tracking-widest mb-2">
            LÖSENORD
          </label>

          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            className="w-full bg-black border border-cyan-600 px-4 py-3 outline-none text-cyan-300 mb-4"
            placeholder="••••••••••••"
          />

          {error && (
            <div className="text-red-500 text-sm mb-4">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loggingIn || !password}
            className="w-full border border-cyan-500 py-3 disabled:opacity-40"
          >
            {loggingIn ? "LOGGAR IN..." : "LOGGA IN >"}
          </button>
        </form>
      </div>
    </div>
  );
}
