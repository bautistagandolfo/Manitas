import { createBrowserRouter, Navigate } from 'react-router-dom';
import { LoginPage } from './features/auth/LoginPage';
import { RequireAuth } from './features/auth/RequireAuth';
import { RequireOwner } from './features/auth/RequireOwner';
import { AppLayout } from './layouts/AppLayout';
import { CatalogPage } from './features/catalog/CatalogPage';
import { NewProductPage } from './features/catalog/NewProductPage';
import { ProductDetailPage } from './features/catalog/ProductDetailPage';
import { VariantGridPage } from './features/catalog/VariantGridPage';
import { NewVariantPage } from './features/catalog/NewVariantPage';
import { CashRegisterPage } from './features/cash-registers/CashRegisterPage';
import { SalePage } from './features/sales/SalePage';
import { CobroPage } from './features/sales/CobroPage';
import { DevolucionPage } from './features/returns/DevolucionPage';
import { GastosPage } from './features/expenses/GastosPage';
import { ResultadosPage } from './features/expenses/ResultadosPage';
import { SettingsPage } from './features/settings/SettingsPage';

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { path: '/', element: <Navigate to="/catalogo" replace /> },
          { path: '/venta', element: <SalePage /> },
          { path: '/venta/cobro', element: <CobroPage /> },
          { path: '/devoluciones', element: <DevolucionPage /> },
          { path: '/caja', element: <CashRegisterPage /> },
          { path: '/catalogo', element: <CatalogPage /> },
          { path: '/catalogo/productos/nuevo', element: <NewProductPage /> },
          {
            path: '/catalogo/productos/:productId',
            element: <ProductDetailPage />,
          },
          {
            element: <RequireOwner />,
            children: [
              {
                path: '/catalogo/productos/:productId/grilla',
                element: <VariantGridPage />,
              },
              {
                path: '/catalogo/productos/:productId/variantes/nueva',
                element: <NewVariantPage />,
              },
              // T6.8, RN-2/RN-11: registrar/ver gastos y consultar
              // resultados es tan restringido como el módulo de
              // resultados en sí (BLUEPRINT §5.1) — un gasto revela
              // montos contra categorías sensibles ("Sueldos").
              { path: '/gastos', element: <GastosPage /> },
              { path: '/resultados', element: <ResultadosPage /> },
              // T6.9, BLUEPRINT §3.8: "Solo OWNER los modifica".
              { path: '/configuracion', element: <SettingsPage /> },
            ],
          },
        ],
      },
    ],
  },
]);
