import { useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { api, getToken, setToken, setUnauthorizedHandler } from '../api/client';
import type { User } from '../api/types';

interface AuthState {
    user: User | null;
    loading: boolean;
    login: (login: string, password: string) => Promise<User>;
    logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
    const queryClient = useQueryClient();
    const [user, setUser] = useState<User | null>(null);
    const [loading, setLoading] = useState(Boolean(getToken()));

    const logout = useCallback(() => {
        setToken(null);
        setUser(null);
        queryClient.clear();
    }, [queryClient]);

    useEffect(() => {
        setUnauthorizedHandler(logout);
        if (!getToken()) return;
        api<User>('/api/me')
            .then(setUser)
            .catch(() => setToken(null))
            .finally(() => setLoading(false));
    }, [logout]);

    const login = useCallback(
        async (loginName: string, password: string) => {
            const result = await api<{ token: string; user: User }>('/api/auth/login', {
                method: 'POST',
                body: { login: loginName, password },
            });
            queryClient.clear();
            setToken(result.token);
            setUser(result.user);
            return result.user;
        },
        [queryClient],
    );

    const value = useMemo(() => ({ user, loading, login, logout }), [user, loading, login, logout]);
    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
    const context = useContext(AuthContext);
    if (!context) throw new Error('useAuth вне AuthProvider');
    return context;
}

export const isBankRole = (user: User | null) => user?.role === 'UNDERWRITER' || user?.role === 'ADMIN';
