import '@alfalab/core-components/vars/index.css';
import '@fontsource/onest/cyrillic-400.css';
import '@fontsource/onest/cyrillic-500.css';
import '@fontsource/onest/cyrillic-700.css';
import '@fontsource/onest/latin-400.css';
import '@fontsource/onest/latin-500.css';
import '@fontsource/onest/latin-700.css';
import './styles/global.css';

import { CoreConfigContext } from '@alfalab/core-components-config';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { App } from './App';
import { AuthProvider } from './auth/AuthContext';

// Полоса «демо-версия» — только в сборке без сервера (VITE_DEMO=1, как DEMO_MODE в api/client.ts).
// Условие на import.meta.env, а не на константу из другого модуля: так сборщик вырезает импорт целиком.
const DemoNotice = import.meta.env.VITE_DEMO === '1' ? lazy(() => import('./demo/DemoNotice')) : null;

const queryClient = new QueryClient({
    defaultOptions: {
        queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5_000 },
    },
});

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <CoreConfigContext.Provider value={{ breakpoint: 1024, client: 'desktop' }}>
            <QueryClientProvider client={queryClient}>
                <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
                    {DemoNotice && (
                        <Suspense fallback={null}>
                            <DemoNotice />
                        </Suspense>
                    )}
                    <AuthProvider>
                        <App />
                    </AuthProvider>
                </BrowserRouter>
            </QueryClientProvider>
        </CoreConfigContext.Provider>
    </StrictMode>,
);
