import { Navigate, Outlet, Route, Routes } from 'react-router-dom';

import { useLiveUpdates } from './api/hooks';
import { isBankRole, useAuth } from './auth/AuthContext';
import { AppHeader } from './components/AppHeader';
import { Theme } from './components/Theme';
import { Loader } from './components/ui';
import { AuditPage } from './pages/bank/AuditPage';
import { DossierPage } from './pages/bank/DossierPage';
import { MetricsPage } from './pages/bank/MetricsPage';
import { PipelinePage } from './pages/bank/PipelinePage';
import { QueuePage } from './pages/bank/QueuePage';
import { ApplicationPage } from './pages/client/ApplicationPage';
import { DashboardPage } from './pages/client/DashboardPage';
import { NewApplicationPage } from './pages/client/NewApplicationPage';
import { LoginPage } from './pages/LoginPage';

function ClientLayout() {
    const { user, loading } = useAuth();
    useLiveUpdates(user?.role === 'CLIENT');
    if (loading) return <Loader />;
    if (!user) return <Navigate to='/login' replace={true} />;
    if (user.role !== 'CLIENT') return <Navigate to='/bank' replace={true} />;
    return (
        <>
            <Theme name='corp' />
            <AppHeader
                home='/client'
                nav={[
                    { to: '/client', label: 'Главная', end: true },
                    { to: '/client/new', label: 'Получить кредит' },
                ]}
            />
            <Outlet />
        </>
    );
}

function BankLayout() {
    const { user, loading } = useAuth();
    useLiveUpdates(isBankRole(user));
    if (loading) return <Loader />;
    if (!user) return <Navigate to='/login' replace={true} />;
    if (!isBankRole(user)) return <Navigate to='/client' replace={true} />;
    return (
        <>
            <Theme name='intranet' />
            <AppHeader
                bank={true}
                home='/bank'
                nav={[
                    { to: '/bank', label: 'Очередь заявок', end: true },
                    { to: '/bank/metrics', label: 'Показатели' },
                    { to: '/bank/pipeline', label: 'Конвейер и сбои' },
                    { to: '/bank/audit', label: 'Журнал действий' },
                ]}
            />
            <Outlet />
        </>
    );
}

function Home() {
    const { user, loading } = useAuth();
    if (loading) return <Loader />;
    if (!user) return <Navigate to='/login' replace={true} />;
    return <Navigate to={user.role === 'CLIENT' ? '/client' : '/bank'} replace={true} />;
}

export function App() {
    return (
        <Routes>
            <Route
                path='/login'
                element={
                    <>
                        <Theme name='corp' />
                        <LoginPage />
                    </>
                }
            />
            <Route path='/client' element={<ClientLayout />}>
                <Route index={true} element={<DashboardPage />} />
                <Route path='new' element={<NewApplicationPage />} />
                <Route path='applications/:id' element={<ApplicationPage />} />
            </Route>
            <Route path='/bank' element={<BankLayout />}>
                <Route index={true} element={<QueuePage />} />
                <Route path='applications/:id' element={<DossierPage />} />
                <Route path='metrics' element={<MetricsPage />} />
                <Route path='pipeline' element={<PipelinePage />} />
                <Route path='audit' element={<AuditPage />} />
            </Route>
            <Route path='*' element={<Home />} />
        </Routes>
    );
}
