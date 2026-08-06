import { useCallback, useState } from "react";
import App from "./App";
import LoginScreen from "./LoginScreen";
import { clearAuthSession, getAuthToken } from "./authSession";

export default function AuthGate() {
  const [token, setToken] = useState<string | null>(() => getAuthToken());

  const onLoggedIn = useCallback(() => {
    setToken(getAuthToken());
  }, []);

  const onLogout = useCallback(() => {
    clearAuthSession();
    setToken(null);
  }, []);

  if (!token) {
    return <LoginScreen onLoggedIn={onLoggedIn} />;
  }

  return (
    <div className="qp-app-root h-[100dvh] max-h-[100dvh] w-full overflow-hidden">
      <App onLogout={onLogout} />
    </div>
  );
}
